import { appsV1, batchV1 } from '../k8s/client';
import { velero, PLURALS } from '../k8s/velero';
import { config } from '../config';
import { intervalMs, nextRuns, prevRun } from '../util/cron';
import { store } from '../restoretest/store';
import { decorate } from '../routes/schedules';
import type { Backup, CustomResource, Schedule } from '../types/velero';

/**
 * 백업·복구 상태 점검. 각 항목은 ok / warn / fail 로 판정하고 전체 상태는 가장 나쁜 값.
 * 임계값은 이 클러스터의 실제 장애(멈춘 PVB, 처리 안 된 삭제 요청, 오래 도는 maintenance)를 기준으로 잡았다.
 */

export type Level = 'ok' | 'warn' | 'fail';

export interface Check {
  id: string;
  category: '서버' | '저장소' | '스케줄' | '작업' | '복구 테스트';
  name: string;
  status: Level;
  message: string;
}

export interface ScheduleHealth {
  name: string;
  displayName: string;
  schedule: string;
  paused: boolean;
  storageLocation?: string;
  ttl?: string;
  prevExpected?: string;
  nextRun?: string;
  lastBackup?: {
    name: string;
    phase?: string;
    startedAt?: string;
    completedAt?: string;
    errors?: number;
    warnings?: number;
  };
  lastSuccessAt?: string;
  status: Level;
  message: string;
}

export interface HealthReport {
  overall: Level;
  checkedAt: string;
  counts: Record<Level, number>;
  checks: Check[];
  schedules: ScheduleHealth[];
}

const H = 3600_000;
const rank: Record<Level, number> = { ok: 0, warn: 1, fail: 2 };
const worst = (a: Level, b: Level): Level => (rank[a] >= rank[b] ? a : b);
const ts = (v: unknown): string | undefined =>
  v instanceof Date ? v.toISOString() : typeof v === 'string' ? v : undefined;
const age = (v?: unknown) => {
  const s = ts(v);
  return s ? Date.now() - new Date(s).getTime() : Infinity;
};
const hrs = (ms: number) =>
  ms === Infinity ? '-' : ms < H ? `${Math.round(ms / 60000)}분` : `${(ms / H).toFixed(1)}시간`;
const kst = (ms: number) => new Date(ms).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false });
const ns = () => config.veleroNamespace;

type Status = {
  phase?: string;
  startTimestamp?: string;
  completionTimestamp?: string;
  errors?: number;
  warnings?: number;
  lastValidationTime?: string;
  message?: string;
};
type CR = CustomResource<Record<string, unknown>, Status>;

async function serverChecks(): Promise<Check[]> {
  const out: Check[] = [];
  try {
    const d = await appsV1.readNamespacedDeployment({ name: 'velero', namespace: ns() });
    const ready = d.status?.readyReplicas ?? 0;
    out.push({
      id: 'velero-server',
      category: '서버',
      name: 'Velero 서버',
      status: ready >= 1 ? 'ok' : 'fail',
      message: ready >= 1 ? `Ready ${ready}/${d.spec?.replicas ?? 1}` : 'Ready 파드 없음 — 백업·복구가 동작하지 않음',
    });
  } catch (e) {
    out.push({ id: 'velero-server', category: '서버', name: 'Velero 서버', status: 'fail', message: `조회 실패: ${(e as Error).message}` });
  }
  try {
    const ds = await appsV1.readNamespacedDaemonSet({ name: 'node-agent', namespace: ns() });
    const want = ds.status?.desiredNumberScheduled ?? 0;
    const ready = ds.status?.numberReady ?? 0;
    out.push({
      id: 'node-agent',
      category: '서버',
      name: 'node-agent (볼륨 백업 담당)',
      status: want > 0 && ready === want ? 'ok' : ready === 0 ? 'fail' : 'warn',
      message: `${ready}/${want} 노드 Ready${ready < want ? ' — 일부 노드의 볼륨이 백업되지 않을 수 있음' : ''}`,
    });
  } catch (e) {
    out.push({ id: 'node-agent', category: '서버', name: 'node-agent', status: 'fail', message: `조회 실패: ${(e as Error).message}` });
  }
  return out;
}

async function storageChecks(): Promise<Check[]> {
  const list = await velero.list<CR>(PLURALS.backupStorageLocations);
  return list.items.map((b) => {
    const phase = b.status?.phase;
    const stale = age(b.status?.lastValidationTime) > H;
    const status: Level = phase !== 'Available' ? 'fail' : stale ? 'warn' : 'ok';
    const bucket = (b.spec?.objectStorage as { bucket?: string } | undefined)?.bucket;
    return {
      id: `bsl-${b.metadata.name}`,
      category: '저장소' as const,
      name: `저장 위치 ${b.metadata.name}${bucket ? ` (${bucket})` : ''}`,
      status,
      message:
        phase !== 'Available'
          ? `${phase ?? '상태 없음'} — 저장소 접속 불가 ${b.status?.message ?? ''}`.trim()
          : stale
            ? `마지막 확인 ${hrs(age(b.status?.lastValidationTime))} 전`
            : '사용 가능',
    };
  });
}

