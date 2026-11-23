/**
 * 최소 S3 클라이언트 (AWS Signature V4, path-style) — 외부 의존성 없이 Node 내장 모듈만 사용.
 * etcd 스냅샷을 SeaweedFS/MinIO 등 S3 호환 저장소에 올리고·내려받고·목록·삭제하는 데 쓴다.
 * 자격 증명 값은 어떤 경우에도 로그나 오류 메시지에 포함하지 않는다.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

export interface S3Config {
  endpoint: string; // 예: http://192.168.78.101:8333
  region: string;
  accessKey: string;
  secretKey: string;
}

export interface S3Object {
  key: string;
  size: number;
  lastModified: string;
}

const EMPTY_SHA = crypto.createHash('sha256').update('').digest('hex');
const sha256hex = (v: string | Buffer) => crypto.createHash('sha256').update(v).digest('hex');
const hmac = (k: crypto.BinaryLike, v: string) => crypto.createHmac('sha256', k).update(v).digest();
const rfc3986 = (s: string) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** AWS credentials 파일 형식(Velero 시크릿의 `cloud` 키)을 읽는다. */
export function readCredentialsFile(file: string, profile = 'default'): { accessKey: string; secretKey: string } {
  const text = fs.readFileSync(file, 'utf8');
  let current = 'default';
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const sec = /^\[(.+)\]$/.exec(line);
    if (sec) {
      current = sec[1].trim();
      continue;
    }
    if (current !== profile) continue;
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  if (!out.aws_access_key_id || !out.aws_secret_access_key) {
    throw new Error(`자격 증명 파일에 '${profile}' 프로필의 access key 가 없습니다`);
  }
  return { accessKey: out.aws_access_key_id, secretKey: out.aws_secret_access_key };
}

export class S3Client {
  constructor(private cfg: S3Config) {}

