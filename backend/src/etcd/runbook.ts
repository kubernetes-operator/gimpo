import type { SnapshotRecord } from './collector';

/**
 * etcd 롤백 절차서 생성 — 선택한 스냅샷 기록(멤버·peer URL·클러스터 토큰·데이터 폴더)으로
 * 노드별 명령을 만들어 준다. 실행은 운영자가 각 컨트롤 플레인 노드에 SSH 로 접속해 한다.
 * (롤백 중에는 apiserver 가 멈추므로 대시보드에서 버튼으로 실행할 수 없고, 해서도 안 된다.)
 */

export interface RunbookNode {
  name: string; // etcd 멤버 이름 (예: etcd1)
  host: string; // peer URL 의 호스트(IP)
  peerURL: string;
  script: string;
}

export interface Runbook {
  snapshot: string;
  createdAt: string;
  revision?: number;
  sha256?: string;
  s3Uri: string;
  dataDir: string;
  token: string;
  initialCluster: string;
  nodes: RunbookNode[];
  markdown: string;
  warnings: string[];
}

const hostOf = (u: string) => {
  try {
    return new URL(u).hostname;
  } catch {
    return u;
  }
};

export function buildRunbook(s: SnapshotRecord): Runbook {
  const warnings: string[] = [];
  const members = (s.members ?? []).filter((m) => m.name && m.peerURLs?.length).sort((a, b) => a.name.localeCompare(b.name));
  if (members.length === 0) throw new Error('이 스냅샷 기록에 멤버 정보가 없습니다(성공한 스냅샷을 선택하세요)');
  if (s.endpoints && s.endpoints.length !== members.length) {
    warnings.push(`스냅샷 당시 응답한 멤버 ${s.endpoints.length}개 / 등록 멤버 ${members.length}개 — 멤버 상태를 먼저 확인하세요`);
  }
  const dataDir = s.cluster?.ETCD_DATA_DIR || '/var/lib/etcd';
  const token = s.cluster?.ETCD_INITIAL_CLUSTER_TOKEN || 'k8s_etcd';
  const initialCluster = members.map((m) => `${m.name}=${m.peerURLs[0]}`).join(',');
  const snap = s.name!;
  const file = `/tmp/${snap}.db`;
  const stamp = '$(date +%Y%m%d-%H%M%S)';
  const s3Uri = `s3://${s.s3?.bucket ?? 'etcd-snapshots'}/${s.s3?.key ?? `snapshots/${snap}.db`}`;
  if (!s.cluster?.ETCD_INITIAL_CLUSTER_TOKEN) warnings.push('클러스터 토큰을 기록에서 찾지 못해 Kubespray 기본값 k8s_etcd 를 넣었습니다. /etc/etcd.env 로 확인하세요');

  const nodes: RunbookNode[] = members.map((m) => {
    const peer = m.peerURLs[0];
    const script = [
      `# ── ${m.name} (${hostOf(peer)}) ── 4단계: 데이터 복원`,
      `set -euo pipefail`,
      `echo "${s.sha256 ?? ''}  ${file}" | sha256sum -c -   # 스냅샷 무결성 확인`,
      `sudo systemctl is-active etcd && { echo "etcd 가 아직 실행 중입니다. 3단계를 먼저 하세요"; exit 1; }`,
      `sudo mv ${dataDir} ${dataDir}.before-restore-${stamp}`,
      `sudo /usr/local/bin/etcdutl snapshot restore ${file} \\`,
      `  --name ${m.name} \\`,
      `  --initial-cluster ${initialCluster} \\`,
      `  --initial-cluster-token ${token} \\`,
      `  --initial-advertise-peer-urls ${peer} \\`,
      `  --data-dir ${dataDir}`,
      `id etcd >/dev/null 2>&1 && sudo chown -R etcd:etcd ${dataDir} || true`,
      `sudo chmod 700 ${dataDir}`,
      `echo "${m.name} 복원 완료"`,
    ].join('\n');
    return { name: m.name, host: hostOf(peer), peerURL: peer, script };
  });

  const hosts = nodes.map((n) => n.host).join(' ');
  const cert = 'ETCDCTL_CACERT=/etc/ssl/etcd/ssl/ca.pem ETCDCTL_CERT=/etc/ssl/etcd/ssl/admin-$(hostname).pem ETCDCTL_KEY=/etc/ssl/etcd/ssl/admin-$(hostname)-key.pem';
  const endpoints = members.map((m) => (m.clientURLs?.[0] ?? '')).filter(Boolean).join(',');

  const md = `# etcd 롤백 절차서 — ${snap}

> ⚠️ **클러스터 전체를 스냅샷 시점(${s.finishedAt ?? s.startedAt})으로 되돌립니다.**
> 이후 만든/바꾼 리소스는 모두 사라지고, PVC 안의 데이터(NFS)는 되돌아가지 않습니다.
> 앱 하나·네임스페이스 하나의 문제라면 **Velero 복구(gimpo "복구" 메뉴)를 먼저 검토**하세요.
> 조직 규칙상 변경 권한 SSH 작업은 명령 단위로 승인을 받고 진행합니다.

| 항목 | 값 |
|---|---|
| 스냅샷 | \`${snap}\` (리비전 ${s.revision ?? '-'}, ${s.sizeBytes ?? '-'} bytes) |
| 저장 위치 | \`${s3Uri}\` |
| sha256 | \`${s.sha256 ?? '-'}\` |
| 멤버 | ${nodes.map((n) => `\`${n.name}\`(${n.host})`).join(', ')} |
| 데이터 폴더 | \`${dataDir}\` |
| 클러스터 토큰 | \`${token}\` |
${warnings.length ? `\n**확인 필요**\n${warnings.map((w) => `- ${w}`).join('\n')}\n` : ''}
## 0. 사전 확인
- [ ] gimpo **"etcd" → 지금 스냅샷**으로 현재 상태를 한 번 더 백업 (롤백을 되돌릴 때 필요)
- [ ] 이 스냅샷의 **복원 연습 결과가 성공**인지 확인 (etcd 메뉴 → 복원 연습 → "이 스냅샷으로 연습")
- [ ] 작업 시간 공지 — 롤백 중에는 쿠버네티스 API 가 멈춥니다(실행 중인 파드는 계속 동작)

## 1. 스냅샷을 모든 컨트롤 플레인 노드로 복사
S3 자격 증명이 있는 작업 PC 에서(자격 증명은 화면·로그에 남기지 않기):
\`\`\`bash
aws s3 cp --endpoint-url ${s.s3?.endpoint ?? 'http://<seaweedfs>:8333'} ${s3Uri} ./${snap}.db
sha256sum ${snap}.db     # ${s.sha256 ?? ''}
for h in ${hosts}; do scp ./${snap}.db $h:${file}; done
\`\`\`

## 2. 모든 노드: 컨트롤 플레인(apiserver·controller-manager·scheduler) 정지
\`\`\`bash
sudo mkdir -p /etc/kubernetes/manifests-stopped
sudo mv /etc/kubernetes/manifests/kube-*.yaml /etc/kubernetes/manifests-stopped/
# 1분 안에 사라져야 함
sudo crictl ps --name 'kube-(apiserver|controller-manager|scheduler)'
\`\`\`

## 3. 모든 노드: etcd 정지
\`\`\`bash
sudo systemctl stop etcd && sudo systemctl is-active etcd   # inactive 여야 함
\`\`\`

## 4. 노드별: 데이터 복원 (각 노드에서 자기 블록만 실행)
${nodes.map((n) => `### ${n.name} — ${n.host}\n\`\`\`bash\n${n.script}\n\`\`\``).join('\n\n')}

