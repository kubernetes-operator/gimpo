# gimpo — Velero 백업/복구 대시보드

클러스터에 설치된 **Velero** 를 웹에서 제어하는 대시보드. Velero 의 CRD(`velero.io`)를 직접 조작하여
백업/복구/스케줄/스토리지위치 등 **모든 기능**을 다루며, `kube-system` 을 포함한 **모든 네임스페이스**와
리소스 타입·라벨셀렉터 단위 선택을 지원한다.

- 백엔드: Node.js + TypeScript + Fastify + `@kubernetes/client-node`
- 프론트: Vue 3 + Vite + Element Plus + TypeScript
- 제어 방식: velero CLI 없이 `velero.io` CRD 를 직접 CRUD

## 문서

- 📘 [사용 설명서](docs/USER_GUIDE.md) — 화면별 사용법, 자주 하는 일
- 🛠️ [운영 매뉴얼](docs/OPERATIONS_MANUAL.md) — 백업 설계, 상태 점검 기준, 장애 대응, 복구·**etcd 롤백** 절차, 배포·보안
- 🗄️ [Velero 재설치·장애 기록](deploy/velero/README.md)

## etcd 백업 · 복원 연습

Kubespray systemd(host) 방식 etcd 를 대상으로 `deploy/etcd-backup.yaml` 의 CronJob 2개가 동작한다.

| 잡 | 일정(KST) | 동작 |
|---|---|---|
| `gimpo-etcd-snapshot` | 6시간마다 | 컨트롤 플레인 노드의 `etcdctl` 로 스냅샷 → 무결성 확인 → SeaweedFS `etcd-snapshots` 업로드 → 7일 보관(최소 3개) |
| `gimpo-etcd-restore-drill` | 매일 05:30 | 최신 스냅샷을 임시 etcd 에 복원해 리비전·핵심 키 검증(운영 etcd 무접촉) |

도구는 이미지에 포함된 `backend/dist/tools/etcd-tool.js`(외부 의존성 없는 S3 SigV4 클라이언트 포함)이며, 노드의 etcd 바이너리를 읽기 전용으로 마운트해 버전이 항상 일치한다.
대시보드 **etcd 백업** 메뉴에서 이력 확인·지금 실행·스냅샷별 **롤백 절차서** 생성을 한다(롤백 실행은 사람이 SSH 로).

| 환경 변수 (etcd-tool) | 기본값 | 설명 |
|---|---|---|
| `ETCD_BIN_DIR` | `/host-bin` | 노드 `/usr/local/bin` 마운트 위치 |
| `ETCD_CERT_DIR` | `/etcd-ssl` | 노드 `/etc/ssl/etcd/ssl` (snapshot 만) |
| `ETCD_ENV_FILE` | `/host-etc/etcd.env` | 노드 `/etc/etcd.env` |
| `S3_ENDPOINT` / `S3_BUCKET` | - / `etcd-snapshots` | S3 호환 저장소 |
| `S3_CREDENTIALS_FILE` | `/creds/cloud` | AWS credentials 형식 파일(기존 시크릿) |
| `RETENTION_DAYS` / `KEEP_MIN` | `7` / `3` | 보관 기간 / 최소 보관 개수 |
| `SNAPSHOT_NAME` | (최신) | drill 대상 스냅샷 |

## 요구 사항

- Node.js 20+ (개발 환경엔 22 권장)
- `velero.io` CRD 에 접근 가능한 kubeconfig (로컬) 또는 in-cluster ServiceAccount (배포)

## 로컬 개발

```bash
npm install                 # 워크스페이스 전체 설치
npm run dev                 # backend(:3000) + frontend(:5173) 동시 실행
```

- 프론트(`:5173`)의 `/api` 요청은 Vite 프록시로 백엔드(`:3000`)에 전달된다.
- 백엔드는 `KubeConfig.loadFromDefault()` 로 `~/.kube/config`(또는 `$KUBECONFIG`)를 사용한다.
- 백업 로그/결과는 Velero 가 발급하는 **MinIO signed URL** 로 다운로드된다. 로컬에서 MinIO 클러스터
  내부 주소에 접근이 안 되면 아래처럼 포트포워드가 필요할 수 있다.

```bash
kubectl -n velero port-forward svc/minio 9000:9000   # 환경에 맞게 서비스명 조정
```

### 환경 변수 (backend)

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `PORT` | `3000` | 백엔드 포트 |
| `VELERO_NAMESPACE` | `velero` | Velero 가 설치된 네임스페이스 |
| `DOWNLOAD_TIMEOUT_MS` | `30000` | DownloadRequest signed URL 폴링 타임아웃 |
| `STATIC_DIR` | (빌드 시) | SPA 정적 파일 경로. 미설정 시 정적 서빙 비활성(개발 모드) |
| `RESTORE_TEST_NAMESPACE` | `velero-restore-test` | 자동 복구 테스트 전용 네임스페이스 |
| `RESTORE_TEST_IMAGE` | `registry.local.cloud:5000/gimpo:latest` | 테스트 파드 이미지(대시보드 이미지 재사용) |
| `RESTORE_TEST_STATE_CM` | `gimpo-restore-test` | 복구 테스트 설정·이력 ConfigMap(velero NS) |
| `RESTORE_TEST_SCHEDULER` | (켜짐) | `off` 면 예약 실행 비활성(로컬 개발용) |

## 상태 점검 · 자동 복구 테스트

**상태 점검 화면**(`/health`)은 1분마다 아래를 점검해 🟢/🟡/🔴 로 보여준다. 개요 화면 상단에도 요약이 뜬다.