  private sign(method: string, url: URL, payloadHash: string, extra: Record<string, string> = {}) {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const date = amzDate.slice(0, 8);
    const headers: Record<string, string> = {
      host: url.host,
      'x-amz-date': amzDate,
      'x-amz-content-sha256': payloadHash,
      ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k.toLowerCase(), v])),
    };
    const signed = Object.keys(headers).sort();
    const canonicalHeaders = signed.map((k) => `${k}:${String(headers[k]).trim()}\n`).join('');
    const query = [...url.searchParams.entries()]
      .map(([k, v]) => [rfc3986(k), rfc3986(v)])
      .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
      .map(([k, v]) => `${k}=${v}`)
      .join('&');
    const canonical = [method, url.pathname, query, canonicalHeaders, signed.join(';'), payloadHash].join('\n');
    const scope = `${date}/${this.cfg.region}/s3/aws4_request`;
    const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonical)].join('\n');
    const kSigning = hmac(hmac(hmac(hmac(`AWS4${this.cfg.secretKey}`, date), this.cfg.region), 's3'), 'aws4_request');
    const signature = crypto.createHmac('sha256', kSigning).update(toSign).digest('hex');
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${this.cfg.accessKey}/${scope}, SignedHeaders=${signed.join(';')}, Signature=${signature}`;
    return headers;
  }

  private url(bucket: string, key = '', query: Record<string, string> = {}) {
    const base = this.cfg.endpoint.replace(/\/$/, '');
    const path = `/${rfc3986(bucket)}${key ? '/' + key.split('/').map(rfc3986).join('/') : ''}`;
    const u = new URL(base + path);
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
    return u;
  }

  private request(
    method: string,
    url: URL,
    opts: { payloadHash?: string; body?: Buffer; file?: string; size?: number; out?: string; headers?: Record<string, string> } = {},
  ): Promise<{ status: number; body: string }> {
    const payloadHash = opts.payloadHash ?? (opts.body ? sha256hex(opts.body) : EMPTY_SHA);
    const extra: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.body) extra['content-length'] = String(opts.body.length);
    if (opts.file) extra['content-length'] = String(opts.size ?? fs.statSync(opts.file).size);
    const headers = this.sign(method, url, payloadHash, extra);
    const lib = url.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const req = lib.request(url, { method, headers, timeout: 15 * 60_000 }, (res) => {
        const status = res.statusCode ?? 0;
        if (opts.out && status >= 200 && status < 300) {
          const ws = fs.createWriteStream(opts.out);
          res.pipe(ws);
          ws.on('finish', () => resolve({ status, body: '' }));
          ws.on('error', reject);
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c as Buffer));
        res.on('end', () => resolve({ status, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new Error(`S3 요청 시간 초과: ${method} ${url.pathname}`)));
      req.on('error', reject);
      if (opts.file) fs.createReadStream(opts.file).on('error', reject).pipe(req);
      else req.end(opts.body);
    });
  }

  private static fail(op: string, r: { status: number; body: string }): never {
    const code = /<Code>([^<]+)<\/Code>/.exec(r.body)?.[1] ?? '';
    const msg = /<Message>([^<]+)<\/Message>/.exec(r.body)?.[1] ?? r.body.slice(0, 200);
    throw new Error(`S3 ${op} 실패 (HTTP ${r.status}${code ? ` ${code}` : ''}): ${msg}`);
  }

  /** 버킷이 없으면 만든다(이미 있으면 그대로). */
  async ensureBucket(bucket: string): Promise<'created' | 'exists'> {
    const head = await this.request('HEAD', this.url(bucket));
    if (head.status === 200) return 'exists';
    const r = await this.request('PUT', this.url(bucket));
    if (r.status === 200) return 'created';
    if (r.status === 409 && /BucketAlreadyOwnedByYou|BucketAlreadyExists/.test(r.body)) return 'exists';
    return S3Client.fail('버킷 생성', r);
  }

  /** 파일 업로드 — 내용의 sha256 을 서명에 넣어 저장소 측에서도 무결성을 검증하게 한다. */
  async putFile(bucket: string, key: string, file: string, sha256: string, contentType = 'application/octet-stream') {
    const r = await this.request('PUT', this.url(bucket, key), {
      file,
      payloadHash: sha256,
      headers: { 'content-type': contentType },
    });
    if (r.status !== 200) S3Client.fail(`업로드 ${key}`, r);
  }

  async putText(bucket: string, key: string, text: string, contentType = 'application/json') {
    const r = await this.request('PUT', this.url(bucket, key), {
      body: Buffer.from(text, 'utf8'),
      headers: { 'content-type': contentType },
    });
    if (r.status !== 200) S3Client.fail(`업로드 ${key}`, r);
  }

  async getFile(bucket: string, key: string, out: string) {
    const r = await this.request('GET', this.url(bucket, key), { out });
    if (r.status !== 200) S3Client.fail(`다운로드 ${key}`, r);
  }

  async getText(bucket: string, key: string): Promise<string> {
    const r = await this.request('GET', this.url(bucket, key));
    if (r.status !== 200) S3Client.fail(`다운로드 ${key}`, r);
    return r.body;
  }

  async list(bucket: string, prefix = ''): Promise<S3Object[]> {
    const out: S3Object[] = [];
    let token: string | undefined;
    for (let page = 0; page < 1000; page++) {
      const q: Record<string, string> = { 'list-type': '2', prefix };
      if (token) q['continuation-token'] = token;
      const r = await this.request('GET', this.url(bucket, '', q));
      if (r.status !== 200) S3Client.fail('목록 조회', r);
      for (const m of r.body.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const c = m[1];
        out.push({
          key: decodeXml(/<Key>([\s\S]*?)<\/Key>/.exec(c)?.[1] ?? ''),
          size: Number(/<Size>(\d+)<\/Size>/.exec(c)?.[1] ?? 0),
          lastModified: /<LastModified>([^<]+)<\/LastModified>/.exec(c)?.[1] ?? '',
        });
      }
      const truncated = /<IsTruncated>true<\/IsTruncated>/.test(r.body);
      token = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(r.body)?.[1];
      if (!truncated || !token) break;
    }
    return out;
  }

  async delete(bucket: string, key: string) {
    const r = await this.request('DELETE', this.url(bucket, key));
    if (r.status !== 204 && r.status !== 200 && r.status !== 404) S3Client.fail(`삭제 ${key}`, r);
  }
}

function decodeXml(s: string) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
