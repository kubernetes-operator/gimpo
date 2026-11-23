import type { FastifyBaseLogger } from 'fastify';
import type { V1CronJob, V1Job } from '@kubernetes/client-node';
import { batchV1, coreV1 } from '../k8s/client';
import { config } from '../config';
import { nextRuns } from '../util/cron';
import { RESULT_MARK, DRILL_MARK, type SnapshotResult, type DrillResult } from '../tools/etcd-tool';

/**
 * etcd 스냅샷·복원 연습 결과 수집.
 * CronJob 이 만든 Job 이 끝나면 파드 로그의 마지막 결과 줄(GIMPO-ETCD-RESULT/DRILL)을 읽어
 * ConfigMap velero/gimpo-etcd 에 이력으로 보관한다(Job 은 7일 뒤 사라져도 이력은 남는다).
 */

export const CRONJOBS = { snapshot: 'gimpo-etcd-snapshot', drill: 'gimpo-etcd-restore-drill' } as const;
export type EtcdJobKind = keyof typeof CRONJOBS;
const LABEL = 'gimpo.io/etcd-job';
const CM = 'gimpo-etcd';
const LIMIT = 120;

export type SnapshotRecord = SnapshotResult & { jobName: string; trigger: 'schedule' | 'manual' };
export type DrillRecord = DrillResult & { jobName: string; trigger: 'schedule' | 'manual' };

interface State {
  snapshots: SnapshotRecord[];
  drills: DrillRecord[];
}

const ns = () => config.veleroNamespace;
const ts = (v: unknown) => (v instanceof Date ? v.toISOString() : v ? String(v) : undefined);

async function readState(): Promise<{ state: State; rv?: string; exists: boolean }> {
  try {
    const cm = await coreV1.readNamespacedConfigMap({ name: CM, namespace: ns() });
    const parse = <T>(s?: string): T[] => {
      try {
        return s ? (JSON.parse(s) as T[]) : [];
      } catch {
        return [];
      }
    };
    return {
      exists: true,
      rv: cm.metadata?.resourceVersion,
      state: { snapshots: parse<SnapshotRecord>(cm.data?.snapshots), drills: parse<DrillRecord>(cm.data?.drills) },
    };
  } catch (e) {
    if ((e as { code?: number }).code === 404) return { exists: false, state: { snapshots: [], drills: [] } };
    throw e;
  }
}

async function writeState(state: State, rv: string | undefined, exists: boolean) {
  const body = {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name: CM,
      namespace: ns(),
      labels: { 'app.kubernetes.io/part-of': 'gimpo-velero-dashboard' },
      ...(rv ? { resourceVersion: rv } : {}),
    },
    data: {
      snapshots: JSON.stringify(state.snapshots.slice(0, LIMIT)),
      drills: JSON.stringify(state.drills.slice(0, LIMIT)),
    },
  };
  if (exists) await coreV1.replaceNamespacedConfigMap({ name: CM, namespace: ns(), body });
  else await coreV1.createNamespacedConfigMap({ namespace: ns(), body });
}

export async function readHistory(): Promise<State> {
  return (await readState()).state;
}

const finished = (j: V1Job) => !j.status?.active && ((j.status?.succeeded ?? 0) > 0 || (j.status?.failed ?? 0) > 0);
const kindOf = (j: V1Job) => j.metadata?.labels?.[LABEL] as EtcdJobKind | undefined;
const triggerOf = (j: V1Job): 'schedule' | 'manual' =>
  j.metadata?.annotations?.['cronjob.kubernetes.io/instantiate'] === 'manual' ? 'manual' : 'schedule';

/** Job 의 파드 로그에서 결과 줄을 찾는다. 없으면 실패 원인을 최대한 모아 실패 기록을 만든다. */
async function resultOf(job: V1Job): Promise<SnapshotResult | DrillResult> {
  const kind = kindOf(job)!;
  const mark = kind === 'snapshot' ? RESULT_MARK : DRILL_MARK;
  const name = job.metadata!.name!;
  const pods = await coreV1.listNamespacedPod({ namespace: ns(), labelSelector: `job-name=${name}` });
  const sorted = pods.items.sort((a, b) =>
    String(ts(b.metadata?.creationTimestamp)).localeCompare(String(ts(a.metadata?.creationTimestamp))),
  );
  let tail = '';
  for (const p of sorted) {
    try {
      const log = String(await coreV1.readNamespacedPodLog({ name: p.metadata!.name!, namespace: ns(), tailLines: 200 }));
      const line = log.split('\n').reverse().find((l) => l.startsWith(mark + ' '));
      if (line) return JSON.parse(line.slice(mark.length + 1));
      tail = tail || log.trim().split('\n').slice(-5).join(' / ');
    } catch {
      /* 로그를 못 읽으면 상태로 판단 */
    }
    const waiting = p.status?.containerStatuses?.[0]?.state?.waiting;
    const terminated = p.status?.containerStatuses?.[0]?.state?.terminated;
    tail = tail || [waiting?.reason, waiting?.message, terminated?.reason, p.status?.message].filter(Boolean).join(': ');
  }
  const cond = job.status?.conditions?.find((c) => c.type === 'Failed');
  const error = [cond?.reason, cond?.message, tail].filter(Boolean).join(' — ') || '결과 없이 종료됨';
  const base = {
    status: 'failed' as const,
    startedAt: ts(job.status?.startTime) ?? ts(job.metadata?.creationTimestamp) ?? new Date().toISOString(),
    finishedAt: ts(job.status?.completionTime) ?? new Date().toISOString(),
    node: sorted[0]?.spec?.nodeName ?? '',
    error,
  };
  return kind === 'snapshot' ? { kind: 'snapshot', ...base } : { kind: 'drill', checks: [], ...base };
}

