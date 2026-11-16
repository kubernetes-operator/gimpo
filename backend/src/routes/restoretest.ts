import type { FastifyInstance } from 'fastify';
import { store, type RestoreTestConfig } from '../restoretest/store';
import { runRestoreTest, currentRun, isRunning } from '../restoretest/runner';
import { nextRuns, validateVeleroCron } from '../util/cron';
import { velero, PLURALS } from '../k8s/velero';
import { config } from '../config';

const TTL = /^(\d+h)?(\d+m)?(\d+s)?$/;

export default async function restoreTestRoutes(app: FastifyInstance) {
  /** 설정 + 현재 실행 + 최근 이력 */
  app.get('/api/restore-test', async () => {
    const { config: cfg, history } = await store.read();
    return {
      config: cfg,
      namespace: config.restoreTest.namespace,
      nextRuns: cfg.enabled ? nextRuns(cfg.schedule, 3) : [],
      running: currentRun(),
      history,
    };
  });

  app.put<{ Body: Partial<RestoreTestConfig> }>('/api/restore-test/config', async (req, reply) => {
    const b = req.body ?? {};
    const patch: Partial<RestoreTestConfig> = {};
    if (b.enabled !== undefined) patch.enabled = !!b.enabled;
    if (b.schedule !== undefined) {
      try {
        patch.schedule = validateVeleroCron(b.schedule).raw;
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    }
    if (b.storageLocation !== undefined) {
      try {
        await velero.get(PLURALS.backupStorageLocations, b.storageLocation);
      } catch {
        return reply.code(400).send({ error: `저장 위치 '${b.storageLocation}' 가 없습니다` });
      }
      patch.storageLocation = b.storageLocation;
    }
    if (b.timeoutMinutes !== undefined) {
      const t = Number(b.timeoutMinutes);
      if (!Number.isFinite(t) || t < 5 || t > 180) {
        return reply.code(400).send({ error: '제한 시간은 5~180분' });
      }
      patch.timeoutMinutes = Math.round(t);
    }
    if (b.backupTtl !== undefined) {
      if (!b.backupTtl || !TTL.test(b.backupTtl)) {
        return reply.code(400).send({ error: '보관 기간 형식 예: 72h0m0s' });
      }
      patch.backupTtl = b.backupTtl;
    }
    if (b.keepRestores !== undefined) {
      const k = Number(b.keepRestores);
      if (!Number.isInteger(k) || k < 1 || k > 50) {
        return reply.code(400).send({ error: 'Restore 보관 개수는 1~50' });
      }
      patch.keepRestores = k;
    }
    return await store.updateConfig(patch);
  });

  /** 지금 실행 — 바로 응답하고 백그라운드에서 진행. 화면은 GET 으로 진행 상황을 폴링한다. */
  app.post('/api/restore-test/run', async (req, reply) => {
    if (isRunning()) return reply.code(409).send({ error: '이미 복구 테스트가 실행 중입니다' });
    const { config: cfg } = await store.read();
    void runRestoreTest(cfg, 'manual').catch((err) => req.log.error({ err }, '수동 복구 테스트 오류'));
    return reply.code(202).send({ message: '복구 테스트를 시작했습니다' });
  });
}
