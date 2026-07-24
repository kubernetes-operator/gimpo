import type { FastifyInstance } from 'fastify';
import { velero, PLURALS, API_VERSION } from '../k8s/velero';
import { fetchDownloadText, fetchDownloadJson } from '../k8s/download';
import { pruneEmpty } from '../util/clean';
import { config } from '../config';
import type { Backup, BackupSpec, CustomResource } from '../types/velero';

/** 백업 생성 요청 바디: metadata.name + BackupSpec 필드. */
interface CreateBackupBody {
  name: string;
  labels?: Record<string, string>;
  spec: BackupSpec;
}

export default async function backupRoutes(app: FastifyInstance) {
  // 목록
  app.get('/api/backups', async () => {
    const list = await velero.list<Backup>(PLURALS.backups);
    return list.items;
  });

  // 단건
  app.get<{ Params: { name: string } }>('/api/backups/:name', async (req) => {
    return await velero.get<Backup>(PLURALS.backups, req.params.name);
  });

  // 생성 (쓰기 작업)
  app.post<{ Body: CreateBackupBody }>('/api/backups', async (req, reply) => {
    const { name, labels, spec } = req.body;
    if (!name) return reply.code(400).send({ error: 'name 은 필수입니다' });
    const body: CustomResource = {
      apiVersion: API_VERSION,
      kind: 'Backup',
      metadata: { name, namespace: config.veleroNamespace, labels },
      spec: pruneEmpty(spec ?? {}),
    };
    const created = await velero.create<Backup>(PLURALS.backups, pruneEmpty(body));
    return reply.code(201).send(created);
  });

  // 삭제 → DeleteBackupRequest 로 오브젝트 스토리지까지 정리
  app.delete<{ Params: { name: string } }>('/api/backups/:name', async (req) => {
    const name = req.params.name;
    const dbrName = `${name}-delete-${Date.now()}`.slice(0, 253);
    const body: CustomResource = {
      apiVersion: API_VERSION,
      kind: 'DeleteBackupRequest',
      metadata: { name: dbrName, namespace: config.veleroNamespace },
      spec: { backupName: name },
    };
    const created = await velero.create(PLURALS.deleteBackupRequests, body);
    return { message: 'DeleteBackupRequest 생성됨', deleteBackupRequest: created };
  });

  // 로그
  app.get<{ Params: { name: string } }>('/api/backups/:name/logs', async (req, reply) => {
    const text = await fetchDownloadText('BackupLog', req.params.name);
    reply.type('text/plain; charset=utf-8');
    return text;
  });

  // 결과(warnings/errors)
  app.get<{ Params: { name: string } }>('/api/backups/:name/results', async (req) => {
    return await fetchDownloadJson('BackupResults', req.params.name);
  });

  // 백업에 포함된 리소스 목록
  app.get<{ Params: { name: string } }>('/api/backups/:name/resource-list', async (req) => {
    return await fetchDownloadJson('BackupResourceList', req.params.name);
  });

  // 볼륨 스냅샷
  app.get<{ Params: { name: string } }>('/api/backups/:name/volume-snapshots', async (req) => {
    return await fetchDownloadJson('BackupVolumeSnapshots', req.params.name);
  });
}