function scheduleHealth(s: Schedule, backups: Backup[]): ScheduleHealth {
  const d = decorate(s).gimpo;
  const name = s.metadata.name!;
  const raw = s.spec?.schedule ?? '';
  const mine = backups
    .filter((b) => b.metadata?.labels?.['velero.io/schedule-name'] === name)
    .sort((a, b) => (b.metadata?.creationTimestamp ?? '').localeCompare(a.metadata?.creationTimestamp ?? ''));
  const last = mine[0];
  const lastOk = mine.find((b) => b.status?.phase === 'Completed');
  const st = (last?.status ?? {}) as Status;
  const base: ScheduleHealth = {
    name,
    displayName: d.displayName || name,
    schedule: raw,
    paused: !!s.spec?.paused,
    storageLocation: s.spec?.template?.storageLocation,
    ttl: s.spec?.template?.ttl,
    prevExpected: prevRun(raw),
    nextRun: s.spec?.paused ? undefined : nextRuns(raw, 1)[0],
    lastBackup: last
      ? {
          name: last.metadata!.name!,
          phase: st.phase,
          startedAt: st.startTimestamp,
          completedAt: st.completionTimestamp,
          errors: st.errors,
          warnings: st.warnings,
        }
      : undefined,
    lastSuccessAt: (lastOk?.status as Status | undefined)?.completionTimestamp,
    status: 'ok',
    message: '',
  };

  if (s.spec?.paused) return { ...base, status: 'warn', message: '일시정지됨 — 백업이 생성되지 않음' };

  const created = s.metadata.creationTimestamp ? new Date(s.metadata.creationTimestamp).getTime() : 0;
  const expected = base.prevExpected ? new Date(base.prevExpected).getTime() : 0;
  const grace = Math.min(2 * H, (intervalMs(raw) ?? 24 * H) / 2);
  const lastStart = last?.metadata?.creationTimestamp ? new Date(last.metadata.creationTimestamp).getTime() : 0;
  // 스케줄이 기록한 마지막 실행 시각도 실행 증거로 본다(백업이 삭제·만료돼 목록에 없을 수 있음).
  const schedLast = (s.status as { lastBackup?: string } | undefined)?.lastBackup;
  const lastRun = Math.max(lastStart, schedLast ? new Date(schedLast).getTime() : 0);

  if (expected > created && Date.now() - expected > grace && lastRun < expected - 5 * 60_000) {
    return { ...base, status: 'fail', message: `예정된 백업(${kst(expected)})이 실행되지 않음` };
  }
  if (!last) {
    return lastRun
      ? { ...base, status: 'ok', message: `예정대로 실행됨 (${hrs(Date.now() - lastRun)} 전) — 해당 백업은 삭제·만료되어 목록에 없음` }
      : { ...base, status: 'ok', message: '아직 실행 전 (첫 실행 대기)' };
  }
  if (lastStart < lastRun - 5 * 60_000) {
    // 최신 실행분의 백업이 목록에 없으면 남아 있는 더 오래된 백업 상태로 판단하지 않는다
    return { ...base, status: 'ok', message: `예정대로 실행됨 (${hrs(Date.now() - lastRun)} 전) — 최신 백업은 삭제·만료되어 목록에 없음` };
  }
  switch (st.phase) {
    case 'Completed':
      return { ...base, status: 'ok', message: `최근 백업 성공 (${hrs(age(st.completionTimestamp))} 전)` };
    case 'PartiallyFailed':
      return { ...base, status: 'warn', message: `최근 백업 일부 실패 (오류 ${st.errors ?? 0}건)` };
    case 'New':
    case 'InProgress':
    case 'WaitingForPluginOperations':
    case 'Finalizing': {
      const running = age(st.startTimestamp ?? last.metadata?.creationTimestamp);
      return running > 6 * H
        ? { ...base, status: 'fail', message: `${hrs(running)}째 진행 중 — 멈춤 의심` }
        : { ...base, status: 'ok', message: `진행 중 (${hrs(running)})` };
    }
    default:
      return { ...base, status: 'fail', message: `최근 백업 ${st.phase ?? '상태 없음'}` };
  }
}

