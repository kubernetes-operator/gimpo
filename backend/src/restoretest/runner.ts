import crypto from 'node:crypto';
import { coreV1 } from '../k8s/client';
import { velero, PLURALS, API_VERSION } from '../k8s/velero';
import { config } from '../config';
import { store, type RestoreTestConfig, type RunRecord, type StepRecord } from './store';
import type { Backup, Restore, CustomResource } from '../types/velero';

/**
 * 자동 복구 테스트 — 전용 네임스페이스에서 "생성 → 백업 → 삭제 → 복구 → 검증 → 정리"를 수행한다.
 *
 * 테스트 데이터에는 매번 KST 날짜·시각과 임의값이 들어간다(이전 실행의 잔재로 통과하는 것을 방지).
 *  - ConfigMap rt-config : content(날짜 포함 표식)
 *  - Secret    rt-secret : token(임의값)
 *  - PVC       rt-data   : restore-test.txt(표식) + blob.bin(1MiB 난수, sha256 로 무결성 비교)
 *  - Pod       rt-app    : 처음엔 데이터를 쓰고, 복구된 뒤엔 기존 파일을 읽어 로그로 남긴다
 *
 * 테스트 네임스페이스 자체는 GitOps 로 유지되고(Role 포함), 그 안의 테스트 리소스만 지우고 복구한다.
 * 대시보드 SA 는 이 네임스페이스에만 쓰기 권한을 가진다.
 */

const LABEL_KEY = 'gimpo.io/restore-test';
const LABEL_SEL = `${LABEL_KEY}=true`;
const NAMES = { cm: 'rt-config', secret: 'rt-secret', pvc: 'rt-data', pod: 'rt-app' };

const STEP_DEFS: Array<[string, string]> = [
  ['prepare', '이전 테스트 잔여물 정리'],
  ['create', '테스트 데이터 생성 (Pod·PVC·ConfigMap·Secret)'],
  ['backup', '백업'],
  ['delete', '테스트 리소스 삭제 (장애 상황 재현)'],
  ['restore', '복구'],
  ['verify', '데이터 검증'],
  ['cleanup', '정리'],
];

const POD_SCRIPT = `
F=/data/restore-test.txt; B=/data/blob.bin
if [ -f "$F" ] && [ -f "$B" ]; then
  echo "RESTORE-TEST FOUND content=$(cat "$F")"
else
  echo "$CONTENT" > "$F" && head -c 1048576 /dev/urandom > "$B" || { echo "RESTORE-TEST WRITE-FAILED"; exit 1; }
  echo "RESTORE-TEST WROTE content=$(cat "$F")"
fi
echo "BLOB-SHA=$(sha256sum "$B" | cut -d' ' -f1)"
touch /tmp/ready
exec sleep infinity
`.trim();

const tns = () => config.restoreTest.namespace;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errCode = (e: unknown) => (e as { code?: number }).code;

function kstStamp(d = new Date()): { human: string; compact: string } {
  const f = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(d); // "2026-11-16 17:05:09"
  return { human: `${f} KST`, compact: f.replace(/[-: ]/g, '').replace(/^(\d{8})(\d{6})$/, '$1-$2') };
}

class StepError extends Error {}

let current: RunRecord | null = null;
export const currentRun = () => current;
export const isRunning = () => current?.status === 'running';

async function persist(run: RunRecord) {
  try {
    await store.upsertRun(run);
  } catch {
    /* 기록 실패가 테스트 자체를 실패시키지 않도록 */
  }
}

async function step<T>(run: RunRecord, key: string, fn: (s: StepRecord) => Promise<T>): Promise<T> {
  const s = run.steps.find((x) => x.key === key)!;
  s.status = 'running';
  s.startedAt = new Date().toISOString();
  await persist(run);
  try {
    const out = await fn(s);
    s.status = 'success';
    return out;
  } catch (err) {
    s.status = 'failed';
    s.message = (err as Error).message;
    throw err;
  } finally {
    s.finishedAt = new Date().toISOString();
    await persist(run);
  }
}

