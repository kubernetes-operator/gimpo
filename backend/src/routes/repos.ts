import type { FastifyInstance } from 'fastify';
import { velero, PLURALS } from '../k8s/velero';

/** 읽기 전용 조회 리소스: 리포지토리 및 볼륨/데이터무버 작업 상태. */
export default async function repoRoutes(app: FastifyInstance) {
  app.get('/api/backup-repositories', async () => {
    return (await velero.list(PLURALS.backupRepositories)).items;
  });

  app.get('/api/pod-volume-backups', async () => {
    return (await velero.list(PLURALS.podVolumeBackups)).items;
  });

  app.get('/api/pod-volume-restores', async () => {
    return (await velero.list(PLURALS.podVolumeRestores)).items;
  });

  app.get('/api/data-uploads', async () => {
    return (await velero.list(PLURALS.dataUploads)).items;
  });

  app.get('/api/data-downloads', async () => {
    return (await velero.list(PLURALS.dataDownloads)).items;
  });
}