async function operationChecks(): Promise<Check[]> {
  const out: Check[] = [];
  const active = ['New', 'Accepted', 'Prepared', 'InProgress', 'Canceling'];
  for (const [plural, label] of [
    [PLURALS.podVolumeBackups, '볼륨 백업(PVB)'],
    [PLURALS.podVolumeRestores, '볼륨 복구(PVR)'],
    [PLURALS.dataUploads, '데이터 업로드'],
  ] as const) {
    let items: CR[] = [];
    try {
      items = (await velero.list<CR>(plural)).items;
    } catch {
      continue;
    }
    const stuck = items.filter(
      (x) => active.includes(x.status?.phase ?? '') && age(x.metadata.creationTimestamp) > 4 * H,
    );
    out.push({
      id: `stuck-${plural}`,
      category: '작업',
      name: `멈춘 ${label}`,
      status: stuck.length === 0 ? 'ok' : 'fail',
      message: stuck.length === 0 ? '없음' : `${stuck.length}건이 4시간 이상 진행 중 (예: ${stuck[0].metadata.name})`,
    });
  }

  const dbrs = (await velero.list<CR>(PLURALS.deleteBackupRequests)).items.filter(
    (x) => x.status?.phase !== 'Processed',
  );
  const oldest = Math.max(0, ...dbrs.map((x) => age(x.metadata.creationTimestamp)));
  out.push({
    id: 'pending-deletes',
    category: '작업',
    name: '처리 대기 중인 백업 삭제 요청',
    status: dbrs.length === 0 || oldest < H ? 'ok' : oldest < 24 * H ? 'warn' : 'fail',
    message: dbrs.length === 0 ? '없음' : `${dbrs.length}건, 가장 오래된 것 ${hrs(oldest)} 전`,
  });

  try {
    const jobs = await batchV1.listNamespacedJob({ namespace: ns() });
    const maint = jobs.items.filter((j) => j.metadata?.name?.includes('-maintain-job-'));
    const long = maint.filter(
      (j) => !j.status?.completionTime && !j.status?.failed && age(j.status?.startTime) > 6 * H,
    );
    const failedRecent = maint.filter(
      (j) => (j.status?.failed ?? 0) > 0 && age(j.metadata?.creationTimestamp) < 7 * 24 * H,
    );
    out.push({
      id: 'repo-maintenance',
      category: '작업',
      name: '저장소 정리(maintenance) 잡',
      status: long.length ? 'fail' : failedRecent.length ? 'warn' : 'ok',
      message: long.length
        ? `${long.length}건이 6시간 이상 실행 중 — 저장소 지연 의심`
        : failedRecent.length
          ? `최근 7일 실패 ${failedRecent.length}건`
          : '정상',
    });
  } catch (e) {
    out.push({
      id: 'repo-maintenance',
      category: '작업',
      name: '저장소 정리(maintenance) 잡',
      status: 'warn',
      message: `조회 실패: ${(e as Error).message}`,
    });
  }
  return out;
}

async function restoreTestCheck(): Promise<Check> {
  const { config: cfg, history } = await store.read();
  const done = history.filter((r) => r.status !== 'running');
  const last = done[0];
  const lastOk = done.find((r) => r.status === 'success');
  const base = { id: 'restore-test', category: '복구 테스트' as const, name: '자동 복구 테스트' };
  if (!cfg.enabled) return { ...base, status: 'warn', message: '꺼져 있음 — 복구 가능 여부를 주기적으로 확인하지 않음' };
  if (!last) return { ...base, status: 'warn', message: '아직 실행 기록 없음' };
  if (last.status !== 'success') {
    return { ...base, status: 'fail', message: `최근 테스트 실패: ${last.error ?? last.status}` };
  }
  const gap = (intervalMs(cfg.schedule) ?? 24 * H) * 1.5;
  if (age(lastOk?.finishedAt) > gap) {
    return { ...base, status: 'warn', message: `마지막 성공이 ${hrs(age(lastOk?.finishedAt))} 전 — 예정보다 오래됨` };
  }
  return {
    ...base,
    status: 'ok',
    message: `최근 테스트 성공 (${hrs(age(last.finishedAt))} 전, ${last.durationSec ?? '-'}초)`,
  };
}

export async function buildHealthReport(): Promise<HealthReport> {
  const [srv, sto, ops, rt, schedules, backups] = await Promise.all([
    serverChecks(),
    storageChecks().catch((e): Check[] => [
      { id: 'bsl', category: '저장소', name: '저장 위치', status: 'fail', message: (e as Error).message },
    ]),
    operationChecks().catch((e): Check[] => [
      { id: 'ops', category: '작업', name: '작업 점검', status: 'warn', message: (e as Error).message },
    ]),
    restoreTestCheck().catch(
      (e): Check => ({ id: 'restore-test', category: '복구 테스트', name: '자동 복구 테스트', status: 'warn', message: (e as Error).message }),
    ),
    velero.list<Schedule>(PLURALS.schedules).then((l) => l.items),
    velero.list<Backup>(PLURALS.backups).then((l) => l.items),
  ]);
  const sh = schedules.map((s) => scheduleHealth(s, backups));
  const schedChecks: Check[] = sh.map((s) => ({
    id: `schedule-${s.name}`,
    category: '스케줄',
    name: s.displayName,
    status: s.status,
    message: s.message,
  }));
  const checks = [...srv, ...sto, ...schedChecks, ...ops, rt];
  const counts: Record<Level, number> = { ok: 0, warn: 0, fail: 0 };
  let overall: Level = 'ok';
  for (const c of checks) {
    counts[c.status]++;
    overall = worst(overall, c.status);
  }
  return { overall, checkedAt: new Date().toISOString(), counts, checks, schedules: sh };
}
