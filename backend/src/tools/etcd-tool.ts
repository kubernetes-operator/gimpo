/**
 * gimpo-etcd — etcd 스냅샷 백업 / 복원 연습 도구 (CronJob·Job 안에서 실행).
 *
 *   node backend/dist/tools/etcd-tool.js snapshot   # 스냅샷 → 무결성 확인 → S3 업로드 → 보관 정리
 *   node backend/dist/tools/etcd-tool.js drill      # 최신(또는 지정) 스냅샷을 임시 etcd 에 복원해 검증
 *
 * etcd 는 Kubespray systemd(host) 방식이다. 노드에 설치된 etcdctl/etcdutl/etcd 바이너리와
 * /etc/etcd.env 를 읽기 전용으로 마운트해 그대로 쓰므로 etcd 버전이 항상 일치한다.
 * 결과는 마지막 줄에 `GIMPO-ETCD-RESULT {json}` / `GIMPO-ETCD-DRILL {json}` 으로 출력하고,
 * 대시보드가 Job 로그에서 읽어 이력으로 보관한다. 자격 증명·인증서 내용은 출력하지 않는다.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { S3Client, readCredentialsFile, type S3Object } from './s3';

export const RESULT_MARK = 'GIMPO-ETCD-RESULT';
export const DRILL_MARK = 'GIMPO-ETCD-DRILL';

const env = (k: string, d = '') => process.env[k] ?? d;
const BIN = env('ETCD_BIN_DIR', '/host-bin');
const CERTS = env('ETCD_CERT_DIR', '/etcd-ssl');
const ENV_FILE = env('ETCD_ENV_FILE', '/host-etc/etcd.env');
const WORK = env('WORK_DIR', '/work');
const NODE = env('NODE_NAME', '');
const BUCKET = env('S3_BUCKET', 'etcd-snapshots');
const PREFIX = 'snapshots/';
const RETENTION_DAYS = Number(env('RETENTION_DAYS', '7'));
const KEEP_MIN = Number(env('KEEP_MIN', '3'));

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

function kst(d = new Date()) {
  const f = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(d);
  return { human: `${f} KST`, compact: f.replace(/[-:]/g, '').replace(' ', '-') };
}

function run(bin: string, args: string[], timeoutMs = 120_000, extraEnv: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ETCDCTL_API: '3', ...extraEnv } },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`${path.basename(bin)} ${args[0] ?? ''} 실패: ${(stderr || err.message).trim().slice(0, 500)}`));
        else resolve(stdout);
      },
    );
  });
}

/** etcd JSON 출력의 64비트 정수(멤버 ID 등)가 JS 숫자로 바뀌며 깨지지 않게 문자열로 감싼다. */
function parseEtcdJson<T>(s: string): T {
  return JSON.parse(s.replace(/"(ID|id|cluster_id|member_id|leader|Leader)":\s*(\d{15,})/g, '"$1":"$2"')) as T;
}

/** `etcdctl get ... --count-only -w fields` 출력에서 "Count" 값을 읽는다(etcd 3.5: count-only 는 fields 출력 전용). */
async function countKeys(etcdctl: string, keyArgs: string[], connArgs: string[]): Promise<number> {
  const out = await run(etcdctl, ['get', ...keyArgs, '--count-only', '-w', 'fields', ...connArgs]);
  const m = /"Count"\s*:\s*(\d+)/.exec(out);
  if (!m) throw new Error('키 개수를 읽지 못했습니다');
  return Number(m[1]);
}

const toHex = (v: unknown) => (typeof v === 'string' && /^\d+$/.test(v) ? BigInt(v).toString(16) : String(v ?? ''));

function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

function s3(): S3Client {
  const credFile = env('S3_CREDENTIALS_FILE', '/creds/cloud');
  const { accessKey, secretKey } = readCredentialsFile(credFile, env('S3_PROFILE', 'default'));
  const endpoint = env('S3_ENDPOINT');
  if (!endpoint) throw new Error('S3_ENDPOINT 가 설정되지 않았습니다');
  return new S3Client({ endpoint, region: env('S3_REGION', 'us-east-1'), accessKey, secretKey });
}

