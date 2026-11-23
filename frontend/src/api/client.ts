import axios from 'axios';
import { ElMessage } from 'element-plus';

// base(/velero/) 아래에서 서빙되면 API 도 /velero/api 로 호출해야 게이트웨이가 매칭한다.
// BASE_URL 은 끝에 슬래시가 있으므로 그대로 'api' 를 붙인다. (dev 는 '/' + 'api' = '/api')
export const http = axios.create({ baseURL: `${import.meta.env.BASE_URL}api`, timeout: 60000 });

http.interceptors.response.use(
  (res) => res,
  (err) => {
    if(err?.response?.status===401){window.location.assign(`${import.meta.env.BASE_URL}login`);return Promise.reject(err);}
    const msg = err?.response?.data?.error ?? err?.message ?? '요청 실패';
    ElMessage.error(String(msg));
    return Promise.reject(err);
  },
);

// ─── 타입 (백엔드 응답 형태의 최소 표현) ───────────────────────────────
export interface K8sMeta {
  name?: string;
  namespace?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  creationTimestamp?: string;
  uid?: string;
}
export interface CR<S = any, T = any> {
  apiVersion?: string;
  kind?: string;
  metadata: K8sMeta;
  spec?: S;
  status?: T;
}
export interface NamespaceInfo {
  name: string;
  status?: string;
  labels?: Record<string, string>;
  creationTimestamp?: string;
}
export interface ApiResource {
  name: string;
  namespaced: boolean;
  kind: string;
  group: string;
}
export interface ServerStatus {
  phase?: string;
  serverVersion?: string;
  plugins?: Array<{ name: string; kind: string }>;
}

export interface ScheduleCR extends CR {
  gimpo?: {
    displayName: string;
    description: string;
    previousNames: string[];
    helmManaged: boolean;
    tz: string;
    expr: string;
    nextRuns: string[];
    prevExpected?: string;
  };
}
export interface RenameResult {
  message: string;
  oldBackups: { policy: string; count: number; deleteRequested: number };
  helmWarning?: string;
}

export type Level = 'ok' | 'warn' | 'fail';
export interface HealthCheck {
  id: string;
  category: string;
  name: string;
  status: Level;
  message: string;
}
export interface ScheduleHealth {
  name: string;
  displayName: string;
  schedule: string;
  paused: boolean;
  storageLocation?: string;
  ttl?: string;
  nextRun?: string;
  lastBackup?: { name: string; phase?: string; startedAt?: string; completedAt?: string; errors?: number; warnings?: number };
  lastSuccessAt?: string;
  status: Level;
  message: string;
}
export interface HealthReport {
  overall: Level;
  checkedAt: string;
  counts: Record<Level, number>;
  checks: HealthCheck[];
  schedules: ScheduleHealth[];
}

export interface RestoreTestConfig {
  enabled: boolean;
  schedule: string;
  storageLocation: string;
  timeoutMinutes: number;
  backupTtl: string;
  keepRestores: number;
}
export interface RestoreTestStep {
  key: string;
  name: string;
  status: 'pending' | 'running' | 'success' | 'failed' | 'skipped';
  startedAt?: string;
  finishedAt?: string;
  message?: string;
}
export interface RestoreTestRun {
  id: string;
  trigger: 'schedule' | 'manual';
  status: 'running' | 'success' | 'failed' | 'aborted';
  startedAt: string;
  finishedAt?: string;
  durationSec?: number;
  storageLocation: string;
  backupName?: string;
  restoreName?: string;
  marker?: { content: string; blobSha?: string; restoredBlobSha?: string };
  steps: RestoreTestStep[];
  error?: string;
}
export interface RestoreTestState {
  config: RestoreTestConfig;
  namespace: string;
  nextRuns: string[];
  running: RestoreTestRun | null;
  history: RestoreTestRun[];
}

