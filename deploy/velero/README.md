# Velero 재설치 가이드 (새 서버 / Helm)

chart: **velero v12.0.1** (appVersion 1.18.0), values: [`values.yaml`](./values.yaml)

이 values 는 기존 운영 릴리스에서 추출 후 **VSL 버그를 수정**한 것이다
(빈 VolumeSnapshotLocation 제거 → `FailedValidation` 해소).

## 사전 준비 (중요)

values 가 아래를 참조하므로 **helm 설치 전에** 준비돼 있어야 한다.

1. **MinIO/S3 접근성**: `http://minio:9000` (클러스터 내부 서비스 기준). 새 클러스터의
   실제 주소가 다르면 `values.yaml` 의 모든 `s3Url` 을 수정한다.
2. **버킷**: `osc-backup`, `daily-backup`, `weekly-backup`, `monthly-backup` 존재.
3. **자격증명 시크릿**: `velero` 네임스페이스에 `velero-minio-credentials`(key `cloud`).
   - 값은 조직 정책상 이 문서에 넣지 않는다. 아래 형식으로 **직접** 생성한다.

## 설치 절차

```bash
# 0) 네임스페이스
kubectl create namespace velero

# 1) MinIO 자격증명 시크릿 (key=cloud, AWS credentials 파일 형식)
#    아래 자리표시자를 실제 MinIO 액세스/시크릿 키로 바꿔 로컬 파일로 만든 뒤 생성한다.
cat > /tmp/velero-cloud <<'CRED'
[default]
aws_access_key_id=<MINIO_ACCESS_KEY>
aws_secret_access_key=<MINIO_SECRET_KEY>
CRED
kubectl -n velero create secret generic velero-minio-credentials \
  --from-file=cloud=/tmp/velero-cloud
rm -f /tmp/velero-cloud   # 자격증명 파일은 사용 후 삭제

# 2) 차트 repo (helm 서버 복구 후). 사내 미러를 쓰던 경우 그 URL 을 사용한다.
helm repo add vmware-tanzu https://vmware-tanzu.github.io/helm-charts
helm repo update

# 3) 설치 (버전은 환경의 차트 가용 버전에 맞춘다)
helm upgrade --install velero vmware-tanzu/velero \
  --version 12.0.1 \
  --namespace velero \
  -f values.yaml

# 4) 확인
kubectl -n velero rollout status deploy/velero
kubectl -n velero get pods
kubectl -n velero get backupstoragelocations.velero.io   # PHASE=Available 기대
kubectl -n velero get volumesnapshotlocations.velero.io  # volume-backup 1개만
kubectl -n velero get schedules.velero.io
```

## 검증 (VSL 버그 해소 확인)

```bash
# 수동 테스트 백업 (작은 네임스페이스) → FailedValidation 이 아니어야 정상
kubectl -n velero create -f - <<'EOF'
apiVersion: velero.io/v1
kind: Backup
metadata:
  generateName: verify-fix-
  namespace: velero
spec:
  includedNamespaces: [default]
  snapshotVolumes: true
  storageLocation: default
  ttl: 1h0m0s
EOF

kubectl -n velero get backups.velero.io -w   # phase 가 New→InProgress→Completed 로 진행
```

## 참고

- 차트 버전 `12.0.1` 이 공개 repo 에 없으면(사내 재배포 차트일 수 있음) 기존에 쓰던 repo URL 로 교체한다.
- 버킷/`s3Url`/`region(Prod)` 은 이 클러스터의 MinIO 설정에 맞춘 값이다. 새 환경이 다르면 조정한다.
- CRD 는 `upgradeCRDs: true` 로 차트가 관리한다.

## 장애 기록 (2026-11-12) — 백업 PartiallyFailed / 삭제 멈춤

증상: 모든 스케줄 백업이 `PartiallyFailed`·`FailedValidation`, 백업 삭제(DeleteBackupRequest)가 수주간 진행되지 않음.

| 원인 | 조치 |
|------|------|
| 빈 `default` VSL(provider aws) 때문에 VSL 미지정 백업이 `FailedValidation` | `default` VSL 삭제(이 values 에서도 제거됨) |
| `snapshotVolumes: true` 인데 MinIO 환경엔 스냅샷 제공자가 없음(aws VSL 에 s3Url 등 잘못된 키 → 플러그인 에러) | 스케줄 `snapshotVolumes: false`, 볼륨은 kopia 파일 백업만 사용 |
| MinIO 목록 조회가 극도로 느림(IAM 2건 listing 에 30~70분). kopia 저장소 open 이 ListObjects 에서 무한 대기 → PVB·repo maintenance·백업 삭제가 줄줄이 멈춤 | 기존 백업 데이터 전체 초기화 후 MinIO 재시작(아래 절차) |
| 멈춘 PVB 가 node-agent 처리 슬롯을 점유 → 이후 PVB 가 `Prepared` 로 적체 | 멈춘 PVB 삭제 + 해당 노드 node-agent 재시작 |

조치 후 검증: `default` 네임스페이스 백업 Completed(7.2GB, 오류 0), `logging` 네임스페이스 백업은 Loki 4.6GB 포함
볼륨 9건 모두 성공(단, 아래 control-plane 이슈로 promtail 볼륨 3건 오류 → PartiallyFailed).

### 백업 데이터 전체 초기화 절차 (기존 백업을 버려도 될 때만)

Velero 정상 삭제 경로가 MinIO 지연으로 끝나지 않을 때 사용한다. **되돌릴 수 없다.**

```bash
# 1) 스케줄 일시정지 후 velero 정지
kubectl -n velero patch schedules.velero.io <name> --type merge -p '{"spec":{"paused":true}}'
kubectl -n velero scale deploy/velero --replicas=0
# 2) CR 정리
kubectl -n velero delete deletebackuprequests.velero.io,backups.velero.io,podvolumebackups.velero.io,backuprepositories.velero.io --all
# 3) 모든 MinIO 파드·드라이브에서 velero 프리픽스 삭제 (버킷 자체와 다른 버킷은 유지)
for p in minio-0 minio-1; do kubectl -n velero exec $p -- sh -c \
  'for d in /export-0 /export-1; do for b in daily-backup weekly-backup monthly-backup osc-backup; do
     rm -rf $d/$b/backups $d/$b/kopia $d/$b/restores $d/.minio.sys/buckets/$b/.metacache; done; done'; done
# 4) MinIO 재시작 → velero 복구 → BSL Available 확인 → 테스트 백업 → 스케줄 재개
kubectl -n velero rollout restart sts/minio && kubectl -n velero rollout status sts/minio
kubectl -n velero scale deploy/velero --replicas=1
kubectl -n velero get backupstoragelocations.velero.io
```

### 남은 과제

- **MinIO 저장소 구조**: 2노드×2드라이브(EC) 4개 PVC 가 모두 같은 NFS NAS(`nfs-nas-sc-main`, 사용률 86%)에 있다.
  같은 NAS 에 4중으로 쓰고 listing 이 느려지는 구조라 데이터가 쌓이면 같은 증상이 재발할 수 있다.
  로컬 디스크 기반 MinIO 또는 단일 드라이브 구성으로의 이전을 검토한다.
- ~~control-plane 노드 node-agent 미배치~~ → **해결**: `nodeAgent.tolerations` 에 control-plane·`nvidia.com/gpu`
  toleration 추가(클러스터 DaemonSet 에도 적용). GPU toleration 은 필수다 — 없으면 DaemonSet 재시작 시 GPU 노드
  (ollama 등)에서 node-agent 가 빠져 그 노드 볼륨이 백업되지 않는다.