async function waitFor<T>(
  what: string,
  deadline: number,
  probe: () => Promise<T | undefined>,
  intervalMs = 3000,
): Promise<T> {
  for (;;) {
    const v = await probe();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new StepError(`시간 초과: ${what}`);
    await sleep(intervalMs);
  }
}

async function ignore404(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    if (errCode(e) !== 404) throw e;
  }
}

async function deleteTestResources() {
  const n = tns();
  await ignore404(coreV1.deleteNamespacedPod({ name: NAMES.pod, namespace: n, gracePeriodSeconds: 0 }));
  await ignore404(coreV1.deleteNamespacedPersistentVolumeClaim({ name: NAMES.pvc, namespace: n }));
  await ignore404(coreV1.deleteNamespacedConfigMap({ name: NAMES.cm, namespace: n }));
  await ignore404(coreV1.deleteNamespacedSecret({ name: NAMES.secret, namespace: n }));
}

async function testResourcesGone(): Promise<true | undefined> {
  const n = tns();
  const [pods, pvcs, cms, secs] = await Promise.all([
    coreV1.listNamespacedPod({ namespace: n, labelSelector: LABEL_SEL }),
    coreV1.listNamespacedPersistentVolumeClaim({ namespace: n, labelSelector: LABEL_SEL }),
    coreV1.listNamespacedConfigMap({ namespace: n, labelSelector: LABEL_SEL }),
    coreV1.listNamespacedSecret({ namespace: n, labelSelector: LABEL_SEL }),
  ]);
  const left = pods.items.length + pvcs.items.length + cms.items.length + secs.items.length;
  return left === 0 ? true : undefined;
}

async function podReady(): Promise<true | undefined> {
  try {
    const p = await coreV1.readNamespacedPod({ name: NAMES.pod, namespace: tns() });
    if (p.status?.phase === 'Failed') {
      throw new StepError(`테스트 파드 실패: ${p.status?.message ?? p.status?.reason ?? ''}`);
    }
    const ready = p.status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True');
    return ready ? true : undefined;
  } catch (e) {
    if (errCode(e) === 404) return undefined;
    throw e;
  }
}

async function podLog(): Promise<string> {
  return String(await coreV1.readNamespacedPodLog({ name: NAMES.pod, namespace: tns(), container: 'app' }));
}

function parseLog(log: string) {
  return {
    wrote: /RESTORE-TEST WROTE content=(.*)/.exec(log)?.[1]?.trim(),
    found: /RESTORE-TEST FOUND content=(.*)/.exec(log)?.[1]?.trim(),
    writeFailed: log.includes('RESTORE-TEST WRITE-FAILED'),
    sha: /BLOB-SHA=([0-9a-f]{64})/.exec(log)?.[1],
  };
}

const TERMINAL = ['Completed', 'PartiallyFailed', 'Failed', 'FailedValidation'];

async function createTestResources(content: string, token: string, runId: string) {
  const n = tns();
  const labels = { [LABEL_KEY]: 'true', 'gimpo.io/run-id': runId };
  await coreV1.createNamespacedConfigMap({
    namespace: n,
    body: { metadata: { name: NAMES.cm, labels }, data: { content } },
  });
  await coreV1.createNamespacedSecret({
    namespace: n,
    body: { metadata: { name: NAMES.secret, labels }, type: 'Opaque', stringData: { token } },
  });
  await coreV1.createNamespacedPersistentVolumeClaim({
    namespace: n,
    body: {
      metadata: { name: NAMES.pvc, labels },
      spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '64Mi' } } },
    },
  });
  await coreV1.createNamespacedPod({
    namespace: n,
    body: {
      metadata: { name: NAMES.pod, labels },
      spec: {
        terminationGracePeriodSeconds: 1,
        securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000 },
        containers: [
          {
            name: 'app',
            image: config.restoreTest.image,
            imagePullPolicy: 'IfNotPresent',
            command: ['sh', '-c', POD_SCRIPT],
            env: [
              { name: 'CONTENT', valueFrom: { configMapKeyRef: { name: NAMES.cm, key: 'content' } } },
              { name: 'TOKEN', valueFrom: { secretKeyRef: { name: NAMES.secret, key: 'token' } } },
            ],
            volumeMounts: [{ name: 'data', mountPath: '/data' }],
            readinessProbe: { exec: { command: ['test', '-f', '/tmp/ready'] }, periodSeconds: 2 },
            resources: { requests: { cpu: '10m', memory: '16Mi' }, limits: { cpu: '200m', memory: '64Mi' } },
            securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } },
          },
        ],
        volumes: [{ name: 'data', persistentVolumeClaim: { claimName: NAMES.pvc } }],
      },
    },
  });
}

