import type { FastifyInstance } from 'fastify';
import { velero, PLURALS, API_VERSION } from '../k8s/velero';
import { fetchDownloadText, fetchDownloadJson } from '../k8s/download';
import { pruneEmpty } from '../util/clean';
import { config } from '../config';
import type { Restore, RestoreSpec, CustomResource } from '../types/velero';

interface CreateRestoreBody {
  name: string;
  labels?: Record<string, string>;
  spec: RestoreSpec;
}

export default async function restoreRoutes(app: FastifyInstance) {
  app.get('/api/restores', async () => {
    const list = await velero.list<Restore>(PLURALS.restores);
    return list.items;
  });

  app.get<{ Params: { name: string } }>('/api/restores/:name', async (req) => {
    return await velero.get<Restore>(PLURALS.restores, req.params.name);
  });

  // 복구 실행 (쓰기 작업) — backupName 또는 scheduleName 중 하나 필요
  app.post<{ Body: CreateRestoreBody }>('/api/restores', async (req, reply) => {
    const { name, labels, spec } = req.body;
    if (!name) return reply.code(400).send({ error: 'name 은 필수입니다' });
    if (!spec?.backupName && !spec?.scheduleName) {
      return reply.code(400).send({ error: 'backupName 또는 scheduleName 이 필요합니다' });
    }
    const body: CustomResource = {
      apiVersion: API_VERSION,
      kind: 'Restore',
      metadata: { name, namespace: config.veleroNamespace, labels },
      spec: pruneEmpty(spec),
    };
    const created = await velero.create<Restore>(PLURALS.restores, pruneEmpty(body));
    return reply.code(201).send(created);
  });

  app.delete<{ Params: { name: string } }>('/api/restores/:name', async (req) => {
    await velero.delete(PLURALS.restores, req.params.name);
    return { message: 'Restore 삭제됨', name: req.params.name };
  });

  app.get<{ Params: { name: string } }>('/api/restores/:name/logs', async (req, reply) => {
    const text = await fetchDownloadText('RestoreLog', req.params.name);
    reply.type('text/plain; charset=utf-8');
    return text;
  });

  app.get<{ Params: { name: string } }>('/api/restores/:name/results', async (req) => {
    return await fetchDownloadJson('RestoreResults', req.params.name);
  });
}
