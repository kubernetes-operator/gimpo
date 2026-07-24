import axios from 'axios';
import { ElMessage } from 'element-plus';

export const http = axios.create({ baseURL: '/api', timeout: 60000 });

http.interceptors.response.use(
  (res) => res,
  (err) => {
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

// ─── API 래퍼 ──────────────────────────────────────────────────────────
export const api = {
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
  listSchedules: () => http.get<CR[]>('/schedules').then((r) => r.data),
  getSchedule: (n: string) => http.get<CR>(`/schedules/${n}`).then((r) => r.data),
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
};
