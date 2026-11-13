/**
 * Velero v1.18 CRD 스펙 타입 (대시보드에서 다루는 필드 위주).
 * 전체 스키마가 아니라 UI 가 읽고/쓰는 필드를 커버한다. Record<string, unknown> 인덱스로
 * 서버가 추가한 필드도 그대로 통과시킨다.
 */

export interface K8sMeta {
  name?: string;
  namespace?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  creationTimestamp?: string;
  uid?: string;
  resourceVersion?: string;
}

export interface CustomResource<Spec = unknown, Status = unknown> {
  apiVersion?: string;
  kind?: string;
  metadata: K8sMeta;
  spec?: Spec;
  status?: Status;
}

export interface CustomResourceList<T = CustomResource> {
  apiVersion?: string;
  kind?: string;
  metadata?: { resourceVersion?: string; continue?: string };
  items: T[];
}

export interface LabelSelector {
  matchLabels?: Record<string, string>;
  matchExpressions?: Array<{ key: string; operator: string; values?: string[] }>;
}

/** Backup / Schedule.template 이 공유하는 스펙. */
export interface BackupSpec {
  includedNamespaces?: string[];
  excludedNamespaces?: string[];
  includedResources?: string[];
  excludedResources?: string[];
  includedClusterScopedResources?: string[];
  excludedClusterScopedResources?: string[];
  includedNamespaceScopedResources?: string[];
  excludedNamespaceScopedResources?: string[];
  includeClusterResources?: boolean | null;
  labelSelector?: LabelSelector;
  orLabelSelectors?: LabelSelector[];
  snapshotVolumes?: boolean | null;
  defaultVolumesToFsBackup?: boolean | null;
  snapshotMoveData?: boolean | null;
  datamover?: string;
  storageLocation?: string;
  volumeSnapshotLocations?: string[];
  ttl?: string; // 예: "720h0m0s"
  csiSnapshotTimeout?: string;
  itemOperationTimeout?: string;
  orderedResources?: Record<string, string>;
  hooks?: {
    resources?: Array<{
      name: string;
      includedNamespaces?: string[];
      excludedNamespaces?: string[];
      includedResources?: string[];
      excludedResources?: string[];
      labelSelector?: LabelSelector;
      pre?: BackupHook[];
      post?: BackupHook[];
    }>;
  };
  [k: string]: unknown;
}

export interface BackupHook {
  exec: {
    container?: string;
    command: string[];
    onError?: 'Fail' | 'Continue';
    timeout?: string;
  };
}

export interface BackupStatus {
  phase?: string;
  startTimestamp?: string;
  completionTimestamp?: string;
  expiration?: string;
  errors?: number;
  warnings?: number;
  version?: number;
  formatVersion?: string;
  progress?: { totalItems?: number; itemsBackedUp?: number };
  [k: string]: unknown;
}

export type Backup = CustomResource<BackupSpec, BackupStatus>;

export interface RestoreSpec {
  backupName?: string;
  scheduleName?: string;
  includedNamespaces?: string[];
  excludedNamespaces?: string[];
  includedResources?: string[];
  excludedResources?: string[];
  namespaceMapping?: Record<string, string>;
  labelSelector?: LabelSelector;
  orLabelSelectors?: LabelSelector[];
  restorePVs?: boolean | null;
  preserveNodePorts?: boolean | null;
  includeClusterResources?: boolean | null;
  existingResourcePolicy?: 'none' | 'update' | string;
  restoreStatus?: { includedResources?: string[]; excludedResources?: string[] };
  itemOperationTimeout?: string;
  hooks?: unknown;
  [k: string]: unknown;
}

export interface RestoreStatus {
  phase?: string;
  startTimestamp?: string;
  completionTimestamp?: string;
  errors?: number;
  warnings?: number;
  progress?: { totalItems?: number; itemsRestored?: number };
  [k: string]: unknown;
}

export type Restore = CustomResource<RestoreSpec, RestoreStatus>;

export interface ScheduleSpec {
  schedule: string; // cron
  template: BackupSpec;
  useOwnerReferencesInBackup?: boolean;
  paused?: boolean;
  skipImmediately?: boolean;
  [k: string]: unknown;
}

export type Schedule = CustomResource<ScheduleSpec>;

/** DownloadRequest target.kind 값. velero apis/v1/download_request_types 기준. */
export type DownloadKind =
  | 'BackupLog'
  | 'BackupContents'
  | 'BackupVolumeSnapshots'
  | 'BackupItemOperations'
  | 'BackupResourceList'
  | 'BackupResults'
  | 'RestoreLog'
  | 'RestoreResults'
  | 'RestoreResourceList'
  | 'RestoreItemOperations'
  | 'CSIBackupVolumeSnapshots'
  | 'CSIBackupVolumeSnapshotContents';