let busy: Promise<void> | null = null;

/** 끝났지만 아직 기록되지 않은 etcd Job 결과를 이력에 반영한다. */
export function collect(log?: FastifyBaseLogger): Promise<void> {
  if (busy) return busy;
  busy = (async () => {
    try {
      const jobs = await batchV1.listNamespacedJob({ namespace: ns(), labelSelector: LABEL });
      const { state, rv, exists } = await readState();
      const seen = new Set([...state.snapshots.map((r) => r.jobName), ...state.drills.map((r) => r.jobName)]);
      const fresh = jobs.items.filter((j) => finished(j) && kindOf(j) && !seen.has(j.metadata!.name!));
      if (!fresh.length) return;
      for (const j of fresh.sort((a, b) => String(ts(a.metadata?.creationTimestamp)).localeCompare(String(ts(b.metadata?.creationTimestamp))))) {
        const r = await resultOf(j);
        const rec = { ...r, jobName: j.metadata!.name!, trigger: triggerOf(j) };
        if (r.kind === 'snapshot') state.snapshots.unshift(rec as SnapshotRecord);
        else state.drills.unshift(rec as DrillRecord);
        log?.info({ job: rec.jobName, kind: r.kind, status: r.status }, 'etcd 잡 결과 기록');
      }
      state.snapshots.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
      state.drills.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
      await writeState(state, rv, exists);
    } catch (e) {
      log?.warn({ err: e }, 'etcd 잡 결과 수집 실패');
    } finally {
      busy = null;
    }
  })();
  return busy;
}

export function startEtcdCollector(log: FastifyBaseLogger) {
  const timer = setInterval(() => void collect(log), 60_000);
  timer.unref();
  setTimeout(() => void collect(log), 10_000).unref();
}

export interface CronInfo {
  name: string;
  kind: EtcdJobKind;
  installed: boolean;
  schedule?: string;
  timeZone?: string;
  suspend?: boolean;
  lastScheduleTime?: string;
  lastSuccessfulTime?: string;
  nextRuns: string[];
}

export async function cronInfo(): Promise<CronInfo[]> {
  const out: CronInfo[] = [];
  for (const kind of Object.keys(CRONJOBS) as EtcdJobKind[]) {
    const name = CRONJOBS[kind];
    try {
      const cj = await batchV1.readNamespacedCronJob({ name, namespace: ns() });
      const tz = cj.spec?.timeZone;
      const raw = tz ? `CRON_TZ=${tz} ${cj.spec?.schedule}` : String(cj.spec?.schedule);
      out.push({
        name,
        kind,
        installed: true,
        schedule: cj.spec?.schedule,
        timeZone: tz,
        suspend: !!cj.spec?.suspend,
        lastScheduleTime: ts(cj.status?.lastScheduleTime),
        lastSuccessfulTime: ts(cj.status?.lastSuccessfulTime),
        nextRuns: cj.spec?.suspend ? [] : nextRuns(raw, 2),
      });
    } catch (e) {
      if ((e as { code?: number }).code !== 404) throw e;
      out.push({ name, kind, installed: false, nextRuns: [] });
    }
  }
  return out;
}

export async function runningJobs() {
  const jobs = await batchV1.listNamespacedJob({ namespace: ns(), labelSelector: LABEL });
  return jobs.items
    .filter((j) => !finished(j))
    .map((j) => ({
      name: j.metadata!.name!,
      kind: kindOf(j),
      trigger: triggerOf(j),
      startedAt: ts(j.status?.startTime) ?? ts(j.metadata?.creationTimestamp),
    }));
}

/** `kubectl create job --from=cronjob/...` 과 같은 동작. drill 은 대상 스냅샷을 지정할 수 있다. */
export async function triggerJob(kind: EtcdJobKind, snapshotName?: string): Promise<string> {
  const cj: V1CronJob = await batchV1.readNamespacedCronJob({ name: CRONJOBS[kind], namespace: ns() });
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  const name = `${CRONJOBS[kind]}-manual-${stamp}`.slice(0, 63);
  const spec = JSON.parse(JSON.stringify(cj.spec!.jobTemplate.spec));
  if (kind === 'drill' && snapshotName) {
    const c = spec.template.spec.containers[0];
    c.env = [...(c.env ?? []).filter((e: { name: string }) => e.name !== 'SNAPSHOT_NAME'), { name: 'SNAPSHOT_NAME', value: snapshotName }];
  }
  await batchV1.createNamespacedJob({
    namespace: ns(),
    body: {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: {
        name,
        namespace: ns(),
        labels: { ...(cj.spec!.jobTemplate.metadata?.labels ?? {}), [LABEL]: kind },
        annotations: { 'cronjob.kubernetes.io/instantiate': 'manual' },
        ownerReferences: [
          { apiVersion: 'batch/v1', kind: 'CronJob', name: cj.metadata!.name!, uid: cj.metadata!.uid!, controller: false },
        ],
      },
      spec,
    },
  });
  return name;
}
