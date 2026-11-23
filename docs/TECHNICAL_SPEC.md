# gimpo 기술 설명서

> 버전 0.4.0 · 대상: 개발자·플랫폼 엔지니어
> 함께 보기: [상세 설명서](PRODUCT_DETAIL.md) · [운영 매뉴얼](OPERATIONS_MANUAL.md) · [사용 설명서](USER_GUIDE.md)

---

## 1. 시스템 개요

gimpo 는 쿠버네티스 클러스터의 **백업·복구를 웹에서 운영하고, 복구 가능성을 자동으로 증명**하는 대시보드다.
Velero(리소스·PVC 데이터)와 etcd 스냅샷(클러스터 전체 상태) 두 축을 하나의 화면·상태 점검·권한 체계로 묶는다.

| 항목 | 내용 |
|---|---|
| 백엔드 | Node.js 22 · TypeScript · Fastify 5 · `@kubernetes/client-node` 1.x · `cron-parser` 5 |
| 프론트엔드 | Vue 3 · Vite · Element Plus · TypeScript |
| 대상 | Velero v1.18 (kopia 파일 백업), etcd 3.5 (Kubespray systemd 방식) |
| 배포 | 단일 컨테이너 이미지(백엔드가 SPA 정적 서빙) · kustomize · ArgoCD GitOps |
| 규모 | 소스 약 6,500줄, REST API 약 60개 |

## 2. 아키텍처

```
브라우저 ──HTTPS──▶ Gateway(HTTPRoute, /velero 프리픽스 제거) ──▶ gimpo Pod (velero NS, replicas 1, Recreate)
                                                                 │
   ┌─────────────────────────────────────────────────────────────┤
   │ Fastify                                                     │
   │  ├ web_access   : 세션 쿠키 인증 · 역할(admin/viewer) · 페이지 권한 (onRequest 훅)
   │  ├ routes/*     : Velero CRD 프록시 · 상태 점검 · 복구 테스트 · etcd
   │  ├ 백그라운드   : 복구 테스트 스케줄러(30초) · 정리 잡 정리(1시간) · etcd 결과 수집(1분)
   │  └ @fastify/static : SPA
   └──▶ kube-apiserver (ServiceAccount 토큰, 최소 권한 RBAC)
            ├ velero.io CRD ──▶ Velero 서버 ─┬─▶ MinIO (설정 백업)
            │                                └─▶ SeaweedFS (데이터 백업)
            ├ CronJob/Job (etcd) ──▶ 컨트롤 플레인 노드: etcdctl → SeaweedFS(etcd-snapshots)
            └ ConfigMap (상태 저장: gimpo-restore-test, gimpo-etcd)
```

**설계 원칙**
1. **Velero CLI 없이 CRD 직접 제어** — Backup/Restore/Schedule/DeleteBackupRequest/DownloadRequest 를 API 서버에 생성·조회한다.
2. **상태는 쿠버네티스에 둔다** — DB 없이 ConfigMap·CR·Job 로그를 원본으로 쓴다(재시작해도 이어짐).
3. **실행 주체 분리** — 위험한 작업(etcd 인증서 사용, 호스트 바이너리 실행)은 별도 Job 이 최소 권한으로 수행하고, 대시보드는 결과만 읽는다.
4. **비밀은 통과만** — S3 자격 증명은 기존 시크릿을 Job 에 마운트해 쓰고, 로그·응답·오류 메시지에 값을 남기지 않는다.

## 3. 백엔드 모듈

| 경로 | 역할 |
|---|---|
| `src/server.ts` | Fastify 구성, 에러 핸들러(K8s 오류 → `{error, reason}`), 라우트·백그라운드 작업 등록 |
| `src/config.ts` | 환경 변수 설정 |
| `src/k8s/client.ts` | KubeConfig 로딩(로컬/인클러스터), CoreV1·AppsV1·BatchV1·CustomObjects 클라이언트, discovery 용 `rawGet`(node:https + 타임아웃) |
| `src/k8s/velero.ts` | velero.io CR 제네릭 CRUD (`list/get/create/delete/replace/mergePatch/listBySelector`) |
| `src/k8s/download.ts` | DownloadRequest 생성 → `status.downloadURL` 폴링 → gunzip (로그·결과 조회) |
| `src/routes/*.ts` | REST API (5장) |
| `src/util/cron.ts` | `CRON_TZ=` 접두어 해석, 다음/직전 실행·간격 계산 |
| `src/health/checks.ts` | 상태 점검 보고서 생성(6장) |
| `src/restoretest/*` | 자동 복구 테스트: 저장소(ConfigMap)·실행기·스케줄러 |
| `src/cleanup/maintenanceJobs.ts` | Velero 저장소 정리 잡 자동 정리 |
| `src/etcd/collector.ts` | etcd Job 결과 수집·이력 저장, CronJob 정보, 지금 실행(Job 생성) |
| `src/etcd/runbook.ts` | 스냅샷 메타데이터로 노드별 롤백 절차서 생성 |
| `src/tools/s3.ts` | 무의존 S3 클라이언트(AWS SigV4, path-style) |
| `src/tools/etcd-tool.ts` | etcd `snapshot` / `drill` CLI (Job 안에서 실행) |
| `src/access/web_access.ts` | 계정 저장소(PBKDF2 39만 회, 원자적 파일 쓰기), 세션, 페이지 권한 |