// ─── etcd ──────────────────────────────────────────────────────────────
export interface EtcdMember { id: string; name: string; peerURLs: string[]; clientURLs: string[] }
export interface EtcdEndpoint { endpoint: string; memberId: string; version: string; dbSize: number; leader: boolean; raftTerm: number; raftIndex: number; revision: number; errors: string[] }
export interface EtcdSnapshot {
  kind: 'snapshot'; status: 'success' | 'failed'; name?: string; jobName: string; trigger: 'schedule' | 'manual';
  startedAt: string; finishedAt?: string; durationMs?: number; node: string; etcdVersion?: string;
  sizeBytes?: number; sha256?: string; revision?: number; totalKey?: number; liveNamespaces?: number;
  members?: EtcdMember[]; endpoints?: EtcdEndpoint[]; s3?: { endpoint: string; bucket: string; key: string };
  retention?: { days: number; keepMin: number; deleted: string[] };
  inventory?: { count: number; totalBytes: number; oldest?: string; newest?: string }; error?: string;
}
export interface EtcdDrill {
  kind: 'drill'; status: 'success' | 'failed'; snapshot?: string; jobName: string; trigger: 'schedule' | 'manual';
  startedAt: string; finishedAt?: string; durationMs?: number; node: string; sizeBytes?: number;
  checks: Array<{ name: string; ok: boolean; level: 'required' | 'info'; detail: string }>; error?: string;
}
export interface EtcdCron { name: string; kind: 'snapshot' | 'drill'; installed: boolean; schedule?: string; timeZone?: string; suspend?: boolean; lastScheduleTime?: string; lastSuccessfulTime?: string; nextRuns: string[] }
export interface EtcdState {
  crons: EtcdCron[];
  running: Array<{ name: string; kind?: 'snapshot' | 'drill'; trigger: string; startedAt?: string }>;
  snapshots: EtcdSnapshot[]; drills: EtcdDrill[]; latest: EtcdSnapshot | null; lastSuccess: EtcdSnapshot | null;
  members: EtcdMember[]; endpoints: EtcdEndpoint[];
  inventory: { count: number; totalBytes: number; oldest?: string; newest?: string } | null;
}
export interface EtcdRunbook {
  snapshot: string; createdAt: string; revision?: number; sha256?: string; s3Uri: string; dataDir: string; token: string;
  initialCluster: string; nodes: Array<{ name: string; host: string; peerURL: string; script: string }>; markdown: string; warnings: string[];
}

