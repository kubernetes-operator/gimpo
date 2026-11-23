# gimpo 운영 매뉴얼

> 대상: 랩 클러스터 백업·복구를 운영하는 관리자
> 함께 보기: [사용 설명서](USER_GUIDE.md) · [Velero 재설치·장애 기록](../deploy/velero/README.md)

---

## 1. 한눈에 보기

**목표**: 랩 클러스터의 백업을 "믿고 쓸 수 있게" 만들고, 웹(`/velero/`)에서 쉽게 관리한다.
**원칙**: 백업이 있는지가 아니라 **복구가 되는지**를 매일 자동으로 확인한다.

| 층 | 무엇을 | 어떻게 | 어디에 | 언제 (KST) | 보관 |
|---|---|---|---|---|---|
| ① 설정 백업 | 모든 리소스(YAML), 볼륨 데이터 제외 | Velero `velero-config-backup` | MinIO `osc-backup` | 매일 03:30 | 30일 |
| ② 앱 데이터 백업 | default·demo-app·memonest — YAML + PVC 데이터 | Velero `velero-daily-app-backup` | SeaweedFS `velero-backups` | 매일 03:00 | 7일 |
| ③ 전체 데이터 백업 | 모든 네임스페이스(velero 제외) — YAML + PVC 데이터 | Velero `velero-monthly-full-backup` | SeaweedFS `velero-backups` | 매월 2일 04:03 | 35일 |
| ④ etcd 스냅샷 | 쿠버네티스 전체 상태(한 시점) | CronJob `gimpo-etcd-snapshot` | SeaweedFS `etcd-snapshots` | 6시간마다 | 7일(최소 3개) |
| 검증 A | Velero 복구 테스트 | 대시보드 내장 | 테스트 NS `velero-restore-test` | 매일 05:00 | 이력 60건 |
| 검증 B | etcd 복원 연습 | CronJob `gimpo-etcd-restore-drill` | 임시 etcd(파드 안) | 매일 05:30 | 이력 120건 |

- memonest 는 DB 덤프를 02:30 에 만들고(앱 자체 CronJob), 03:00 Velero 백업이 덤프 폴더까지 가져간다(`memonest-api-backup-holder`).
- **언제 무엇으로 복구하나**: 앱·네임스페이스 하나 → Velero(②③, 설정만이면 ①). 클러스터 전체 붕괴·업그레이드 실패 → etcd(④).

## 2. 구성 요소

```
          ┌──────────── 웹 (test2.studiobasa.com/velero/) ────────────┐
          │  gimpo 대시보드 (velero NS, 1 replica, 로그인·페이지 권한)   │
          │   ├─ Velero CRD 조회·생성 (백업/복구/스케줄/BSL)              │
          │   ├─ 상태 점검(1분) · 복구 테스트 스케줄러 · 정리 잡 자동 정리  │
          │   └─ etcd 잡 결과 수집 · 지금 실행 · 롤백 절차서 생성          │
          └──────────────────────────────────────────────────────────┘
 Velero 서버 + node-agent(8노드)  ──▶  MinIO(osc-backup, NFS NAS)     : ① 설정
                                  └▶  SeaweedFS(velero-backups)     : ②③ 데이터
 CronJob gimpo-etcd-snapshot(컨트롤 플레인) ─▶ SeaweedFS(etcd-snapshots) : ④
 CronJob gimpo-etcd-restore-drill(컨트롤 플레인) ◀─ 위 스냅샷을 임시 etcd 로 복원 검증
```

| 리소스 | 위치 | 관리 방식 |
|---|---|---|
| 대시보드 Deployment·RBAC·HTTPRoute·etcd CronJob | `deploy/` | **ArgoCD**(main 브랜치 자동 동기화) |
| Velero(서버·스케줄·BSL·node-agent) | `deploy/velero/values.yaml` | **Helm** 릴리스 `velero`(수동 upgrade) |
| memonest 백업 홀더 | `pangyo` 저장소 차트 | Helm 릴리스 `memonest-api` |
| 복구 테스트 설정·이력 | ConfigMap `velero/gimpo-restore-test` | 대시보드가 기록 |
| etcd 스냅샷·연습 이력 | ConfigMap `velero/gimpo-etcd` | 대시보드가 기록 |
| 로그인 계정 | PVC `gimpo-web-accounts` | 대시보드 |

