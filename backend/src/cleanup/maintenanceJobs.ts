import type { FastifyBaseLogger } from 'fastify';
import type { V1Job } from '@kubernetes/client-node';
import { batchV1, coreV1 } from '../k8s/client';
import { velero, PLURALS } from '../k8s/velero';
import { config } from '../config';

/**
 * Velero 저장소 정리(maintenance) 잡 자동 정리.
 *
 * Velero 는 저장소마다 최근 N개(keepLatestMaintenanceJobs) 잡을 남기지만,
 *  - 저장소 기록(BackupRepository)이 삭제되면 그 저장소의 잡은 영원히 정리하지 않고,
 *  - N 을 줄여도 다음 정리 주기(최대 수일)까지 초과분이 남는다.
 * 이 모듈은 1시간마다 아래 잡을 지운다(진행 중인 잡은 절대 건드리지 않음).
 *  1) 주인 없는 잡: 저장소 기록이 없어진 잡 (끝난 지 1시간 이상)
 *  2) 초과 잡: 저장소별로 최신 N개를 넘는 끝난 잡 (N = Velero 설정 값)
 */

const REPO_LABEL = 'velero.io/repo-name';
const MAINT_CM = 'velero-repo-maintenance';
const ORPHAN_GRACE_MS = 60 * 60_000;
const INTERVAL_MS = 60 * 60_000;

export interface CleanupPlan {
  keep: number;
  total: number;
  orphan: string[];
  excess: string[];
}

export interface CleanupResult {
  at: string;
  deleted: number;
  orphan: number;
  excess: number;
  error?: string;
}

let lastResult: CleanupResult | null = null;
export const lastCleanup = () => lastResult;

const ns = () => config.veleroNamespace;
const ts = (v: unknown) => (v instanceof Date ? v.getTime() : v ? new Date(String(v)).getTime() : 0);
const finished = (j: V1Job) => !j.status?.active && ((j.status?.succeeded ?? 0) > 0 || (j.status?.failed ?? 0) > 0);
const finishedAt = (j: V1Job) =>
  ts(j.status?.completionTime) ||
  Math.max(0, ...(j.status?.conditions ?? []).map((c) => ts(c.lastTransitionTime))) ||
  ts(j.metadata?.creationTimestamp);

/** Velero 설정의 keepLatestMaintenanceJobs (읽기 실패 시 Velero 기본값 3) */
async function keepLatest(): Promise<number> {
  try {
    const cm = await coreV1.readNamespacedConfigMap({ name: MAINT_CM, namespace: ns() });
    const g = JSON.parse(cm.data?.global ?? '{}') as { keepLatestMaintenanceJobs?: number };
    const n = Number(g.keepLatestMaintenanceJobs);
    return Number.isInteger(n) && n >= 0 ? n : 3;
  } catch {
    return 3;
  }
}

export async function planCleanup(): Promise<CleanupPlan> {
  const [jobs, repos, keep] = await Promise.all([
    batchV1.listNamespacedJob({ namespace: ns(), labelSelector: REPO_LABEL }),
    velero.list(PLURALS.backupRepositories),
    keepLatest(),
  ]);
  const repoNames = new Set(repos.items.map((r) => r.metadata.name));
  const byRepo = new Map<string, V1Job[]>();
  const orphan: string[] = [];
  for (const j of jobs.items) {
    const repo = j.metadata?.labels?.[REPO_LABEL] ?? '';
    if (!finished(j)) continue;
    if (!repoNames.has(repo)) {
      if (Date.now() - finishedAt(j) > ORPHAN_GRACE_MS) orphan.push(j.metadata!.name!);
      continue;
    }
    byRepo.set(repo, [...(byRepo.get(repo) ?? []), j]);
  }
  const excess: string[] = [];
  for (const list of byRepo.values()) {
    list.sort((a, b) => ts(b.metadata?.creationTimestamp) - ts(a.metadata?.creationTimestamp));
    excess.push(...list.slice(keep).map((j) => j.metadata!.name!));
  }
  return { keep, total: jobs.items.length, orphan, excess };
}

export async function runCleanup(log?: FastifyBaseLogger): Promise<CleanupResult> {
  const at = new Date().toISOString();
  try {
    const plan = await planCleanup();
    let deleted = 0;
    for (const name of [...plan.orphan, ...plan.excess]) {
      try {
        await batchV1.deleteNamespacedJob({ name, namespace: ns(), propagationPolicy: 'Background' });
        deleted++;
      } catch (e) {
        if ((e as { code?: number }).code !== 404) throw e;
      }
    }
    lastResult = { at, deleted, orphan: plan.orphan.length, excess: plan.excess.length };
    if (deleted) log?.info(lastResult, '정리 잡 자동 삭제');
  } catch (e) {
    lastResult = { at, deleted: 0, orphan: 0, excess: 0, error: (e as Error).message };
    log?.error({ err: e }, '정리 잡 자동 삭제 실패');
  }
  return lastResult;
}

export function startMaintenanceJobCleanup(log: FastifyBaseLogger) {
  const first = setTimeout(() => void runCleanup(log), 60_000);
  const timer = setInterval(() => void runCleanup(log), INTERVAL_MS);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