/** /etc/etcd.env (Kubespray) 에서 복원 절차에 필요한 비밀이 아닌 값만 읽는다. */
export function readEtcdEnv(file = ENV_FILE): Record<string, string> {
  const keep = [
    'ETCD_NAME', 'ETCD_DATA_DIR', 'ETCD_INITIAL_CLUSTER', 'ETCD_INITIAL_CLUSTER_TOKEN',
    'ETCD_INITIAL_ADVERTISE_PEER_URLS', 'ETCD_ADVERTISE_CLIENT_URLS', 'ETCD_LISTEN_CLIENT_URLS',
    'ETCD_LISTEN_PEER_URLS', 'ETCD_QUOTA_BACKEND_BYTES', 'ETCD_SNAPSHOT_COUNT', 'ETCD_VERSION',
  ];
  const out: Record<string, string> = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && keep.includes(m[1])) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

function clientCerts() {
  const tries = [
    [`admin-${NODE}.pem`, `admin-${NODE}-key.pem`],
    [`node-${NODE}.pem`, `node-${NODE}-key.pem`],
    [`member-${NODE}.pem`, `member-${NODE}-key.pem`],
  ];
  for (const [c, k] of tries) {
    if (fs.existsSync(path.join(CERTS, c)) && fs.existsSync(path.join(CERTS, k))) {
      return { cacert: path.join(CERTS, 'ca.pem'), cert: path.join(CERTS, c), key: path.join(CERTS, k), kind: c.split('-')[0] };
    }
  }
  throw new Error(`etcd 클라이언트 인증서를 찾지 못했습니다(${CERTS}, 노드 ${NODE})`);
}

interface Member { id: string; name: string; peerURLs: string[]; clientURLs: string[] }
interface EndpointStat { endpoint: string; memberId: string; version: string; dbSize: number; leader: boolean; raftTerm: number; raftIndex: number; revision: number; errors: string[] }

export interface SnapshotResult {
  kind: 'snapshot';
  status: 'success' | 'failed';
  name?: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  node: string;
  endpoint?: string;
  certKind?: string;
  etcdVersion?: string;
  sizeBytes?: number;
  sha256?: string;
  revision?: number;
  hash?: number;
  totalKey?: number;
  liveNamespaces?: number;
  members?: Member[];
  endpoints?: EndpointStat[];
  cluster?: Record<string, string>;
  s3?: { endpoint: string; bucket: string; key: string; metaKey: string };
  retention?: { days: number; keepMin: number; deleted: string[] };
  inventory?: { count: number; totalBytes: number; oldest?: string; newest?: string };
  error?: string;
}