## 3. 매일 확인 (5분)

1. 웹 **개요** 상단 배너가 🟢 "백업·복구 정상" 인지 본다.
2. 🟡/🔴 이면 **상태 점검**에서 빨간 항목부터 → 아래 6장 대응표로 간다.
3. 주 1회: **etcd 백업** 화면에서 멤버 3/3, 최근 복원 연습 성공을 확인한다.

## 4. 상태 점검 항목

| 분류 | 항목 | 🟡 / 🔴 기준 |
|---|---|---|
| 서버 | Velero 서버, node-agent | Ready 아님 |
| 저장소 | 저장 위치(BSL) | Available 아님 / 1시간 넘게 미확인 |
| 스케줄 | 스케줄별 최근 백업 | 예정 시각에 미실행 🔴, PartiallyFailed 🟡, 6시간 넘게 진행 🔴 |
| 작업 | 멈춘 PVB·PVR·DataUpload | 4시간 넘게 진행 🔴 |
| 작업 | 처리 대기 삭제 요청 | 1시간 🟡 / 24시간 🔴 |
| 작업 | 저장소 정리(maintenance) 잡 | 6시간 넘게 실행 🔴, 7일 내 실패 🟡 |
| 작업 | 끝난 정리 잡 자동 정리 | 정리 대상 50개 초과·정리 실패 🟡 |
| 복구 테스트 | 자동 복구 테스트 | 실패 🔴, 꺼짐·오래됨 🟡 |
| etcd | 스냅샷 | 최근 실패 🔴, 주기 1.5배 지연 🟡 / 4배 🔴 |
| etcd | 멤버(스냅샷 시점) | 응답 수 ≠ 멤버 수, 리더 ≠ 1, 오류 🟡 |
| etcd | 복원 연습 | 실패 🔴, 36시간 넘게 성공 없음 🟡 |

## 5. 자동화 동작

### 5.1 Velero 복구 테스트 (매일 05:00)
테스트 NS 에 **날짜가 들어간** Pod·PVC(파일+1MiB 난수)·ConfigMap·Secret 생성 → SeaweedFS 로 백업 → 삭제 → 복구 → 내용·sha256 비교 → 정리.
실패하면 테스트 리소스를 남겨 두고(원인 분석용) 다음 실행 때 정리한다. 설정은 상태 점검 화면 → 설정.

### 5.2 끝난 정리 잡 자동 정리 (1시간마다)
Velero 저장소 정리 잡 중 ① 주인 없는 잡(저장소 기록이 사라짐) ② 저장소별 최신 N개(`keepLatestMaintenanceJobs`, 현재 1) 초과분을 삭제. 진행 중 잡은 건드리지 않는다.

### 5.3 etcd 스냅샷 (6시간마다)
컨트롤 플레인 노드에서 노드에 설치된 `etcdctl` 로 스냅샷 → `etcdutl snapshot status` 로 무결성 확인 → sha256 계산 → SeaweedFS 업로드(서명에 sha256 포함) → 메타데이터(JSON) 업로드 → 7일 지난 것 삭제(최신 3개는 항상 보관).
메타데이터에 멤버 목록·peer 주소·클러스터 토큰·데이터 폴더가 함께 저장되어 롤백 절차서 생성에 쓰인다.

### 5.4 etcd 복원 연습 (매일 05:30)
최신(또는 지정) 스냅샷을 내려받아 sha256 확인 → 파드 안 임시 디렉터리에 `etcdutl snapshot restore` → 노드의 `etcd` 바이너리로 **임시 etcd**(127.0.0.1) 기동 → 리비전·핵심 키·네임스페이스 수 확인 → 종료·삭제. **운영 etcd 에는 접속하지 않는다.**

## 6. 장애 대응표

