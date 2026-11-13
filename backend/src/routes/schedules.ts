import type { FastifyInstance } from 'fastify';
import { velero, PLURALS, API_VERSION } from '../k8s/velero';
import { pruneEmpty } from '../util/clean';
import { config } from '../config';
import type { Schedule, ScheduleSpec, CustomResource } from '../types/velero';

interface CreateScheduleBody {
  name: string;
  labels?: Record<string, string>;
  spec: ScheduleSpec;
}

export default async function scheduleRoutes(app: FastifyInstance) {
  app.get('/api/schedules', async () => {
    const list = await velero.list<Schedule>(PLURALS.schedules);
    return list.items;
  });

  app.get<{ Params: { name: string } }>('/api/schedules/:name', async (req) => {
    return await velero.get<Schedule>(PLURALS.schedules, req.params.name);
  });

  app.post<{ Body: CreateScheduleBody }>('/api/schedules', async (req, reply) => {
    const { name, labels, spec } = req.body;
    if (!name) return reply.code(400).send({ error: 'name 은 필수입니다' });
    if (!spec?.schedule) return reply.code(400).send({ error: 'schedule(cron) 은 필수입니다' });
    const body: CustomResource = {
      apiVersion: API_VERSION,
      kind: 'Schedule',
      metadata: { name, namespace: config.veleroNamespace, labels },
      spec: pruneEmpty(spec),
    };
    const created = await velero.create<Schedule>(PLURALS.schedules, pruneEmpty(body));
    return reply.code(201).send(created);
  });

  app.delete<{ Params: { name: string } }>('/api/schedules/:name', async (req) => {
    await velero.delete(PLURALS.schedules, req.params.name);
    return { message: 'Schedule 삭제됨', name: req.params.name };
  });

  // pause / resume 토글 (merge patch)
  app.patch<{ Params: { name: string }; Body: { paused: boolean } }>(
    '/api/schedules/:name/pause',
    async (req) => {
      return await velero.mergePatch<Schedule>(PLURALS.schedules, req.params.name, {
        spec: { paused: !!req.body.paused },
      });
    },
  );

  // 즉시 실행 — 스케줄의 template 으로 Backup 을 즉시 생성 (velero create backup --from-schedule 과 동등)
  app.post<{ Params: { name: string } }>('/api/schedules/:name/trigger', async (req, reply) => {
    const schedule = await velero.get<Schedule>(PLURALS.schedules, req.params.name);
    const template = schedule.spec?.template ?? {};
    const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const backupName = `${req.params.name}-${ts}`.slice(0, 253);
    const body: CustomResource = {
      apiVersion: API_VERSION,
      kind: 'Backup',
      metadata: {
        name: backupName,
        namespace: config.veleroNamespace,
        labels: { 'velero.io/schedule-name': req.params.name },
      },
      spec: pruneEmpty(template),
    };
    const created = await velero.create(PLURALS.backups, body);
    return reply.code(201).send({ message: '스케줄 template 으로 백업 즉시 생성', backup: created });
  });
}