async function snapshot(): Promise<SnapshotResult> {
  const t0 = Date.now();
  const stamp = kst();
  const res: SnapshotResult = { kind: 'snapshot', status: 'failed', startedAt: new Date(t0).toISOString(), node: NODE };
  try {
    if (!NODE) throw new Error('NODE_NAME 이 비어 있습니다');
    const cluster = readEtcdEnv();
    res.cluster = cluster;
    const endpoint = env('ETCD_ENDPOINT') || (cluster.ETCD_ADVERTISE_CLIENT_URLS ?? '').split(',')[0].trim();
    if (!endpoint) throw new Error('etcd 접속 주소를 알 수 없습니다(ETCD_ADVERTISE_CLIENT_URLS)');
    res.endpoint = endpoint;
    const c = clientCerts();
    res.certKind = c.kind;
    const etcdctl = path.join(BIN, 'etcdctl');
    const etcdutl = path.join(BIN, 'etcdutl');
    const tls = [`--cacert=${c.cacert}`, `--cert=${c.cert}`, `--key=${c.key}`, '--dial-timeout=10s', '--command-timeout=60s'];

    log('클러스터 멤버·상태 조회');
    const ml = parseEtcdJson<{ members?: Array<{ ID: string; name: string; peerURLs?: string[]; clientURLs?: string[] }> }>(
      await run(etcdctl, ['member', 'list', '-w', 'json', `--endpoints=${endpoint}`, ...tls]),
    );
    res.members = (ml.members ?? []).map((m) => ({ id: toHex(m.ID), name: m.name, peerURLs: m.peerURLs ?? [], clientURLs: m.clientURLs ?? [] }));
    try {
      const st = parseEtcdJson<Array<{ Endpoint: string; Status: { header?: { member_id?: string; revision?: number }; version?: string; dbSize?: number; leader?: string; raftTerm?: number; raftIndex?: number; errors?: string[] } }>>(
        await run(etcdctl, ['endpoint', 'status', '--cluster', '-w', 'json', `--endpoints=${endpoint}`, ...tls]),
      );
      res.endpoints = st.map((e) => ({
        endpoint: e.Endpoint,
        memberId: toHex(e.Status.header?.member_id),
        version: e.Status.version ?? '',
        dbSize: Number(e.Status.dbSize ?? 0),
        leader: toHex(e.Status.leader) === toHex(e.Status.header?.member_id),
        raftTerm: Number(e.Status.raftTerm ?? 0),
        raftIndex: Number(e.Status.raftIndex ?? 0),
        revision: Number(e.Status.header?.revision ?? 0),
        errors: e.Status.errors ?? [],
      }));
      res.etcdVersion = res.endpoints[0]?.version;
    } catch (e) {
      log('경고: 일부 멤버 상태 조회 실패 —', (e as Error).message);
    }

    res.liveNamespaces = await countKeys(etcdctl, ['/registry/namespaces/', '--prefix'], [`--endpoints=${endpoint}`, ...tls]);

    const name = `etcd-${stamp.compact}-${NODE}`;
    res.name = name;
    fs.mkdirSync(WORK, { recursive: true });
    const file = path.join(WORK, `${name}.db`);
    log(`스냅샷 저장: ${endpoint} → ${file}`);
    await run(etcdctl, ['snapshot', 'save', file, `--endpoints=${endpoint}`, ...tls], 15 * 60_000);

    log('스냅샷 무결성 확인');
    let statusOut: string;
    try {
      statusOut = await run(etcdutl, ['snapshot', 'status', file, '-w', 'json']);
    } catch {
      statusOut = await run(etcdctl, ['snapshot', 'status', file, '-w', 'json']);
    }
    const ss = JSON.parse(statusOut) as { hash: number; revision: number; totalKey: number; totalSize: number; version?: string };
    res.hash = ss.hash;
    res.revision = ss.revision;
    res.totalKey = ss.totalKey;
    res.sizeBytes = fs.statSync(file).size;
    res.sha256 = await sha256File(file);
    if (!res.revision || !res.totalKey) throw new Error('스냅샷 상태가 비정상입니다(revision/totalKey 0)');

    const client = s3();
    const created = await client.ensureBucket(BUCKET);
    if (created === 'created') log(`버킷 생성: ${BUCKET}`);
    const key = `${PREFIX}${name}.db`;
    const metaKey = `${PREFIX}${name}.json`;
    log(`업로드: s3://${BUCKET}/${key} (${res.sizeBytes} bytes)`);
    await client.putFile(BUCKET, key, file, res.sha256);
    res.s3 = { endpoint: env('S3_ENDPOINT'), bucket: BUCKET, key, metaKey };
    fs.unlinkSync(file);

    // 보관 정리: RETENTION_DAYS 보다 오래된 스냅샷 삭제(최신 KEEP_MIN 개는 항상 보관)
    const objs = await client.list(BUCKET, PREFIX);
    const dbs = objs.filter((o) => o.key.endsWith('.db')).sort((a, b) => b.lastModified.localeCompare(a.lastModified));
    const cutoff = Date.now() - RETENTION_DAYS * 86_400_000;
    const deleted: string[] = [];
    dbs.forEach((o, i) => {
      if (i >= KEEP_MIN && new Date(o.lastModified).getTime() < cutoff) deleted.push(o.key);
    });
    for (const k of deleted) {
      await client.delete(BUCKET, k);
      await client.delete(BUCKET, k.replace(/\.db$/, '.json'));
    }
    res.retention = { days: RETENTION_DAYS, keepMin: KEEP_MIN, deleted: deleted.map((k) => path.basename(k, '.db')) };
    const remain = dbs.filter((o) => !deleted.includes(o.key));
    res.inventory = {
      count: remain.length,
      totalBytes: remain.reduce((s, o) => s + o.size, 0),
      newest: remain[0]?.lastModified,
      oldest: remain[remain.length - 1]?.lastModified,
    };
    res.status = 'success';
    res.finishedAt = new Date().toISOString();
    res.durationMs = Date.now() - t0;
    // 메타데이터는 마지막에 올린다(메타가 있으면 스냅샷이 완전히 올라간 것)
    await client.putText(BUCKET, metaKey, JSON.stringify(res, null, 2));
  } catch (e) {
    res.error = (e as Error).message;
    res.finishedAt = new Date().toISOString();
    res.durationMs = Date.now() - t0;
  }
  return res;
}