## 4. 프론트엔드

| 화면 | 파일 | 주요 컴포넌트 |
|---|---|---|
| 개요 | `OverviewView.vue` | 상태 배너, 통계 카드, 최근 백업 |
| 상태 점검 | `HealthView.vue` | 점검표, 스케줄별 카드, 복구 테스트(단계·이력·설정) |
| 백업 / 복구 | `BackupsView.vue` / `RestoresView.vue` | `BackupSpecForm`, `NamespaceSelector`, `ResourceSelector`, `YamlViewer` |
| 스케줄 | `SchedulesView.vue` | `CronBuilder`(KST), `ScheduleEditDialog`, `ScheduleHistoryDialog` |
| 스토리지·리포지토리 | `StorageView.vue` · `RepositoriesView.vue` | |
| etcd 백업 | `EtcdView.vue` | 멤버표, 이력 탭, 롤백 절차서 다이얼로그 |

- 라우터 `beforeEach` 와 메뉴 `v-if` 가 `webAccess.pages` 로 화면을 거르고, 쓰기 버튼은 `webAccess.role === 'admin'` 일 때만 보인다(서버도 동일하게 강제).
- 서브패스 서빙: Vite `base=/velero/`, `createWebHistory(BASE_URL)`, axios `baseURL=${BASE_URL}api`.

## 5. REST API

모든 `/api/*` 는 로그인 세션이 필요하다(`/api/auth/status|bootstrap|login` 제외). **쓰기 메서드는 admin 만**, 조회는 해당 페이지 권한이 있어야 한다.

| 페이지 권한 | 메서드 · 경로 | 설명 |
|---|---|---|
| overview | `GET /api/overview`, `/api/overview/health`, `/api/server-status` | 개요 요약 |
| health | `GET /api/health/report[?refresh=1]` | 상태 점검(30초 캐시) |
| health | `GET /api/restore-test` · `PUT /api/restore-test/config` · `POST /api/restore-test/run` | 복구 테스트 상태·설정·즉시 실행(202) |
| backups | `GET/POST /api/backups` · `GET/DELETE /api/backups/:name` | 목록·생성·상세·삭제(DeleteBackupRequest) |
| backups | `GET /api/backups/:name/{logs,results,resource-list,volume-snapshots}` | DownloadRequest 기반 조회 |
| restores | `GET/POST /api/restores` · `GET/DELETE /api/restores/:name` · `GET …/{logs,results}` | 복구 |
| schedules | `GET/POST /api/schedules` · `GET/PUT/DELETE /api/schedules/:name` | 편집은 템플릿 전체 교체(resourceVersion 낙관적 동시성) |
| schedules | `POST /api/schedules/:name/rename` `{newName, oldBackups: link\|keep\|delete}` | 새로 생성 → 기존 삭제, 이력 연결 |
| schedules | `GET /api/schedules/:name/backups[?previous=1]` · `PATCH …/pause` · `POST …/trigger` · `POST /api/cron/preview` | 이력·일시정지·즉시 실행·일정 미리보기 |
| storage | `GET /api/backup-storage-locations[/:name]` · `PATCH …/:name/default` · `GET /api/volume-snapshot-locations[/:name]` | 저장 위치 |
| repositories 등 | `GET /api/{backup-repositories,pod-volume-backups,pod-volume-restores,data-uploads,data-downloads}` | 볼륨 작업 기록 |
| backups·restores·schedules | `GET /api/namespaces`, `/api/api-resources` | 선택기용(discovery 10분 캐시) |
| etcd | `GET /api/etcd` | 일정·진행 중 잡·이력·멤버 |
| etcd | `POST /api/etcd/snapshot` · `POST /api/etcd/drill {snapshot?}` | 지금 실행(202, 중복 실행 409) |
| etcd | `GET /api/etcd/runbook[?snapshot=]` | 롤백 절차서(JSON: markdown·노드별 script) |
| settings / users | `/api/auth/ui/session`, `/api/auth/ui/password`, `/api/auth/users[/:username]`, `/api/auth/logout` | 세션·비밀번호·사용자 관리 |

