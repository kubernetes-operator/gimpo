import https from 'node:https';
import http from 'node:http';
import { URL } from 'node:url';
import * as k8s from '@kubernetes/client-node';

/**
 * KubeConfig 로딩: 인클러스터(SA)와 로컬(~/.kube/config)을 모두 자동 처리.
 * loadFromDefault() 는 KUBECONFIG > ~/.kube/config > in-cluster 순으로 시도한다.
 */
const kc = new k8s.KubeConfig();
kc.loadFromDefault();

export const kubeConfig = kc;
export const customObjects = kc.makeApiClient(k8s.CustomObjectsApi);
export const coreV1 = kc.makeApiClient(k8s.CoreV1Api);

/**
 * 클러스터 REST 엔드포인트로 인증된 raw GET 요청. discovery(/apis, /api/v1) 용.
 *
 * node:https 를 사용한다. client-node 의 applyToHTTPSOptions 가 채워주는 ca/cert/key/headers
 * (mTLS·토큰 인증 + 클러스터 CA 신뢰)를 그대로 쓴다. 전역 fetch(undici)는 https.Agent 를
 * 무시하고 dispatcher 를 요구해 클러스터 CA 검증에 실패하므로 사용하지 않는다.
 */
export async function rawGet(path: string, timeoutMs = 8000): Promise<any> {
  const cluster = kc.getCurrentCluster();
  if (!cluster) throw new Error('현재 kube 컨텍스트에 클러스터가 없습니다');

  const reqOpts: https.RequestOptions = {};
  await kc.applyToHTTPSOptions(reqOpts as never);

  const url = new URL(cluster.server.replace(/\/$/, '') + path);
  const lib = url.protocol === 'https:' ? https : http;

  return await new Promise((resolve, reject) => {
    const req = lib.request(
      url,
      {
        method: 'GET',
        ...reqOpts,
        timeout: timeoutMs,
        headers: { Accept: 'application/json', ...(reqOpts.headers ?? {}) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c as Buffer));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf-8');
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            reject(new Error(`${path} → ${status} ${res.statusMessage}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    // 응답 없는(도달 불가한 aggregated APIService 등) 그룹에서 무한 대기 방지
    req.on('timeout', () => req.destroy(new Error(`${path} 요청 타임아웃(${timeoutMs}ms)`)));
    req.on('error', reject);
    req.end();
  });
}

export { k8s };
