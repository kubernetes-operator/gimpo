/** 백엔드 전역 설정. 자격증명은 절대 여기에 넣지 않는다(인증은 kubeconfig/SA 로만). */
export const config = {
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? '0.0.0.0',
  /** Velero 가 설치된 네임스페이스. velero.io 네임스페이스 스코프 리소스의 기준. */
  veleroNamespace: process.env.VELERO_NAMESPACE ?? 'velero',
  /** DownloadRequest 의 signed URL 이 채워질 때까지 폴링 최대 시간(ms). */
  downloadTimeoutMs: Number(process.env.DOWNLOAD_TIMEOUT_MS ?? 30000),
  /** SPA 정적 파일 디렉터리. 설정되면 Fastify 가 서빙(프로덕션). 미설정이면 개발 모드. */
  staticDir: process.env.STATIC_DIR || undefined,
  logLevel: process.env.LOG_LEVEL ?? 'info',

  /** 자동 복구 테스트 */
  restoreTest: {
    /** 테스트 전용 네임스페이스. deploy/restore-test.yaml 이 Namespace·Role 을 GitOps 로 관리한다. */
    namespace: process.env.RESTORE_TEST_NAMESPACE ?? 'velero-restore-test',
    /** 테스트 파드 이미지 — 내부 레지스트리의 대시보드 이미지를 재사용(sh/sleep 포함, 외부 pull 불필요). */
    image: process.env.RESTORE_TEST_IMAGE ?? 'registry.local.cloud:5000/gimpo:latest',
    /** 설정·이력 저장용 ConfigMap (velero 네임스페이스) */
    stateConfigMap: process.env.RESTORE_TEST_STATE_CM ?? 'gimpo-restore-test',
    /** 스케줄러 비활성화(로컬 개발 등) */
    schedulerDisabled: process.env.RESTORE_TEST_SCHEDULER === 'off',
  },
};