export interface DrillCheck { name: string; ok: boolean; level: 'required' | 'info'; detail: string }
export interface DrillResult {
  kind: 'drill';
  status: 'success' | 'failed';
  snapshot?: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  node: string;
  sizeBytes?: number;
  checks: DrillCheck[];
  error?: string;
}

async function waitHealthy(etcdctl: string, ep: string, proc: ChildProcess, timeoutMs: number) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (proc.exitCode !== null) throw new Error(`임시 etcd 가 종료됨(code ${proc.exitCode})`);
    try {
      await run(etcdctl, ['endpoint', 'health', `--endpoints=${ep}`, '--dial-timeout=2s', '--command-timeout=3s'], 8000);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error('임시 etcd 가 제한 시간 안에 정상 상태가 되지 않음');
}

async function drill(): Promise<DrillResult> {
  const t0 = Date.now();
  const res: DrillResult = { kind: 'drill', status: 'failed', startedAt: new Date(t0).toISOString(), node: NODE, checks: [] };
  const check = (name: string, ok: boolean, detail: string, level: DrillCheck['level'] = 'required') =>
    res.checks.push({ name, ok, level, detail });
  let proc: ChildProcess | undefined;
  const dir = path.join(WORK, 'drill');
  try {
    const etcdctl = path.join(BIN, 'etcdctl');
    const etcdutl = path.join(BIN, 'etcdutl');
    const etcd = path.join(BIN, 'etcd');
    const client = s3();
    const objs = await client.list(BUCKET, PREFIX);
    const wanted = env('SNAPSHOT_NAME');
    const metas = objs.filter((o: S3Object) => o.key.endsWith('.json')).sort((a, b) => b.lastModified.localeCompare(a.lastModified));
    const metaObj = wanted ? metas.find((o) => o.key === `${PREFIX}${wanted}.json`) : metas[0];
    if (!metaObj) throw new Error(wanted ? `스냅샷 ${wanted} 을(를) 찾지 못했습니다` : '저장된 스냅샷이 없습니다');
    const meta = JSON.parse(await client.getText(BUCKET, metaObj.key)) as SnapshotResult;
    res.snapshot = meta.name;
    log(`복원 연습 대상: ${meta.name}`);

    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'snap.db');
    await client.getFile(BUCKET, meta.s3!.key, file);
    res.sizeBytes = fs.statSync(file).size;
    const sha = await sha256File(file);
    check('다운로드 무결성(sha256)', sha === meta.sha256, sha === meta.sha256 ? '원본과 일치' : `불일치 ${sha.slice(0, 12)} ≠ ${String(meta.sha256).slice(0, 12)}`);

    // etcdutl 이 없는 오래된 설치본이면 etcdctl(3.5 에서 deprecated 지만 동작)로 대체한다
    const util = fs.existsSync(etcdutl) ? etcdutl : etcdctl;
    const ss = JSON.parse(await run(util, ['snapshot', 'status', file, '-w', 'json'])) as { hash: number; revision: number; totalKey: number };
    check('스냅샷 해시', ss.hash === meta.hash, `hash ${ss.hash}`);

    const data = path.join(dir, 'data');
    const peer = 'http://127.0.0.1:32380';
    const ep = 'http://127.0.0.1:32379';
    await run(util, [
      'snapshot', 'restore', file, '--name', 'gimpo-drill', '--data-dir', data,
      '--initial-cluster', `gimpo-drill=${peer}`, '--initial-cluster-token', 'gimpo-drill',
      '--initial-advertise-peer-urls', peer,
    ], 10 * 60_000);
    check('etcdutl snapshot restore', true, '데이터 폴더 복원 완료');

    const out = fs.openSync(path.join(dir, 'etcd.log'), 'w');
    proc = spawn(etcd, [
      '--name', 'gimpo-drill', '--data-dir', data,
      '--listen-client-urls', ep, '--advertise-client-urls', ep,
      '--listen-peer-urls', peer, '--initial-advertise-peer-urls', peer,
      '--initial-cluster', `gimpo-drill=${peer}`,
      '--quota-backend-bytes', String(8 * 1024 * 1024 * 1024),
    ], { stdio: ['ignore', out, out] });
    await waitHealthy(etcdctl, ep, proc, 120_000);
    check('복원된 etcd 기동', true, '임시 etcd 정상(health OK)');

    const plain = [`--endpoints=${ep}`, '--dial-timeout=5s', '--command-timeout=60s'];
    const st = parseEtcdJson<Array<{ Status: { header?: { revision?: number } } }>>(await run(etcdctl, ['endpoint', 'status', '-w', 'json', ...plain]));
    const rev = Number(st[0]?.Status?.header?.revision ?? 0);
    check('리비전 일치', rev === meta.revision, `복원 ${rev} / 스냅샷 ${meta.revision}`);

    const nsCount = await countKeys(etcdctl, ['/registry/namespaces/', '--prefix'], plain);
    check(
      '네임스페이스 수',
      nsCount > 0 && (meta.liveNamespaces === undefined || nsCount === meta.liveNamespaces),
      `복원 ${nsCount} / 백업 시점 ${meta.liveNamespaces ?? '-'}`,
      'info',
    );
    const ks = await countKeys(etcdctl, ['/registry/namespaces/kube-system'], plain);
    check('핵심 키 존재(/registry/namespaces/kube-system)', ks === 1, ks === 1 ? '있음' : '없음');
    const all = await countKeys(etcdctl, ['', '--from-key'], plain);
    check('전체 키 수', all > 0, `${all} 개`, 'info');

    res.status = res.checks.every((c) => c.ok || c.level === 'info') ? 'success' : 'failed';
    if (res.status === 'failed') res.error = res.checks.filter((c) => !c.ok && c.level === 'required').map((c) => c.name).join(', ') + ' 실패';
  } catch (e) {
    res.error = (e as Error).message;
  } finally {
    if (proc && proc.exitCode === null) {
      proc.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 1500));
      if (proc.exitCode === null) proc.kill('SIGKILL');
    }
    fs.rmSync(dir, { recursive: true, force: true });
    res.finishedAt = new Date().toISOString();
    res.durationMs = Date.now() - t0;
  }
  return res;
}

async function main() {
  const cmd = process.argv[2];
  if (cmd === 'snapshot') {
    const r = await snapshot();
    log(r.status === 'success' ? `완료: ${r.name}` : `실패: ${r.error}`);
    console.log(`${RESULT_MARK} ${JSON.stringify(r)}`);
    process.exit(r.status === 'success' ? 0 : 1);
  } else if (cmd === 'drill') {
    const r = await drill();
    for (const c of r.checks) log(`${c.ok ? '✔' : c.level === 'info' ? '△' : '✘'} ${c.name}: ${c.detail}`);
    log(r.status === 'success' ? `복원 연습 성공: ${r.snapshot}` : `복원 연습 실패: ${r.error}`);
    console.log(`${DRILL_MARK} ${JSON.stringify(r)}`);
    process.exit(r.status === 'success' ? 0 : 1);
  } else {
    console.error('사용법: etcd-tool.js snapshot | drill');
    process.exit(2);
  }
}

if (require.main === module) void main();
