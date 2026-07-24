# gimpo — Velero 백업/복구 대시보드

클러스터에 설치된 **Velero** 를 웹에서 제어하는 대시보드. Velero 의 CRD(`velero.io`)를 직접 조작하여
백업/복구/스케줄/스토리지위치 등 **모든 기능**을 다루며, `kube-system` 을 포함한 **모든 네임스페이스**와
리소스 타입·라벨셀렉터 단위 선택을 지원한다.

- 백엔드: Node.js + TypeScript + Fastify + `@kubernetes/client-node`
- 프론트: Vue 3 + Vite + Element Plus + TypeScript
- 제어 방식: velero CLI 없이 `velero.io` CRD 를 직접 CRUD

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