## 5. 모든 노드: etcd 시작 (가능한 한 동시에)
\`\`\`bash
sudo systemctl start etcd
\`\`\`
한 노드에서 확인:
\`\`\`bash
sudo ${cert} /usr/local/bin/etcdctl --endpoints=${endpoints} endpoint health -w table
sudo ${cert} /usr/local/bin/etcdctl --endpoints=${endpoints} endpoint status -w table   # 리비전 ≈ ${s.revision ?? '-'}
sudo ${cert} /usr/local/bin/etcdctl --endpoints=${endpoints} member list -w table
\`\`\`

## 6. 모든 노드: 컨트롤 플레인 다시 시작
\`\`\`bash
sudo mv /etc/kubernetes/manifests-stopped/kube-*.yaml /etc/kubernetes/manifests/
\`\`\`
확인(작업 PC):
\`\`\`bash
kubectl get --raw /livez/etcd; kubectl get nodes; kubectl get pods -A | grep -v Running
\`\`\`
- 노드가 NotReady 로 오래 남으면 해당 노드에서 \`sudo systemctl restart kubelet\`
- ArgoCD 앱은 Git 기준으로 다시 맞춰집니다(롤백 이후 Git 에 반영된 변경은 재적용됨)
- gimpo **상태 점검**이 모두 정상인지 확인

## 되돌리기 (롤백이 실패했을 때)
모든 노드에서 2·3단계로 다시 멈춘 뒤:
\`\`\`bash
sudo rm -rf ${dataDir} && sudo mv ${dataDir}.before-restore-<시각> ${dataDir}
sudo systemctl start etcd
\`\`\`
그 다음 6단계로 컨트롤 플레인을 다시 시작합니다.
`;

  return {
    snapshot: snap,
    createdAt: s.finishedAt ?? s.startedAt,
    revision: s.revision,
    sha256: s.sha256,
    s3Uri,
    dataDir,
    token,
    initialCluster,
    nodes,
    markdown: md,
    warnings,
  };
}
