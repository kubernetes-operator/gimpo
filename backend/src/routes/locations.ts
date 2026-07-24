import type { FastifyInstance } from 'fastify';
import { velero, PLURALS } from '../k8s/velero';
import type { CustomResource } from '../types/velero';

export default async function locationRoutes(app: FastifyInstance) {
  // BackupStorageLocation 목록/단건
  app.get('/api/backup-storage-locations', async () => {
    return (await velero.list(PLURALS.backupStorageLocations)).items;
  });

  app.get<{ Params: { name: string } }>('/api/backup-storage-locations/:name', async (req) => {
    return await velero.get(PLURALS.backupStorageLocations, req.params.name);
  });

  /**
   * 기본 BSL 설정. Velero 는 spec.default=true 인 BSL 을 기본으로 사용한다.
   * 요청한 BSL 만 default=true 로 두고 나머지는 default=false 로 patch (단일 기본 보장).
   */
  app.patch<{ Params: { name: string } }>(
    '/api/backup-storage-locations/:name/default',
    async (req) => {
      const target = req.params.name;
      const list = await velero.list<CustomResource<{ default?: boolean }>>(
        PLURALS.backupStorageLocations,
      );
      const results = [];
      for (const bsl of list.items) {
        const name = bsl.metadata.name!;
        const shouldBeDefault = name === target;
        if (!!bsl.spec?.default === shouldBeDefault) continue;
        results.push(
          await velero.mergePatch(PLURALS.backupStorageLocations, name, {
            spec: { default: shouldBeDefault },
          }),
        );
      }
      return { message: `기본 BSL → ${target}`, updated: results.length };
    },
  );

  // VolumeSnapshotLocation 목록/단건
  app.get('/api/volume-snapshot-locations', async () => {
    return (await velero.list(PLURALS.volumeSnapshotLocations)).items;
  });

  app.get<{ Params: { name: string } }>('/api/volume-snapshot-locations/:name', async (req) => {
    return await velero.get(PLURALS.volumeSnapshotLocations, req.params.name);
  });
}