오류 응답은 `{ "error": "<한국어 메시지>", "reason"?: "<K8s reason>" }`, 인증 오류는 `{ "detail": ... }`.

## 6. 상태 점검 알고리즘

`buildHealthReport()` 가 아래를 병렬로 모아 항목별 `ok|warn|fail` 을 매기고, 전체는 가장 나쁜 값이다.

| 항목 | 판정 |
|---|---|
| 스케줄 지연 | `prev = 직전 예정 시각(cron, CRON_TZ 반영)`, `grace = min(2h, 간격/2)`. `prev > 생성시각 && now-prev > grace && max(최근 백업 생성, status.lastBackup) < prev-5m` → fail. (백업이 삭제·만료돼도 `status.lastBackup` 으로 오탐 방지) |
| 스케줄 결과 | Completed ok · PartiallyFailed warn · 진행 6h 초과 fail · 그 외 fail |
| 멈춘 작업 | PVB/PVR/DataUpload 가 New·Accepted·Prepared·InProgress·Canceling 상태로 4h 초과 → fail |
| 삭제 요청 | 미처리 DBR 가장 오래된 것 1h → warn, 24h → fail |
| 정리 잡 | `-maintain-job-` 잡 6h 넘게 실행 → fail, 7일 내 실패 → warn |
| 복구 테스트 | 최근 실패 → fail, 마지막 성공이 일정 간격×1.5 초과 → warn |
| etcd | 스냅샷 최근 실패 → fail, 성공 간격×1.5 warn / ×4 fail · 멤버 응답 수·리더 수 · 복원 연습 실패 fail / 36h warn |

## 7. 자동 복구 테스트

| 요소 | 구현 |
|---|---|
| 일정 | ConfigMap `gimpo-restore-test` 의 `config.schedule`(기본 `CRON_TZ=Asia/Seoul 0 5 * * *`). 30초 tick 에서 `prevRun()` 이 `state.lastScheduledFor` 보다 새로우면 실행. 첫 기동은 기준점만 기록, 1시간 넘게 지난 예정분은 건너뜀 |
| 데이터 | NS `velero-restore-test` 에 `rt-config`(KST 시각+nonce), `rt-secret`(16B 난수), `rt-data` PVC(텍스트+1MiB 난수), `rt-app` Pod(대시보드 이미지 재사용, 비루트) |
| 단계 | prepare → create → backup(labelSelector, fs-backup, 지정 BSL) → delete → restore → verify(CM·Secret·파일·sha256, "FOUND" 로그로 PVC 가 실제 복원됐는지 확인) → cleanup |
| 기록 | 실행 중 단계마다 ConfigMap 이력 갱신(직렬 쓰기 큐, 409 재시도), 재시작 시 running → aborted |

## 8. etcd 백업·복원

### 8.1 Job 구성 (`deploy/etcd-backup.yaml`)
| | snapshot | drill |
|---|---|---|
| 일정 | `0 */6 * * *` (Asia/Seoul) | `30 5 * * *` |
| 노드 | 컨트롤 플레인(nodeAffinity + toleration) | 동일(노드의 `etcd` 바이너리 필요) |
| 마운트(ro) | `/usr/local/bin`, `/etc/etcd.env`, `/etc/ssl/etcd/ssl`, 시크릿 | `/usr/local/bin`, 시크릿 |
| 보안 | root, `readOnlyRootFilesystem`, cap drop ALL + `DAC_READ_SEARCH` | uid 1000, cap drop ALL |
| 기타 | `concurrencyPolicy: Forbid`, `activeDeadlineSeconds: 1800`, `ttlSecondsAfterFinished: 7d` | 동일 |