// ─── API 래퍼 ──────────────────────────────────────────────────────────
export interface OverviewSummary {backups:{total:number;completed:number;recent:CR[]};restores:{total:number;completed:number};schedules:{total:number};storage:{total:number;available:number};errors:string[];}
export const api = {
  overview:()=>http.get<OverviewSummary>('/overview').then(r=>r.data),
  overviewHealth:()=>http.get<Pick<HealthReport,'overall'|'counts'>>('/overview/health').then(r=>r.data),
  // backups
  listBackups: () => http.get<CR[]>('/backups').then((r) => r.data),
  getBackup: (n: string) => http.get<CR>(`/backups/${n}`).then((r) => r.data),
  createBackup: (body: unknown) => http.post<CR>('/backups', body).then((r) => r.data),
  deleteBackup: (n: string) => http.delete(`/backups/${n}`).then((r) => r.data),
  backupLogs: (n: string) => http.get<string>(`/backups/${n}/logs`).then((r) => r.data),
  backupResults: (n: string) => http.get(`/backups/${n}/results`).then((r) => r.data),
  backupResourceList: (n: string) => http.get(`/backups/${n}/resource-list`).then((r) => r.data),
  backupVolumeSnapshots: (n: string) =>
    http.get(`/backups/${n}/volume-snapshots`).then((r) => r.data),

  // restores
  listRestores: () => http.get<CR[]>('/restores').then((r) => r.data),
  getRestore: (n: string) => http.get<CR>(`/restores/${n}`).then((r) => r.data),
  createRestore: (body: unknown) => http.post<CR>('/restores', body).then((r) => r.data),
  deleteRestore: (n: string) => http.delete(`/restores/${n}`).then((r) => r.data),
  restoreLogs: (n: string) => http.get<string>(`/restores/${n}/logs`).then((r) => r.data),
  restoreResults: (n: string) => http.get(`/restores/${n}/results`).then((r) => r.data),

  // schedules
  listSchedules: () => http.get<ScheduleCR[]>('/schedules').then((r) => r.data),
  getSchedule: (n: string) => http.get<ScheduleCR>(`/schedules/${n}`).then((r) => r.data),
  updateSchedule: (n: string, body: unknown) =>
    http.put<ScheduleCR>(`/schedules/${n}`, body).then((r) => r.data),
  renameSchedule: (n: string, body: { newName: string; oldBackups: 'link' | 'keep' | 'delete' }) =>
    http.post<RenameResult>(`/schedules/${n}/rename`, body).then((r) => r.data),
  scheduleBackups: (n: string, previous: boolean) =>
    http.get<CR[]>(`/schedules/${n}/backups`, { params: { previous: previous ? '1' : '0' } }).then((r) => r.data),
  cronPreview: (schedule: string) =>
    http.post<{ tz: string; expr: string; nextRuns: string[] }>('/cron/preview', { schedule }).then((r) => r.data),

  // health / restore test
  healthReport: (refresh = false) =>
    http.get<HealthReport>('/health/report', { params: refresh ? { refresh: '1' } : {} }).then((r) => r.data),
  restoreTest: () => http.get<RestoreTestState>('/restore-test').then((r) => r.data),
  updateRestoreTestConfig: (body: Partial<RestoreTestConfig>) =>
    http.put<RestoreTestConfig>('/restore-test/config', body).then((r) => r.data),
  runRestoreTest: () => http.post('/restore-test/run').then((r) => r.data),
  createSchedule: (body: unknown) => http.post<CR>('/schedules', body).then((r) => r.data),
  deleteSchedule: (n: string) => http.delete(`/schedules/${n}`).then((r) => r.data),
  pauseSchedule: (n: string, paused: boolean) =>
    http.patch(`/schedules/${n}/pause`, { paused }).then((r) => r.data),
  triggerSchedule: (n: string) => http.post(`/schedules/${n}/trigger`).then((r) => r.data),

  // locations
  listBSL: () => http.get<CR[]>('/backup-storage-locations').then((r) => r.data),
  setDefaultBSL: (n: string) =>
    http.patch(`/backup-storage-locations/${n}/default`).then((r) => r.data),
  listVSL: () => http.get<CR[]>('/volume-snapshot-locations').then((r) => r.data),

  // repos / volume ops
  listBackupRepositories: () => http.get<CR[]>('/backup-repositories').then((r) => r.data),
  listPodVolumeBackups: () => http.get<CR[]>('/pod-volume-backups').then((r) => r.data),
  listPodVolumeRestores: () => http.get<CR[]>('/pod-volume-restores').then((r) => r.data),
  listDataUploads: () => http.get<CR[]>('/data-uploads').then((r) => r.data),
  listDataDownloads: () => http.get<CR[]>('/data-downloads').then((r) => r.data),

  // cluster
  listNamespaces: () => http.get<NamespaceInfo[]>('/namespaces').then((r) => r.data),
  listApiResources: () => http.get<ApiResource[]>('/api-resources').then((r) => r.data),
  serverStatus: () => http.get<ServerStatus>('/server-status').then((r) => r.data),

  // etcd
  etcd: () => http.get<EtcdState>('/etcd').then((r) => r.data),
  etcdSnapshotNow: () => http.post('/etcd/snapshot').then((r) => r.data),
  etcdDrillNow: (snapshot?: string) => http.post('/etcd/drill', snapshot ? { snapshot } : {}).then((r) => r.data),
  etcdRunbook: (snapshot?: string) =>
    http.get<EtcdRunbook>('/etcd/runbook', { params: snapshot ? { snapshot } : {} }).then((r) => r.data),
};
