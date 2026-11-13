import type { FastifyInstance } from 'fastify';
import { coreV1, rawGet } from '../k8s/client';
import { velero, PLURALS, API_VERSION } from '../k8s/velero';
import { config } from '../config';
import type { CustomResource } from '../types/velero';

interface ApiResource {
  name: string;
  namespaced: boolean;
  kind: string;
  group: string;
}

/** discovery 실패 시 사용할 최소 큐레이션 목록. */
const FALLBACK_RESOURCES: ApiResource[] = [
  { name: 'pods', namespaced: true, kind: 'Pod', group: '' },
  { name: 'services', namespaced: true, kind: 'Service', group: '' },
  { name: 'configmaps', namespaced: true, kind: 'ConfigMap', group: '' },
  { name: 'secrets', namespaced: true, kind: 'Secret', group: '' },
  { name: 'persistentvolumeclaims', namespaced: true, kind: 'PersistentVolumeClaim', group: '' },
  { name: 'persistentvolumes', namespaced: false, kind: 'PersistentVolume', group: '' },
  { name: 'serviceaccounts', namespaced: true, kind: 'ServiceAccount', group: '' },
  { name: 'deployments', namespaced: true, kind: 'Deployment', group: 'apps' },
  { name: 'statefulsets', namespaced: true, kind: 'StatefulSet', group: 'apps' },
  { name: 'daemonsets', namespaced: true, kind: 'DaemonSet', group: 'apps' },
  { name: 'replicasets', namespaced: true, kind: 'ReplicaSet', group: 'apps' },
  { name: 'ingresses', namespaced: true, kind: 'Ingress', group: 'networking.k8s.io' },
  { name: 'networkpolicies', namespaced: true, kind: 'NetworkPolicy', group: 'networking.k8s.io' },
  { name: 'roles', namespaced: true, kind: 'Role', group: 'rbac.authorization.k8s.io' },
  { name: 'rolebindings', namespaced: true, kind: 'RoleBinding', group: 'rbac.authorization.k8s.io' },
  { name: 'clusterroles', namespaced: false, kind: 'ClusterRole', group: 'rbac.authorization.k8s.io' },
  { name: 'customresourcedefinitions', namespaced: false, kind: 'CustomResourceDefinition', group: 'apiextensions.k8s.io' },
  { name: 'storageclasses', namespaced: false, kind: 'StorageClass', group: 'storage.k8s.io' },
];

let resourceCache: { at: number; data: ApiResource[] } | null = null;

export default async function clusterRoutes(app: FastifyInstance) {
  /** 네임스페이스 전체 — kube-system 등 시스템 NS 를 필터링하지 않는다(요구사항). */
  app.get('/api/namespaces', async () => {
    const res = await coreV1.listNamespace();
    return (res.items ?? []).map((n) => ({
      name: n.metadata?.name,
      status: n.status?.phase,
      labels: n.metadata?.labels ?? {},
      creationTimestamp: n.metadata?.creationTimestamp,
    }));
  });

  /** API 리소스 discovery — ResourceSelector 의 포함/제외 후보. 10분 캐시. */
  app.get('/api/api-resources', async (req) => {
    if (resourceCache && Date.now() - resourceCache.at < 10 * 60 * 1000) {
      return resourceCache.data;
    }
    try {
      const data = await discoverResources();
      resourceCache = { at: Date.now(), data };
      return data;
    } catch (err) {
      req.log.warn({ err }, 'API discovery 실패 — 폴백 목록 사용');
      return FALLBACK_RESOURCES;
    }
  });

  /** Velero 서버 버전/플러그인 — ServerStatusRequest CR. */
  app.get('/api/server-status', async () => {
    return await serverStatus();
  });
}

async function discoverResources(): Promise<ApiResource[]> {
  const byName = new Map<string, ApiResource>();
  const add = (resources: any[] | undefined, group: string) => {
    for (const r of resources ?? []) {
      if (!r.name || r.name.includes('/')) continue; // 서브리소스 제외
      const key = `${group}/${r.name}`;
      if (!byName.has(key)) {
        byName.set(key, { name: r.name, namespaced: !!r.namespaced, kind: r.kind, group });
      }
    }
  };

  const core = await rawGet('/api/v1');
  add(core.resources, '');

  const groups = await rawGet('/apis');
  // 그룹별 조회를 병렬로. 도달 불가/느린 그룹(aggregated APIService)은 개별 타임아웃 후 건너뜀.
  await Promise.allSettled(
    (groups.groups ?? []).map(async (g: any) => {
      const gv = g.preferredVersion?.groupVersion;
      if (!gv) return;
      const r = await rawGet(`/apis/${gv}`);
      add(r.resources, g.name);
    }),
  );
  return [...byName.values()].sort((a, b) =>
    (a.group + a.name).localeCompare(b.group + b.name),
  );
}

interface ServerStatusResult {
  phase?: string;
  serverVersion?: string;
  plugins?: Array<{ name: string; kind: string }>;
}

async function serverStatus(): Promise<ServerStatusResult> {
  const name = `dashboard-ssr-${Date.now()}`.slice(0, 253);
  const body: CustomResource = {
    apiVersion: API_VERSION,
    kind: 'ServerStatusRequest',
    metadata: { name, namespace: config.veleroNamespace },
    spec: {},
  };
  await velero.create(PLURALS.serverStatusRequests, body);
  try {
    const deadline = Date.now() + config.downloadTimeoutMs;
    let delay = 300;
    while (Date.now() < deadline) {
      const ssr = await velero.get<CustomResource<unknown, ServerStatusResult>>(
        PLURALS.serverStatusRequests,
        name,
      );
      if (ssr.status?.phase === 'Processed') {
        return {
          phase: ssr.status.phase,
          serverVersion: ssr.status.serverVersion,
          plugins: ssr.status.plugins ?? [],
        };
      }
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 1.5, 2000);
    }
    return { phase: 'Timeout' };
  } finally {
    velero.delete(PLURALS.serverStatusRequests, name).catch(() => undefined);
  }
}
