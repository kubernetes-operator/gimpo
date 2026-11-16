import type { FastifyInstance } from 'fastify';
import { buildHealthReport, type HealthReport } from '../health/checks';

/** 30초 캐시 — 여러 화면이 동시에 열려도 API 서버 부하를 늘리지 않게. ?refresh=1 로 즉시 재점검. */
let cache: { at: number; data: HealthReport } | null = null;

export default async function healthRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { refresh?: string } }>('/api/health/report', async (req) => {
    if (req.query.refresh !== '1' && cache && Date.now() - cache.at < 30_000) return cache.data;
    const data = await buildHealthReport();
    cache = { at: Date.now(), data };
    return data;
  });
}
