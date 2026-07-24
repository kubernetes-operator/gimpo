import path from 'node:path';
import fs from 'node:fs';
import Fastify from 'fastify';
import { config } from './config';
import backupRoutes from './routes/backups';
import restoreRoutes from './routes/restores';
import scheduleRoutes from './routes/schedules';
import locationRoutes from './routes/locations';
import repoRoutes from './routes/repos';
import clusterRoutes from './routes/cluster';

export async function buildServer() {
  const app = Fastify({ logger: { level: config.logLevel } });

  // 헬스체크 (liveness/readiness)
  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/api/health', async () => ({
    status: 'ok',
    veleroNamespace: config.veleroNamespace,
  }));

  // 에러 핸들러 — K8s API 에러를 클라이언트가 읽기 쉬운 형태로 변환 (라우트 등록 전에 설정)
  app.setErrorHandler((err, _req, reply) => {
    const anyErr = err as unknown as {
      statusCode?: number;
      code?: number;
      body?: { message?: string; reason?: string };
      message?: string;
    };
    const raw = anyErr.statusCode ?? anyErr.code;
    const status = typeof raw === 'number' && raw >= 400 && raw < 600 ? raw : 500;
    const message = anyErr.body?.message ?? anyErr.message ?? '알 수 없는 오류';
    reply.code(status).send({ error: message, reason: anyErr.body?.reason });
  });

  // Velero API 라우트
  await app.register(backupRoutes);
  await app.register(restoreRoutes);
  await app.register(scheduleRoutes);
  await app.register(locationRoutes);
  await app.register(repoRoutes);
  await app.register(clusterRoutes);

  // 프로덕션: SPA 정적 서빙 + 클라이언트 라우팅 fallback
  if (config.staticDir && fs.existsSync(config.staticDir)) {
    const staticRoot = path.resolve(config.staticDir);
    const fastifyStatic = (await import('@fastify/static')).default;
    await app.register(fastifyStatic, { root: staticRoot, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.raw.url?.startsWith('/api')) {
        return reply.code(404).send({ error: 'Not Found' });
      }
      return reply.sendFile('index.html');
    });
    app.log.info(`정적 SPA 서빙: ${staticRoot}`);
  } else {
    app.log.info('STATIC_DIR 미설정 — API 전용(개발) 모드');
  }

  return app;
}

async function main() {
  const app = await buildServer();
  try {
    await app.listen({ port: config.port, host: config.host });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

if (require.main === module) {
  void main();
}