| 증상 | 확인 | 조치 |
|---|---|---|
| 스케줄 "예정된 백업이 실행되지 않음" | `kubectl -n velero get schedules.velero.io` 의 PAUSED, Velero 서버 Ready | 일시정지면 스케줄 화면에서 재개. 서버 문제면 `kubectl -n velero logs deploy/velero` |
| 백업 PartiallyFailed | 백업 화면 → 상세 → 결과(errors) | 끝난 Job 파드 볼륨 경고는 무해. control-plane 파드 오류면 node-agent toleration 확인 |
| 멈춘 PVB 🔴 / 저장소 정리 잡 6시간+ | MinIO 지연 여부: `kubectl -n velero logs minio-0 \| grep 'IAM refresh took'` (수십 초 이상이면 지연) | [Velero README 장애 기록](../deploy/velero/README.md) 의 초기화 절차 참고. 멈춘 PVB 삭제 + 해당 노드 node-agent 재시작 |
| BSL Unavailable | `kubectl -n velero get backupstoragelocations.velero.io`, 저장소 접속 | SeaweedFS(192.168.78.101:8333)·MinIO 상태 확인, 자격 증명 시크릿 확인(값은 열람하지 말 것) |
| 복구 테스트 실패 | 상태 점검 → 복구 테스트 이력 → 실패 단계 | 백업 단계 실패면 BSL, 복구 단계면 node-agent, 검증 단계면 데이터 경로 점검. 테스트 리소스는 `velero-restore-test` 에 남아 있음 |
| etcd 스냅샷 실패 | etcd 화면 → 스냅샷 이력 → 오류, `kubectl -n velero logs job/<잡>` | "인증서를 찾지 못함" → `/etc/ssl/etcd/ssl/admin-<노드>.pem` 확인. S3 403 → `seaweedfs-credentials`. etcd 접속 실패 → etcd 멤버 상태 |
| etcd 복원 연습 실패 | etcd 화면 → 복원 연습 이력 → 실패 검증 항목 | sha256 불일치 → 저장소 손상, 다른 스냅샷으로 연습. 기동 실패 → 잡 로그의 etcd 출력 확인 |
| etcd 멤버 🟡 | 컨트롤 플레인 노드에서 `systemctl status etcd` | 멤버 1개 장애는 쿼럼 유지(3중 2). 2개 이상이면 즉시 대응(롤백 검토) |

## 7. 복구 절차

### 7.1 앱 하나 복구 (Velero) — 가장 흔한 경우
1. **복구 메뉴 → 복구 생성**, 소스 백업에서 해당 앱이 들어 있는 최신 **Completed** 백업 선택(데이터가 필요하면 ②/③, 설정만이면 ①).
2. 포함 네임스페이스에 앱 NS 지정.
3. 먼저 확인만 하려면 **네임스페이스 매핑**으로 `원본=원본-restore-test` 처럼 다른 NS 로 복구 → 확인 후 그 NS 삭제.
   - 고정 NodePort 를 쓰는 Service 는 원본과 충돌해 오류 1건이 날 수 있다(정상). HTTPRoute/Ingress/Job 은 제외 리소스로 빼면 안전하다.
4. 실제 복구: 원본 NS 를 지운 뒤 같은 이름으로 복구(PV 복구 = 예).

### 7.2 클러스터 재구축 (DR)
1. Velero 설치(`deploy/velero/README.md`) → 시크릿 2종(`velero-minio-credentials`, `seaweedfs-credentials`) 직접 생성.
2. ③ 전체 데이터 백업으로 복구 → ① 최신 설정 백업으로 덮기(이미 있는 리소스는 Velero 가 건너뜀).
3. ArgoCD 로 관리되는 앱은 Git 기준으로 다시 맞춰진다.

### 7.3 etcd 롤백 (클러스터 전체를 한 시점으로)
**언제**: 쿠버네티스 업그레이드 실패, 대량 삭제 사고, 컨트롤 플레인 상태 손상. 앱 하나 문제에는 쓰지 않는다.
**영향**: 스냅샷 이후 만든/바꾼 리소스가 모두 사라진다. PVC 데이터(NFS)는 되돌아가지 않는다. 작업 중 쿠버네티스 API 가 멈춘다(실행 중 파드는 계속 동작).

