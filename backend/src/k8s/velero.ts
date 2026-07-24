import { customObjects, k8s } from './client';
import { config } from '../config';
import type { CustomResource, CustomResourceList } from '../types/velero';

export const GROUP = 'velero.io';
export const VERSION = 'v1';

/** 대시보드가 다루는 velero.io 리소스의 plural 이름. */
export const PLURALS = {
  backups: 'backups',
  restores: 'restores',
  schedules: 'schedules',
  backupStorageLocations: 'backupstoragelocations',
  volumeSnapshotLocations: 'volumesnapshotlocations',
  backupRepositories: 'backuprepositories',
  podVolumeBackups: 'podvolumebackups',
  podVolumeRestores: 'podvolumerestores',
  dataUploads: 'datauploads',
  dataDownloads: 'datadownloads',
  deleteBackupRequests: 'deletebackuprequests',
  downloadRequests: 'downloadrequests',
  serverStatusRequests: 'serverstatusrequests',
} as const;

const ns = () => config.veleroNamespace;

/** velero.io 네임스페이스 스코프 CR 제네릭 CRUD 래퍼. 라우트를 얇게 유지한다. */
export const velero = {
  async list<T = CustomResource>(plural: string): Promise<CustomResourceList<T>> {
    return (await customObjects.listNamespacedCustomObject({
      group: GROUP,
      version: VERSION,
      namespace: ns(),
      plural,
    })) as CustomResourceList<T>;
  },

  async get<T = CustomResource>(plural: string, name: string): Promise<T> {
    return (await customObjects.getNamespacedCustomObject({
      group: GROUP,
      version: VERSION,
      namespace: ns(),
      plural,
      name,
    })) as T;
  },

  async create<T = CustomResource>(plural: string, body: CustomResource): Promise<T> {
    return (await customObjects.createNamespacedCustomObject({
      group: GROUP,
      version: VERSION,
      namespace: ns(),
      plural,
      body,
    })) as T;
  },

  async delete(plural: string, name: string): Promise<unknown> {
    return await customObjects.deleteNamespacedCustomObject({
      group: GROUP,
      version: VERSION,
      namespace: ns(),
      plural,
      name,
    });
  },

  /** JSON merge patch (spec/annotation 일부 갱신용: BSL 기본 설정, 스케줄 pause 등). */
  async mergePatch<T = CustomResource>(
    plural: string,
    name: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    return (await customObjects.patchNamespacedCustomObject(
      { group: GROUP, version: VERSION, namespace: ns(), plural, name, body },
      k8s.setHeaderOptions('Content-Type', k8s.PatchStrategy.MergePatch),
    )) as T;
  },
};

/** velero CR 의 표준 apiVersion 문자열. */
export const API_VERSION = `${GROUP}/${VERSION}`;
