import { promisify } from 'node:util';
import zlib from 'node:zlib';
import { velero, PLURALS, API_VERSION } from './velero';
import { config } from '../config';
import type { DownloadKind, CustomResource } from '../types/velero';

const gunzip = promisify(zlib.gunzip);

interface DownloadRequestStatus {
  phase?: string;
  downloadURL?: string;
  expiration?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Velero DownloadRequest 흐름:
 *  1) DownloadRequest CR 생성 (target = {kind, name})
 *  2) status.phase=Processed & status.download(signed URL) 채워질 때까지 폴링
 *  3) signed URL 다운로드 → gzip 해제
 *  4) DownloadRequest 정리(best effort)
 *
 * 반환: 압축 해제된 원본 버퍼(대부분 텍스트/JSON). 호출부에서 text/json 으로 해석.
 */
export async function fetchDownload(kind: DownloadKind, targetName: string): Promise<Buffer> {
  // 이름 충돌을 피하기 위해 타임스탬프 접미사. (백엔드 런타임이라 Date.now 사용 가능)
  const drName = `${targetName}-${kind.toLowerCase()}-${Date.now()}`.slice(0, 253);

  const body: CustomResource = {
    apiVersion: API_VERSION,
    kind: 'DownloadRequest',
    metadata: { name: drName, namespace: config.veleroNamespace },
    spec: { target: { kind, name: targetName } },
  };

  await velero.create(PLURALS.downloadRequests, body);

  try {
    const url = await pollForUrl(drName);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`signed URL 다운로드 실패: ${res.status} ${res.statusText}`);
    const raw = Buffer.from(await res.arrayBuffer());
    return await maybeGunzip(raw);
  } finally {
    // 정리는 실패해도 무시 (TTL 로도 정리됨)
    velero.delete(PLURALS.downloadRequests, drName).catch(() => undefined);
  }
}

async function pollForUrl(drName: string): Promise<string> {
  const deadline = Date.now() + config.downloadTimeoutMs;
  let delay = 300;
  while (Date.now() < deadline) {
    const dr = await velero.get<CustomResource<unknown, DownloadRequestStatus>>(
      PLURALS.downloadRequests,
      drName,
    );
    const status = dr.status;
    if (status?.phase === 'Processed' && status.downloadURL) return status.downloadURL;
    await sleep(delay);
    delay = Math.min(delay * 1.5, 2000);
  }
  throw new Error(
    `DownloadRequest(${drName}) 가 ${config.downloadTimeoutMs}ms 안에 signed URL 을 받지 못했습니다`,
  );
}

/** gzip 매직넘버(0x1f 0x8b)면 해제, 아니면 원본 반환. */
async function maybeGunzip(buf: Buffer): Promise<Buffer> {
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    return await gunzip(buf);
  }
  return buf;
}

/** 다운로드 결과를 텍스트로. */
export async function fetchDownloadText(kind: DownloadKind, name: string): Promise<string> {
  return (await fetchDownload(kind, name)).toString('utf-8');
}

/** 다운로드 결과를 JSON 으로. 실패 시 원본 텍스트를 { raw } 로 감싼다. */
export async function fetchDownloadJson(kind: DownloadKind, name: string): Promise<unknown> {
  const text = await fetchDownloadText(kind, name);
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}
