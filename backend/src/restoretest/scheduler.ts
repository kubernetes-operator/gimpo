import type { FastifyBaseLogger } from 'fastify';
import { store } from './store';
import { runRestoreTest, isRunning } from './runner';
import { prevRun } from '../util/cron';

/**
 * 복구 테스트 스케줄러 — 30초마다 "직전 예정 시각"이 아직 처리되지 않았으면 실행한다.
 * 대시보드가 잠시 내려가 있었더라도 예정 시각에서 1시간 이내면 따라잡아 실행하고, 그보다 오래됐으면 건너뛴다.
 */
const TICK_MS = 30_000;
const CATCH_UP_MS = 60 * 60_000;

export function startRestoreTestScheduler(log: FastifyBaseLogger) {
  let busy = false;

  const tick = async () => {
    if (busy || isRunning()) return;
    busy = true;
    try {
      const { config: cfg, state } = await store.read();
      const due = prevRun(cfg.schedule);
      if (!due) return;
      if (state.lastScheduledFor === undefined) {
        // 첫 기동: 과거 예정분은 실행하지 않고 기준점만 기록
        await store.setState({ lastScheduledFor: due });
        return;
      }
      if (new Date(due) <= new Date(state.lastScheduledFor)) return;
      await store.setState({ lastScheduledFor: due });
      if (!cfg.enabled) return;
      if (Date.now() - new Date(due).getTime() > CATCH_UP_MS) {
        log.warn({ due }, '복구 테스트 예정 시각을 1시간 이상 지나 건너뜀');
        return;
      }
      log.info({ due }, '예약된 복구 테스트 시작');
      const run = await runRestoreTest(cfg, 'schedule');
      log.info({ id: run.id, status: run.status, error: run.error }, '예약된 복구 테스트 종료');
    } catch (err) {
      log.error({ err }, '복구 테스트 스케줄러 오류');
    } finally {
      busy = false;
    }
  };

  void store.markAbortedRuns().catch((err) => log.error({ err }, '중단된 실행 표시 실패'));
  const timer = setInterval(() => void tick(), TICK_MS);
  timer.unref();
  void tick();
  return () => clearInterval(timer);
}
