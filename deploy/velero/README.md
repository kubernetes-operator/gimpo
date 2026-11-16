# Velero 재설치 가이드 (새 서버 / Helm)

chart: **velero v12.0.1** (appVersion 1.18.0), values: [`values.yaml`](./values.yaml)

이 values 는 기존 운영 릴리스에서 추출 후 **VSL 버그를 수정**한 것이다
(빈 VolumeSnapshotLocation 제거 → `FailedValidation` 해소).

## 사전 준비 (중요)

values 가 아래를 참조하므로 **helm 설치 전에** 준비돼 있어야 한다.

1. **MinIO/S3 접근성**: `http://minio:9000` (클러스터 내부 서비스 기준). 새 클러스터의
   실제 주소가 다르면 `values.yaml` 의 모든 `s3Url` 을 수정한다.
2. **버킷**: MinIO `osc-backup`(설정 YAML 백업), SeaweedFS `velero-backups`(PVC 데이터 백업) 존재.
   (2026-11-16 MinIO `daily-backup`·`weekly-backup`·`monthly-backup` 저장 위치는 사용 중단·삭제됨)
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
  'for d in /export-0 /export-1; do for b in osc-backup; do
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

## 백업·복구 설계 (2026-11-16~)

목표: **리소스(YAML)는 MinIO, PVC 데이터는 SeaweedFS(MinIO NAS 와 물리적으로 분리된 공간)**.

Velero 는 백업 하나를 저장 위치(BSL) 하나에만 저장하고, 볼륨 데이터(kopia 파일 백업)도 그 BSL 을 따른다.
VSL 은 클라우드 디스크 스냅샷(EBS 등) 전용이라 S3 저장소를 볼륨 저장 위치로 쓸 수 없고, 이 클러스터는 NFS 라
CSI 스냅샷도 불가하다. 그래서 백업을 "쪼개지" 않고 **두 종류를 겹쳐** 만든다.

| 종류 | 내용 | 저장 위치 | 스케줄 (KST) | 보관 |
|------|------|-----------|--------------|------|
| ① config | 모든 NS 리소스(YAML)만, 볼륨 데이터 없음 (velero NS 제외) | MinIO `default`(osc-backup) | `velero-config-backup` 매일 03:30 | 30일 |
| ② data (daily) | default·demo-app·memonest, YAML+볼륨 | SeaweedFS `seaweedfs-lab` | `velero-daily-app-backup` 매일 03:00 | 7일 |
| ② data (monthly) | 전체(velero 제외), YAML+볼륨 | SeaweedFS `seaweedfs-lab` | `velero-monthly-full-backup` 매월 2일 04:03 | 35일 |

- ② 는 그 자체로 완전한 백업이라 **복구는 항상 백업 1개로 끝난다**(순서 맞추기 불필요).
- monthly 를 "전체"로 두는 이유: 새 앱 NS 를 목록에 넣는 걸 잊어도 누락되지 않게. PVC 없는 NS 는 수 MB 라 부담 없음.
- SeaweedFS 사전 준비: `velero` NS 에 시크릿 `seaweedfs-credentials`(key `cloud`, AWS credentials 파일 형식)를 직접 생성.

### 복구 시나리오

| 상황 | 백업 | 방법 |
|------|------|------|
| 설정 실수(Deployment/ConfigMap 등) | ① config | 해당 NS·리소스만 골라 복구 (`includedNamespaces`, `includedResources`) |
| 데이터 손상(DB·파일) | ② daily/monthly | 해당 NS 삭제 후 ② 에서 NS 단위 복구 |
| 복구 전 내용 확인 | ② | `namespaceMapping` 으로 다른 NS 에 나란히 복구 → 확인 후 삭제 |
| 클러스터 전체 재구축 | ② → ① | Velero 설치(이 values) → ② monthly 복구 → ① 최신 config 복구(이미 있는 리소스는 Velero 가 건너뜀) |

나란히 복구(검증용) 예시 — 실제 트래픽 경로와 초기화 Job 은 제외한다:

```yaml
apiVersion: velero.io/v1
kind: Restore
metadata: { generateName: verify-restore-, namespace: velero }
spec:
  backupName: <② 백업 이름>
  namespaceMapping: { demo-app: demo-app-restore-test }
  excludedResources: [httproutes.gateway.networking.k8s.io, ingresses.networking.k8s.io, jobs.batch]
  restorePVs: true
```

- 나란히 복구 시 **고정 NodePort 를 쓰는 Service 는 원본과 충돌해 오류 1건**이 날 수 있다(정상). 원본을 지우고 복구하는 실제 상황에선 발생하지 않는다.
- 검증 기록(2026-11-16): demo-app → SeaweedFS 백업(Postgres 47.8MB, 6초) → `demo-app-restore-test` 복구, 테이블·행 수 원본과 일치.

### 정기 점검
- 매월 monthly 백업 후 위 "나란히 복구"로 임의 NS 1개 복구 검증.
