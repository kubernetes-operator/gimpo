import type { FastifyInstance } from 'fastify';
import { collect, cronInfo, readHistory, runningJobs, triggerJob } from '../etcd/collector';
import { buildRunbook } from '../etcd/runbook';

const NAME = /^etcd-\d{8}-\d{6}-[a-z0-9.-]+$/;

export default async function etcdRoutes(app: FastifyInstance) {
  /** etcd 백업 현황 — 스케줄, 진행 중 잡, 스냅샷·복원 연습 이력, 최근 멤버 상태 */
  app.get('/api/etcd', async (req) => {
    await collect(req.log);
    const [crons, running, hist] = await Promise.all([cronInfo(), runningJobs(), readHistory()]);
    const lastOk = hist.snapshots.find((s) => s.status === 'success');
    return {
      crons,
      running,
      snapshots: hist.snapshots,
      drills: hist.drills,
      latest: hist.snapshots[0] ?? null,
      lastSuccess: lastOk ?? null,
      members: lastOk?.members ?? [],
      endpoints: lastOk?.endpoints ?? [],
      inventory: lastOk?.inventory ?? null,
    };
  });

  /** 지금 스냅샷 (관리자만 — 공통 권한 모듈이 쓰기 요청을 관리자로 제한) */
  app.post('/api/etcd/snapshot', async (_req, reply) => {
    const running = await runningJobs();
    if (running.some((j) => j.kind === 'snapshot')) return reply.code(409).send({ error: '이미 스냅샷이 진행 중입니다' });
    const job = await triggerJob('snapshot');
    return reply.code(202).send({ message: 'etcd 스냅샷을 시작했습니다', job });
  });

  /** 지금 복원 연습 — snapshot 을 주면 그 스냅샷으로, 없으면 최신으로 */
  app.post<{ Body: { snapshot?: string } }>('/api/etcd/drill', async (req, reply) => {
    const snap = req.body?.snapshot;
    if (snap && !NAME.test(snap)) return reply.code(400).send({ error: '스냅샷 이름 형식이 올바르지 않습니다' });
    const running = await runningJobs();
    if (running.some((j) => j.kind === 'drill')) return reply.code(409).send({ error: '이미 복원 연습이 진행 중입니다' });
    const job = await triggerJob('drill', snap);
    return reply.code(202).send({ message: '복원 연습을 시작했습니다', job });
  });

  /** 롤백 절차서 — 선택한(또는 최신 성공) 스냅샷 기준으로 노드별 명령 생성 */
  app.get<{ Querystring: { snapshot?: string } }>('/api/etcd/runbook', async (req, reply) => {
    const hist = await readHistory();
    const want = req.query.snapshot;
    const s = want
      ? hist.snapshots.find((x) => x.name === want && x.status === 'success')
      : hist.snapshots.find((x) => x.status === 'success');
    if (!s) return reply.code(404).send({ error: want ? `성공한 스냅샷 ${want} 이(가) 없습니다` : '성공한 스냅샷이 없습니다' });
    try {
      return buildRunbook(s);
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });
}
