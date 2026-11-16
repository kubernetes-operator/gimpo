import { coreV1 } from '../k8s/client';
import { config } from '../config';

/**
 * 복구 테스트 설정·이력 저장소 — velero 네임스페이스의 ConfigMap 하나(data.config / data.history / data.state).
 * 대시보드는 단일 레플리카라 프로세스 내 직렬화(쓰기 큐)로 충분하다.
 */

export interface RestoreTestConfig {
  enabled: boolean;
  /** Velero 와 같은 cron 표기. 기본은 KST 매일 05:00 (백업 03:00·03:30 이후) */
  schedule: string;
  /** 테스트 백업을 저장할 BSL — 데이터 경로(SeaweedFS)를 검증하는 것이 목적 */
  storageLocation: string;
  /** 전체 실행 제한 시간(분) */
  timeoutMinutes: number;
  /** 테스트 백업 보관 기간 */
  backupTtl: string;
  /** 보관할 테스트 Restore CR 개수(이력 화면에서 로그 확인용) */
  keepRestores: number;
}

export type StepStatus = 'pending' | 'running' | 'success' | 'failed' | 'skipped';

export interface StepRecord {
  key: string;
  name: string;
  status: StepStatus;
  startedAt?: string;
  finishedAt?: string;
  message?: string;
}

export interface RunRecord {
  id: string;
  trigger: 'schedule' | 'manual';
  status: 'running' | 'success' | 'failed' | 'aborted';
  startedAt: string;
  finishedAt?: string;
  durationSec?: number;
  storageLocation: string;
  backupName?: string;
  restoreName?: string;
  /** 테스트 데이터 표식 — 날짜·임의값이 들어가 매번 새 데이터로 검증한다 */
  marker?: { content: string; token: string; blobSha?: string; restoredBlobSha?: string };
  steps: StepRecord[];
  error?: string;
}

interface SchedulerState {
  /** 마지막으로 처리(실행 또는 건너뜀)한 예정 시각 ISO */
  lastScheduledFor?: string;
}

export const DEFAULT_CONFIG: RestoreTestConfig = {
  enabled: true,
  schedule: 'CRON_TZ=Asia/Seoul 0 5 * * *',
  storageLocation: 'seaweedfs-lab',
  timeoutMinutes: 20,
  backupTtl: '72h0m0s',
  keepRestores: 7,
};

const HISTORY_LIMIT = 60;

const cmName = () => config.restoreTest.stateConfigMap;
const ns = () => config.veleroNamespace;

interface Snapshot {
  config: RestoreTestConfig;
  history: RunRecord[];
  state: SchedulerState;
}

function parse<T>(raw: string | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function readRaw(): Promise<{ snap: Snapshot; resourceVersion?: string; exists: boolean }> {
  try {
    const cm = await coreV1.readNamespacedConfigMap({ name: cmName(), namespace: ns() });
    return {
      exists: true,
      resourceVersion: cm.metadata?.resourceVersion,
      snap: {
        config: { ...DEFAULT_CONFIG, ...parse<Partial<RestoreTestConfig>>(cm.data?.config, {}) },
        history: parse<RunRecord[]>(cm.data?.history, []),
        state: parse<SchedulerState>(cm.data?.state, {}),
      },
    };
  } catch (err) {
    const code = (err as { code?: number; statusCode?: number }).code ?? (err as { statusCode?: number }).statusCode;
    if (code === 404) {
      return { exists: false, snap: { config: { ...DEFAULT_CONFIG }, history: [], state: {} } };
    }
    throw err;
  }
}

let queue: Promise<unknown> = Promise.resolve();

/** 읽기-수정-쓰기를 직렬화한다. 충돌(409) 시 1회 재시도. */
function mutate(fn: (s: Snapshot) => void): Promise<Snapshot> {
  const job = queue.then(async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const { snap, resourceVersion, exists } = await readRaw();
      fn(snap);
      snap.history = snap.history.slice(0, HISTORY_LIMIT);
      const body = {
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: {
          name: cmName(),
          namespace: ns(),
          labels: { 'app.kubernetes.io/part-of': 'gimpo-velero-dashboard' },
          ...(resourceVersion ? { resourceVersion } : {}),
        },
        data: {
          config: JSON.stringify(snap.config, null, 2),
          history: JSON.stringify(snap.history),
          state: JSON.stringify(snap.state),
        },
      };
      try {
        if (exists) {
          await coreV1.replaceNamespacedConfigMap({ name: cmName(), namespace: ns(), body });
        } else {
          await coreV1.createNamespacedConfigMap({ namespace: ns(), body });
        }
        return snap;
      } catch (err) {
        const code = (err as { code?: number }).code;
        if (code === 409 && attempt === 0) continue;
        throw err;
      }
    }
    throw new Error('ConfigMap 갱신 충돌');
  });
  queue = job.catch(() => undefined);
  return job;
}

export const store = {
  async read(): Promise<Snapshot> {
    return (await readRaw()).snap;
  },
  async updateConfig(patch: Partial<RestoreTestConfig>): Promise<RestoreTestConfig> {
    const s = await mutate((snap) => {
      snap.config = { ...snap.config, ...patch };
    });
    return s.config;
  },
  async upsertRun(run: RunRecord): Promise<void> {
    await mutate((snap) => {
      const i = snap.history.findIndex((r) => r.id === run.id);
      if (i >= 0) snap.history[i] = run;
      else snap.history.unshift(run);
    });
  },
  async setState(patch: Partial<SchedulerState>): Promise<void> {
    await mutate((snap) => {
      snap.state = { ...snap.state, ...patch };
    });
  },
  /** 재시작 등으로 중단된 실행 표시 */
  async markAbortedRuns(): Promise<void> {
    await mutate((snap) => {
      for (const r of snap.history) {
        if (r.status === 'running') {
          r.status = 'aborted';
          r.finishedAt = new Date().toISOString();
          r.error = '대시보드 재시작 등으로 실행이 중단됨';
          for (const st of r.steps) if (st.status === 'running') st.status = 'failed';
        }
      }
    });
  },
};