1. etcd 화면 → **지금 스냅샷**(현재 상태 보존) → 되돌릴 스냅샷에서 **이 스냅샷으로 연습** → 성공 확인.
2. 해당 스냅샷의 **절차서** 버튼 → 노드별 명령이 이 클러스터 값(멤버 이름·peer 주소·토큰·데이터 폴더)으로 채워진 절차서가 나온다 → Markdown 으로 저장.
3. 절차서 순서대로 실행: ① 스냅샷을 3개 컨트롤 플레인 노드로 복사 ② 컨트롤 플레인 매니페스트 이동(정지) ③ `systemctl stop etcd` ④ **노드별** `etcdutl snapshot restore` ⑤ `systemctl start etcd` 후 health·member list 확인 ⑥ 매니페스트 복귀 → `kubectl get nodes`.
4. 실패하면 절차서의 "되돌리기"로 `<data-dir>.before-restore-<시각>` 를 되살린다.

> 이 절차는 로컬 3노드 TLS etcd(v3.5.21)에서 그대로 실행해 검증했다: 사고 후 변경(키 추가·삭제)이 스냅샷 시점으로 정확히 돌아가고, 멤버 ID 유지·리더 선출·쓰기 정상.
> 조직 규칙: 변경 권한 SSH 작업은 명령 단위로 승인을 받는다.

## 8. 배포와 변경

### 8.1 흐름
코드·매니페스트 수정 → 작업 브랜치(`feature/*`) push → PR → **main 병합** → ArgoCD 자동 배포.
```bash
# PR 병합 (gh pr merge 는 토큰 권한 부족으로 실패할 수 있어 REST 사용)
gh api -X PUT repos/kubernetes-operator/gimpo/pulls/<번호>/merge -f merge_method=merge
```

### 8.2 이미지
```bash
npm run build                      # 프론트·백엔드 빌드 확인
docker build -t registry.local.cloud:5000/gimpo:<버전> .
docker push registry.local.cloud:5000/gimpo:<버전>
# deploy/deployment.yaml 의 image 와 RESTORE_TEST_IMAGE, deploy/etcd-backup.yaml 의 image 를 같은 버전으로
```

### 8.3 Velero 설정 변경
`deploy/velero/values.yaml` 수정 → PR. 클러스터 반영은 `helm upgrade velero vmware-tanzu/velero --version 12.0.1 -n velero -f deploy/velero/values.yaml`(승인 필요). 웹에서 바꾼 스케줄은 values 에도 반영해 둔다(다음 upgrade 때 원복 방지).

### 8.4 etcd 백업 설정 변경
`deploy/etcd-backup.yaml` 의 `schedule`(KST, `timeZone: Asia/Seoul`), `RETENTION_DAYS`, `KEEP_MIN`, `S3_ENDPOINT` 수정 → PR 병합.

## 9. 보안

- **자격 증명**: S3 자격 증명은 기존 시크릿(`velero-minio-credentials`, `seaweedfs-credentials`)만 사용하고, 대시보드·로그·문서에 값을 남기지 않는다. 시크릿 생성·변경은 사람이 직접 한다.
- **etcd 인증서**: 클러스터 관리자급 권한이다. 스냅샷 잡만 `/etc/ssl/etcd/ssl` 을 **읽기 전용**으로 마운트하고(복원 연습은 인증서 없음), 컨테이너는 `readOnlyRootFilesystem`, 권한은 `DAC_READ_SEARCH` 하나만 추가한다.
- **대시보드 권한**: Velero CRD 전체 + velero NS 의 Job 생성/삭제(정리·지금 실행) + 테스트 NS 쓰기. Velero 복원은 원래 클러스터 전체에 리소스를 만들 수 있으므로, 대시보드는 **관리자 로그인만 쓰기 작업**을 할 수 있다(일반 사용자는 조회만, 페이지별 허용).
- **롤백은 웹에서 실행하지 않는다**: 절차서만 생성하고 실행은 사람이 SSH 로 한다.

## 10. 참고: etcd 구성 방식

이 클러스터의 etcd 는 Kubespray **systemd(host) 방식**이다(etcd 파드 없음, 각 컨트롤 플레인 노드의 `etcd.service`, 설정 `/etc/etcd.env`, 인증서 `/etc/ssl/etcd/ssl`).
백업은 컨테이너(static pod) 방식과 같지만, **복구·롤백은 systemd 방식이 유리**하다 — 쿠버네티스(kubelet·컨테이너 런타임)와 독립적으로 etcd 를 멈추고 복원하고 띄울 수 있기 때문이다.