async function pruneOldRestores(keep: number) {
  const list = await velero.listBySelector<Restore>(PLURALS.restores, LABEL_SEL);
  const sorted = list.items.sort((a, b) =>
    (b.metadata?.creationTimestamp ?? '').localeCompare(a.metadata?.creationTimestamp ?? ''),
  );
  for (const r of sorted.slice(Math.max(1, keep))) {
    await ignore404(velero.delete(PLURALS.restores, r.metadata!.name!));
  }
}

/** 한 번의 복구 테스트를 실행한다. 동시에 하나만 실행된다. */
export async function runRestoreTest(
  cfg: RestoreTestConfig,
  trigger: RunRecord['trigger'],
): Promise<RunRecord> {
  if (isRunning()) throw new Error('이미 복구 테스트가 실행 중입니다');
  const started = new Date();
  const stamp = kstStamp(started);
  const runId = `rt-${stamp.compact}`;
  const run: RunRecord = {
    id: runId,
    trigger,
    status: 'running',
    startedAt: started.toISOString(),
    storageLocation: cfg.storageLocation,
    steps: STEP_DEFS.map(([key, name]) => ({ key, name, status: 'pending' })),
  };
  current = run;
  const deadline = started.getTime() + cfg.timeoutMinutes * 60_000;
  const content = `restore-test ${stamp.human} nonce=${crypto.randomBytes(6).toString('hex')}`;
  const token = crypto.randomBytes(16).toString('hex');
  run.marker = { content, token };

  try {
    await step(run, 'prepare', async (s) => {
      await deleteTestResources();
      await waitFor('이전 테스트 리소스 삭제', deadline, testResourcesGone);
      s.message = `네임스페이스 ${tns()} 준비 완료`;
    });

    await step(run, 'create', async (s) => {
      await createTestResources(content, token, runId);
      await waitFor('테스트 파드 Ready', deadline, podReady);
      const log = parseLog(await podLog());
      if (log.writeFailed) throw new StepError('PVC 에 쓰기 실패(권한 확인 필요)');
      if (log.wrote !== content || !log.sha) throw new StepError('테스트 데이터 기록 확인 실패');
      run.marker!.blobSha = log.sha;
      s.message = `"${content}" 기록, blob sha256=${log.sha.slice(0, 12)}…`;
    });

    const backupName = `restore-test-${stamp.compact}`;
    run.backupName = backupName;
    await step(run, 'backup', async (s) => {
      const body: CustomResource = {
        apiVersion: API_VERSION,
        kind: 'Backup',
        metadata: { name: backupName, namespace: config.veleroNamespace, labels: { [LABEL_KEY]: 'true' } },
        spec: {
          includedNamespaces: [tns()],
          labelSelector: { matchLabels: { [LABEL_KEY]: 'true' } },
          defaultVolumesToFsBackup: true,
          snapshotVolumes: false,
          storageLocation: cfg.storageLocation,
          ttl: cfg.backupTtl,
        },
      };
      await velero.create(PLURALS.backups, body);
      const b = await waitFor('백업 완료', deadline, async () => {
        const x = await velero.get<Backup>(PLURALS.backups, backupName);
        return TERMINAL.includes(x.status?.phase ?? '') ? x : undefined;
      });
      if (b.status?.phase !== 'Completed') {
        throw new StepError(`백업 상태 ${b.status?.phase} (errors=${b.status?.errors ?? 0})`);
      }
      const pvbs = await velero.listBySelector<CustomResource<unknown, { phase?: string; progress?: { totalBytes?: number } }>>(
        PLURALS.podVolumeBackups,
        `velero.io/backup-name=${backupName}`,
      );
      if (pvbs.items.length === 0) throw new StepError('볼륨 백업(PodVolumeBackup)이 생성되지 않음');
      const bad = pvbs.items.filter((p) => p.status?.phase !== 'Completed');
      if (bad.length) throw new StepError(`볼륨 백업 ${bad.length}건 미완료`);
      s.message = `${backupName} → ${cfg.storageLocation} (볼륨 ${pvbs.items.length}건)`;
    });

    await step(run, 'delete', async (s) => {
      await deleteTestResources();
      await waitFor('테스트 리소스 삭제', deadline, testResourcesGone);
      s.message = 'Pod·PVC·ConfigMap·Secret 삭제 확인';
    });

    const restoreName = `${backupName}-restore`;
    run.restoreName = restoreName;
    await step(run, 'restore', async (s) => {
      await velero.create(PLURALS.restores, {
        apiVersion: API_VERSION,
        kind: 'Restore',
        metadata: { name: restoreName, namespace: config.veleroNamespace, labels: { [LABEL_KEY]: 'true' } },
        spec: { backupName, restorePVs: true },
      });
      const r = await waitFor('복구 완료', deadline, async () => {
        const x = await velero.get<Restore>(PLURALS.restores, restoreName);
        return TERMINAL.includes(x.status?.phase ?? '') ? x : undefined;
      });
      if (r.status?.phase !== 'Completed') {
        throw new StepError(`복구 상태 ${r.status?.phase} (errors=${r.status?.errors ?? 0})`);
      }
      const pvrs = await waitFor('볼륨 복구 완료', deadline, async () => {
        const l = await velero.listBySelector<CustomResource<unknown, { phase?: string }>>(
          PLURALS.podVolumeRestores,
          `velero.io/restore-name=${restoreName}`,
        );
        if (l.items.length === 0) return undefined;
        if (l.items.some((p) => p.status?.phase === 'Failed')) throw new StepError('볼륨 복구 실패');
        return l.items.every((p) => p.status?.phase === 'Completed') ? l.items : undefined;
      });
      s.message = `${restoreName} 완료 (볼륨 ${pvrs.length}건)`;
    });

    await step(run, 'verify', async (s) => {
      await waitFor('복구된 파드 Ready', deadline, podReady);
      const cm = await coreV1.readNamespacedConfigMap({ name: NAMES.cm, namespace: tns() });
      if (cm.data?.content !== content) throw new StepError('ConfigMap 내용 불일치');
      const sec = await coreV1.readNamespacedSecret({ name: NAMES.secret, namespace: tns() });
      const tok = Buffer.from(sec.data?.token ?? '', 'base64').toString('utf-8');
      if (tok !== token) throw new StepError('Secret 내용 불일치');
      const log = parseLog(await podLog());
      if (log.wrote) throw new StepError('복구된 PVC 가 비어 있음(데이터를 새로 기록함)');
      if (log.found !== content) throw new StepError(`PVC 파일 내용 불일치: "${log.found ?? '없음'}"`);
      run.marker!.restoredBlobSha = log.sha;
      if (!log.sha || log.sha !== run.marker!.blobSha) throw new StepError('1MiB 데이터 sha256 불일치');
      s.message = 'ConfigMap·Secret·PVC 파일·1MiB 데이터 모두 일치';
    });

    await step(run, 'cleanup', async (s) => {
      await deleteTestResources();
      await pruneOldRestores(cfg.keepRestores);
      s.message = `테스트 리소스 삭제, Restore 기록 최근 ${cfg.keepRestores}건 유지 (백업은 ${cfg.backupTtl} 뒤 자동 삭제)`;
    });

    run.status = 'success';
  } catch (err) {
    run.status = 'failed';
    run.error = (err as Error).message;
    for (const s of run.steps) if (s.status === 'pending') s.status = 'skipped';
    // 실패 시 리소스는 원인 분석을 위해 남겨 둔다(다음 실행의 prepare 단계에서 정리).
  } finally {
    run.finishedAt = new Date().toISOString();
    run.durationSec = Math.round((Date.now() - started.getTime()) / 1000);
    await persist(run);
    current = null;
  }
  return run;
}