### 8.2 snapshot 흐름
1. `/etc/etcd.env` 에서 비밀이 아닌 키만 읽음(`ETCD_NAME`, `ETCD_DATA_DIR`, `ETCD_INITIAL_CLUSTER[_TOKEN]`, `ETCD_ADVERTISE_CLIENT_URLS` …)
2. 클라이언트 인증서 탐색: `admin-<노드>` → `node-<노드>` → `member-<노드>`
3. `member list` / `endpoint status --cluster`(JSON, 64비트 ID 는 파싱 전 문자열화) / 네임스페이스 키 수(`--count-only -w fields`)
4. `snapshot save` → `etcdutl snapshot status`(없으면 etcdctl) → sha256
5. 버킷 확인·생성 → `PUT` 업로드(SigV4 서명에 실제 sha256 → 저장소가 무결성 검증) → 보관 정리(`RETENTION_DAYS`, `KEEP_MIN`) → **메타데이터 JSON 을 마지막에 업로드**(메타가 있으면 스냅샷 완전)
6. 결과 한 줄 `GIMPO-ETCD-RESULT {json}` 출력, 종료 코드 0/1

### 8.3 drill 흐름
메타데이터 목록에서 최신(또는 `SNAPSHOT_NAME`) 선택 → 다운로드 → sha256 비교 → 해시 비교 → `etcdutl snapshot restore`(단일 멤버, 127.0.0.1:32379/32380) → 노드의 `etcd` 로 기동 → health 대기(120초) → 리비전·`/registry/namespaces/kube-system`·네임스페이스 수·전체 키 수 → SIGTERM/SIGKILL → 작업 폴더 삭제 → `GIMPO-ETCD-DRILL {json}`.

### 8.4 결과 수집과 롤백 절차서
- `collector` 가 1분마다(및 `GET /api/etcd` 시) 끝난 Job(`gimpo.io/etcd-job` 라벨)의 파드 로그 마지막 결과 줄을 읽어 ConfigMap `gimpo-etcd` 에 저장(최대 120건). 결과 줄이 없으면 Job 조건·컨테이너 상태로 실패 기록.
- "지금 실행" 은 `kubectl create job --from=cronjob` 과 동등(`cronjob.kubernetes.io/instantiate: manual`, CronJob ownerReference).
- `runbook` 은 멤버(이름순)·peer URL·토큰·데이터 폴더로 `--initial-cluster` 를 구성하고 노드별 `etcdutl snapshot restore` 스크립트와 전체 Markdown(사전 확인 → 복사 → 컨트롤 플레인 정지 → etcd 정지 → 노드별 복원 → 시작·확인 → 재개 → 되돌리기)을 만든다.

### 8.5 S3 클라이언트
AWS SigV4(`AWS4-HMAC-SHA256`), path-style, `HEAD/PUT bucket`, 스트리밍 `PUT/GET object`, `ListObjectsV2`(페이지네이션), `DELETE`. 자격 증명은 AWS credentials 파일(`[default] aws_access_key_id/aws_secret_access_key`)에서 읽고 오류 메시지에는 S3 `Code`·`Message` 만 담는다.

## 9. 데이터 모델

| 저장소 | 키 | 내용 |
|---|---|---|
| ConfigMap `velero/gimpo-restore-test` | `config` · `history` · `state` | 복구 테스트 설정 · 최근 60회 실행(단계·표식·sha256) · 마지막 처리한 예정 시각 |
| ConfigMap `velero/gimpo-etcd` | `snapshots` · `drills` | 스냅샷 결과(멤버·엔드포인트·클러스터 env·S3 키·보관 현황) · 복원 연습 결과(검증 항목) |
| S3 `etcd-snapshots/snapshots/` | `etcd-<KST>-<노드>.db` · `.json` | 스냅샷 파일 · 메타데이터 |
| Schedule 어노테이션 | `gimpo.io/display-name` · `gimpo.io/description` · `gimpo.io/previous-names` | 표시 이름 · 설명 · 이름 변경 시 연결된 이전 이름 |
| 라벨 | `gimpo.io/restore-test=true` · `gimpo.io/etcd-job=snapshot\|drill` · `velero.io/repo-name` | 테스트 리소스 · etcd 잡 · Velero 정리 잡 |
| PVC `gimpo-web-accounts` | `accounts.json` | 계정·세션(PBKDF2-SHA256, 원자적 rename) |

## 10. 권한(RBAC)