| 분류 | 항목 | 이상 기준 |
|------|------|-----------|
| 서버 | Velero 서버, node-agent(노드별) | Ready 아님 |
| 저장소 | 모든 BSL | Available 아님 / 1시간 넘게 미확인 |
| 스케줄 | 스케줄별 최근 백업 | 예정 시각에 미실행(🔴), PartiallyFailed(🟡), 6시간 넘게 진행 중(🔴) |
| 작업 | 멈춘 PVB·PVR·DataUpload, 처리 대기 삭제 요청, 저장소 정리 잡 | 4시간 넘게 진행 / 1·24시간 넘게 대기 / 6시간 넘게 실행 |
| 복구 테스트 | 최근 자동 복구 테스트 | 실패(🔴), 예정보다 오래됨·꺼짐(🟡) |

**자동 복구 테스트**는 매일(기본 05:00 KST) 전용 네임스페이스 `velero-restore-test` 에서:

1. 그날 날짜·임의값이 들어간 Pod·PVC(파일 + 1MiB 난수)·ConfigMap·Secret 생성
2. 백업(기본 저장 위치 `seaweedfs-lab`, 72시간 보관) → 3. 리소스 삭제(장애 재현) → 4. 복구
5. ConfigMap·Secret·PVC 파일·1MiB 데이터 sha256 이 원본과 같은지 검증 → 6. 정리

설정(켜기/끄기, 일정, 저장 위치, 제한 시간)·"지금 실행"·단계별 결과·이력은 상태 점검 화면에서 다룬다.
설정·이력은 ConfigMap `velero/gimpo-restore-test` 에 저장된다. 실패 시 테스트 리소스는 원인 분석용으로 남겨 두고 다음 실행 때 정리한다.

## 스케줄 편집

- 일정은 **한국 시간**으로 고른다(매일/매주/매월/직접 입력). Velero 의 `CRON_TZ=Asia/Seoul …` 표기로 저장된다.
- **표시 이름**·설명은 화면용 어노테이션(`gimpo.io/display-name`, `gimpo.io/description`)이라 언제든 바꿔도 Velero 동작에 영향이 없다.
- **실제 이름 변경**은 "같은 설정으로 새로 만들고 기존 삭제"다. 기존 백업 처리를 고른다:
  이력에 연결(`gimpo.io/previous-names` 에 기록, 이력 화면에서 과거 백업 조회) / 유지만 / 삭제.
  Helm 이 만든 스케줄이면 Helm values 이름도 바꾸지 않으면 다음 upgrade 때 옛 이름이 다시 생긴다는 경고를 띄운다.

> 자격증명(kubeconfig, 토큰, 비밀번호 등)은 **코드/이미지/매니페스트에 절대 포함하지 않는다.**
> 인증은 로컬 kubeconfig 또는 in-cluster SA 로만 이뤄진다.

## 프로덕션 빌드

```bash
npm run build               # frontend → backend 순서로 빌드
npm start                   # STATIC_DIR 로 SPA 서빙 + /api
```

## 컨테이너 & 인클러스터 배포

```bash
docker build -t gimpo-velero-dashboard:dev .

# RBAC + Deployment + Service (velero 네임스페이스 기준)
kubectl apply -k deploy/

# 접속 (Ingress 미사용 시)
kubectl -n velero port-forward svc/gimpo-velero-dashboard 8080:80
# http://localhost:8080
```

`deploy/rbac.yaml` 의 ClusterRole 은 `velero.io` 전체와 네임스페이스/디스커버리 read 권한만 가진다.
실제 백업/복구 대상 리소스에 대한 권한은 **Velero 컨트롤러**가 이미 보유하므로 대시보드 SA 에는 부여하지 않는다(최소 권한).

## GitOps (ArgoCD) 배포

이 저장소는 ArgoCD 로 배포하도록 구성돼 있다.

1. **이미지 빌드/푸시**: 클러스터 관행에 따라 내부 레지스트리 `registry.local.cloud:5000/gimpo`
   를 사용한다. `.github/workflows/build-and-push.yml`(내부망 접근 가능한 self-hosted 러너)
   또는 아래처럼 수동으로 빌드·푸시한다.

   ```bash
   docker build -t registry.local.cloud:5000/gimpo:0.1.0 .
   docker push registry.local.cloud:5000/gimpo:0.1.0
   ```
2. **매니페스트 동기화(ArgoCD)**: `deploy/argocd/application.yaml` 의 Application 이
   저장소의 `deploy/`(kustomize)를 `velero` 네임스페이스로 자동 동기화한다.

```bash
# ArgoCD 에 Application 등록 (한 번만)
kubectl apply -f deploy/argocd/application.yaml
```

Application 은 `targetRevision: main` 을 추적한다. 이 브랜치를 `main` 에 병합하면 CI 가
이미지를 만들고 ArgoCD 가 매니페스트를 동기화한다. 병합 전 이 브랜치를 바로 배포해 보려면
Application 의 `targetRevision` 을 브랜치명으로 바꾼다.

> 클러스터에 Application 을 apply 하거나 `main` 병합으로 실제 배포가 시작되는 것은
> 되돌리기 어려운 작업이므로 승인 후 진행한다.

## 안전/정책

- 실제 백업 생성·복구·삭제 등 **되돌리기 어려운 쓰기 작업은 사용자 승인 후** 수행한다.
- 백업 삭제는 `Backup` CR 을 직접 지우지 않고 `DeleteBackupRequest` 를 생성해 오브젝트 스토리지까지 정리한다.

## 구조

```
backend/   Fastify API — velero.io CRD CRUD, DownloadRequest 로그 취득
frontend/  Vue3 SPA — 대시보드 UI
deploy/    RBAC / Deployment / Service / Ingress(옵션) / kustomization
Dockerfile 멀티스테이지 빌드
```