| 범위 | 리소스 | 동작 | 용도 |
|---|---|---|---|
| ClusterRole | `velero.io/*` | 전체 | Velero 제어 |
| ClusterRole | namespaces | get/list/watch | 선택기 |
| Role(velero) | deployments, daemonsets | get/list | 상태 점검 |
| Role(velero) | jobs | get/list/create/delete | 정리 잡 정리, etcd 지금 실행 |
| Role(velero) | cronjobs | get/list | etcd 일정 |
| Role(velero) | pods, pods/log | get/list, get | etcd 결과 수집 |
| Role(velero) | configmaps | create · get/update/patch(이름 제한: `gimpo-restore-test`, `gimpo-etcd`) · get(`velero-repo-maintenance`) | 상태 저장 |
| Role(velero-restore-test) | pods, pvc, configmaps, secrets(+pods/log) | get/list/watch/create/delete | 복구 테스트 |

> Velero 복원은 클러스터 전체에 리소스를 만들 수 있으므로 대시보드는 사실상 높은 권한을 가진다. 그래서 웹 쓰기 작업은 admin 로그인으로만 허용하고, etcd 인증서는 대시보드가 아닌 스냅샷 Job 에만 마운트한다.

## 11. 설정(환경 변수)

| 변수 | 기본값 | 설명 |
|---|---|---|
| `PORT` / `HOST` | 3000 / 0.0.0.0 | 서버 |
| `VELERO_NAMESPACE` | velero | Velero NS |
| `STATIC_DIR` | - | SPA 정적 경로 |
| `DOWNLOAD_TIMEOUT_MS` | 30000 | DownloadRequest 대기 |
| `WEB_ACCESS_STORE` | `.web-standard/accounts.json` | 계정 파일 |
| `RESTORE_TEST_NAMESPACE` / `_IMAGE` / `_STATE_CM` | velero-restore-test / gimpo:latest / gimpo-restore-test | 복구 테스트 |
| `RESTORE_TEST_SCHEDULER=off` | - | 예약 실행 끄기(로컬) |
| `MAINT_JOB_CLEANUP=off` | - | 정리 잡 자동 정리 끄기 |
| etcd-tool 변수 | README 참고 | `ETCD_*`, `S3_*`, `RETENTION_DAYS`, `KEEP_MIN`, `SNAPSHOT_NAME` |

## 12. 빌드·배포

```bash
npm install && npm run typecheck && npm run build
docker build -t registry.local.cloud:5000/gimpo:<ver> . && docker push registry.local.cloud:5000/gimpo:<ver>
# deploy/deployment.yaml(image, RESTORE_TEST_IMAGE), deploy/etcd-backup.yaml(image) 버전 갱신 → PR → main 병합 → ArgoCD
```
Dockerfile 은 멀티 스테이지(deps → frontend build → backend build → runtime `node:22-slim`, `USER node`). Deployment 는 `readOnlyRootFilesystem`, 비루트(1000), `Recreate`(계정 파일 단일 writer).

## 13. 검증 기록

| 범위 | 방법 | 결과 |
|---|---|---|
| 복구 테스트 | 실제 클러스터, 로컬·배포본 각각 | 전 단계 성공(28~38초) |
| etcd 도구 | 로컬 TLS etcd 3.5.21 + SeaweedFS 컨테이너 | snapshot·drill 성공, 손상 스냅샷·보관 정리·잘못된 자격 증명(값 미노출) 확인 |
| etcd 롤백 | 로컬 3노드 클러스터, 생성된 절차서 명령 실행 | 사고 후 변경이 스냅샷 시점으로 복귀, 멤버 ID 유지, 쓰기 정상 |
| 배포 이미지 | 파드와 같은 보안 조건(docker read-only, cap drop) | snapshot·drill 성공 |
| 실제 클러스터 | etcd 3.5.26, 3멤버 | 스냅샷 126MB/3초, 복원 연습 8/8, 수집·절차서 정상 |
| 권한 | Fastify inject | 비로그인 401, 페이지 없음 403, viewer 쓰기 403 |

## 14. 알려진 제약

- CronJob 파드만 마운트하는 PVC 는 Velero 파일 백업 대상이 아니다(앱 측 "holder" 파드로 해결 — memonest 사례).
- NFS 기반 볼륨이라 CSI 스냅샷·VSL 을 쓰지 않는다(kopia 파일 백업만).
- MinIO 가 NFS 위에 있어 대량 데이터에서 목록 조회 지연 위험이 있다(현재는 설정 백업만 담당).
- 대시보드는 단일 레플리카 전제(계정 파일·스케줄러 직렬화).
- etcd 롤백은 자동 실행하지 않는다(설계상 의도).
