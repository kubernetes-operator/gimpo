<template>
  <div>
    <div class="page-header">
      <h2>상태 점검</h2>
      <div class="toolbar">
        <span v-if="report" style="font-size: 12px; color: var(--ws-muted); margin-right: 8px">
          점검 시각 {{ fmtTime(report.checkedAt) }} · 1분마다 자동 갱신
        </span>
        <el-button :icon="Refresh" :loading="loading" @click="load(true)">지금 점검</el-button>
      </div>
    </div>

    <!-- 전체 상태 -->
    <el-alert
      v-if="report"
      :type="alertType(report.overall)"
      :closable="false"
      show-icon
      :title="overallTitle"
      style="margin-bottom: 16px"
    >
      정상 {{ report.counts.ok }} · 주의 {{ report.counts.warn }} · 이상 {{ report.counts.fail }}
    </el-alert>

    <el-row :gutter="16">
      <!-- 점검 항목 -->
      <el-col :span="13">
        <el-card shadow="never" header="점검 항목">
          <el-table :data="sortedChecks" size="small" :show-header="true">
            <el-table-column label="" width="44">
              <template #default="{ row }"><span style="font-size: 16px">{{ icon(row.status) }}</span></template>
            </el-table-column>
            <el-table-column prop="category" label="분류" width="90" />
            <el-table-column prop="name" label="항목" min-width="170" show-overflow-tooltip />
            <el-table-column prop="message" label="내용" min-width="220">
              <template #default="{ row }">
                <span :style="{ color: row.status === 'fail' ? 'var(--ws-danger)' : row.status === 'warn' ? 'var(--ws-warning)' : 'var(--ws-text)' }">
                  {{ row.message }}
                </span>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-col>

      <!-- 스케줄별 -->
      <el-col :span="11">
        <el-card shadow="never" header="스케줄별 백업 상태">
          <div v-for="s in report?.schedules ?? []" :key="s.name" class="sched">
            <div style="display: flex; justify-content: space-between; align-items: center">
              <b>{{ icon(s.status) }} {{ s.displayName }}</b>
              <span style="font-size: 12px; color: var(--ws-muted)">{{ describeCron(s.schedule) }}</span>
            </div>
            <div class="sched-row">
              <span>최근</span>
              <span>
                <PhaseTag v-if="s.lastBackup" :phase="s.lastBackup.phase" />
                <template v-else>-</template>
                {{ fmtTime(s.lastBackup?.completedAt || s.lastBackup?.startedAt) }}
              </span>
            </div>
            <div class="sched-row"><span>마지막 성공</span><span>{{ fmtTime(s.lastSuccessAt) }}</span></div>
            <div class="sched-row"><span>다음 실행</span><span>{{ s.paused ? '일시정지' : fmtTime(s.nextRun) }}</span></div>
            <div class="sched-row"><span>저장 위치</span><span>{{ s.storageLocation || '(기본)' }}</span></div>
            <div style="font-size: 12px; margin-top: 2px" :style="{ color: s.status === 'ok' ? 'var(--ws-success)' : s.status === 'warn' ? 'var(--ws-warning)' : 'var(--ws-danger)' }">
              {{ s.message }}
            </div>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <!-- 자동 복구 테스트 -->
    <el-card shadow="never" style="margin-top: 16px">
      <template #header>
        <div style="display: flex; justify-content: space-between; align-items: center">
          <span>
            자동 복구 테스트
            <el-tag size="small" :type="rt?.config.enabled ? 'success' : 'info'" style="margin-left: 6px">
              {{ rt?.config.enabled ? '켜짐' : '꺼짐' }}
            </el-tag>
            <span v-if="rt?.config.enabled && rt?.nextRuns?.[0]" style="font-size: 12px; color: var(--ws-muted); margin-left: 8px">
              다음 실행 {{ fmtTime(rt.nextRuns[0]) }}
            </span>
          </span>
          <span>
            <el-button v-if="canWrite" size="small" @click="cfgVisible = true">설정</el-button>
            <el-button v-if="canWrite" size="small" type="primary" :loading="!!rt?.running" @click="runNow">
              {{ rt?.running ? '실행 중…' : '지금 실행' }}
            </el-button>
          </span>
        </div>
      </template>

      <el-alert type="info" :closable="false" style="margin-bottom: 12px">
        테스트 전용 네임스페이스 <code>{{ rt?.namespace }}</code> 에 <b>오늘 날짜가 들어간</b> Pod·PVC·ConfigMap·Secret 을 만들고
        → 백업 → 삭제(장애 재현) → 복구 → 내용 비교 → 정리합니다. 운영 중인 앱에는 영향이 없습니다.
      </el-alert>

      <!-- 진행 중 / 최근 실행 단계 -->
      <div v-if="shownRun" style="margin-bottom: 16px">
        <div style="margin-bottom: 8px; font-size: 13px">
          <b>{{ shownRun.status === 'running' ? '진행 중' : '최근 실행' }}</b>
          <el-tag size="small" :type="runTag(shownRun.status)" style="margin: 0 6px">{{ runLabel(shownRun.status) }}</el-tag>
          {{ fmtTime(shownRun.startedAt) }}
          <span v-if="shownRun.durationSec" style="color: var(--ws-muted)"> · {{ shownRun.durationSec }}초</span>
          <span v-if="shownRun.marker" style="color: var(--ws-muted)"> · 테스트 데이터 "{{ shownRun.marker.content }}"</span>
        </div>
        <el-steps :active="activeStep(shownRun)" finish-status="success" align-center>
          <el-step
            v-for="st in shownRun.steps"
            :key="st.key"
            :title="st.name"
            :status="stepStatus(st.status)"
            :description="st.message"
          />
        </el-steps>
        <el-alert v-if="shownRun.error" type="error" :closable="false" :title="shownRun.error" style="margin-top: 8px" />
      </div>

      <el-table :data="rt?.history ?? []" size="small" stripe max-height="360">
        <el-table-column type="expand">
          <template #default="{ row }">
            <div style="padding: 4px 24px">
              <div v-for="st in row.steps" :key="st.key" style="font-size: 12px; line-height: 1.8">
                {{ stepIcon(st.status) }} <b>{{ st.name }}</b>
                <span style="color: var(--ws-muted)"> {{ st.message }}</span>
              </div>
              <div v-if="row.marker" style="font-size: 12px; color: var(--ws-muted); margin-top: 4px">
                데이터 "{{ row.marker.content }}" · sha256 원본 {{ row.marker.blobSha?.slice(0, 16) }}… / 복구
                {{ row.marker.restoredBlobSha?.slice(0, 16) ?? '-' }}…
              </div>
              <div style="font-size: 12px; color: var(--ws-muted)">백업 {{ row.backupName }} · 복구 {{ row.restoreName }}</div>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="결과" width="90">
          <template #default="{ row }"><el-tag size="small" :type="runTag(row.status)">{{ runLabel(row.status) }}</el-tag></template>
        </el-table-column>
        <el-table-column label="시작" width="170">
          <template #default="{ row }">{{ fmtTime(row.startedAt) }}</template>
        </el-table-column>
        <el-table-column label="방식" width="80">
          <template #default="{ row }">{{ row.trigger === 'manual' ? '수동' : '예약' }}</template>
        </el-table-column>
        <el-table-column label="소요" width="80">
          <template #default="{ row }">{{ row.durationSec != null ? `${row.durationSec}초` : '-' }}</template>
        </el-table-column>
        <el-table-column prop="storageLocation" label="저장 위치" width="130" />
        <el-table-column label="내용" min-width="240" show-overflow-tooltip>
          <template #default="{ row }">{{ row.error || '모든 데이터 일치' }}</template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 복구 테스트 설정 -->
    <el-dialog v-model="cfgVisible" title="자동 복구 테스트 설정" width="640px" destroy-on-close @open="openCfg">
      <el-form label-position="top">
        <el-form-item label="자동 실행">
          <el-switch v-model="cfg.enabled" active-text="켜기" inactive-text="끄기" />
        </el-form-item>
        <el-form-item label="실행 일정">
          <CronBuilder v-model="cfg.schedule" />
        </el-form-item>
        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="테스트 백업 저장 위치">
              <el-select v-model="cfg.storageLocation" style="width: 100%">
                <el-option v-for="b in bslNames" :key="b" :label="b" :value="b" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="제한 시간(분)">
              <el-input-number v-model="cfg.timeoutMinutes" :min="5" :max="180" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="테스트 백업 보관 기간">
              <el-input v-model="cfg.backupTtl" placeholder="72h0m0s" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="복구 기록 보관 개수">
              <el-input-number v-model="cfg.keepRestores" :min="1" :max="50" />
            </el-form-item>
          </el-col>
        </el-row>
      </el-form>
      <template #footer>
        <el-button @click="cfgVisible = false">취소</el-button>
        <el-button v-if="canWrite" type="primary" :loading="savingCfg" @click="saveCfg">저장</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed as accessComputed } from 'vue';
import { webAccess } from '@/web-access';
const canWrite = accessComputed(() => webAccess.role === 'admin');
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { Refresh } from '@element-plus/icons-vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  api,
  type HealthReport,
  type Level,
  type RestoreTestConfig,
  type RestoreTestRun,
  type RestoreTestState,
} from '@/api/client';
import PhaseTag from '@/components/PhaseTag.vue';
import CronBuilder from '@/components/CronBuilder.vue';
import { fmtTime } from '@/utils/format';
import { describeCron } from '@/utils/cron';

const report = ref<HealthReport | null>(null);
const rt = ref<RestoreTestState | null>(null);
const loading = ref(false);

const icon = (l: Level) => (l === 'ok' ? '🟢' : l === 'warn' ? '🟡' : '🔴');
const alertType = (l: Level) => (l === 'ok' ? 'success' : l === 'warn' ? 'warning' : 'error');
const overallTitle = computed(() =>
  report.value?.overall === 'ok'
    ? '백업·복구 정상'
    : report.value?.overall === 'warn'
      ? '확인이 필요한 항목이 있습니다'
      : '이상 항목이 있습니다 — 아래 빨간 항목을 확인하세요',
);
const order: Record<Level, number> = { fail: 0, warn: 1, ok: 2 };
const sortedChecks = computed(() =>
  [...(report.value?.checks ?? [])].sort((a, b) => order[a.status] - order[b.status]),
);

const runTag = (s: RestoreTestRun['status']) =>
  s === 'success' ? 'success' : s === 'running' ? 'primary' : s === 'aborted' ? 'info' : 'danger';
const runLabel = (s: RestoreTestRun['status']) =>
  ({ success: '성공', failed: '실패', running: '진행 중', aborted: '중단' })[s];
const stepStatus = (s: string) =>
  s === 'success' ? 'success' : s === 'failed' ? 'error' : s === 'running' ? 'process' : 'wait';
const stepIcon = (s: string) =>
  s === 'success' ? '✅' : s === 'failed' ? '❌' : s === 'running' ? '⏳' : s === 'skipped' ? '⏭️' : '⬜';
const activeStep = (r: RestoreTestRun) => {
  const i = r.steps.findIndex((s) => s.status !== 'success');
  return i < 0 ? r.steps.length : i;
};
const shownRun = computed(() => rt.value?.running ?? rt.value?.history?.[0] ?? null);

async function load(refresh = false) {
  loading.value = true;
  try {
    const [h, r] = await Promise.all([api.healthReport(refresh), api.restoreTest()]);
    report.value = h;
    rt.value = r;
  } finally {
    loading.value = false;
  }
}

async function runNow() {
  await ElMessageBox.confirm(
    '테스트 전용 네임스페이스에서 복구 테스트를 지금 실행합니다. 보통 1~3분 걸립니다.',
    '복구 테스트 실행',
    { type: 'info', confirmButtonText: '실행', cancelButtonText: '취소' },
  );
  await api.runRestoreTest();
  ElMessage.success('복구 테스트를 시작했습니다');
  await load();
}

// 설정
const cfgVisible = ref(false);
const savingCfg = ref(false);
const bslNames = ref<string[]>([]);
const cfg = reactive<RestoreTestConfig>({
  enabled: true,
  schedule: '',
  storageLocation: '',
  timeoutMinutes: 20,
  backupTtl: '72h0m0s',
  keepRestores: 7,
});
async function openCfg() {
  if (rt.value) Object.assign(cfg, rt.value.config);
  bslNames.value = (await api.listBSL().catch(() => [])).map((b) => b.metadata.name!).filter(Boolean);
}
async function saveCfg() {
  savingCfg.value = true;
  try {
    await api.updateRestoreTestConfig({ ...cfg });
    ElMessage.success('저장됨');
    cfgVisible.value = false;
    await load();
  } finally {
    savingCfg.value = false;
  }
}

// 자동 갱신: 평소 60초, 복구 테스트 진행 중엔 4초
let timer: ReturnType<typeof setTimeout> | undefined;
function schedule() {
  timer = setTimeout(async () => {
    try {
      if (rt.value?.running) rt.value = await api.restoreTest();
      else await load();
    } catch {
      /* 다음 주기에 재시도 */
    }
    schedule();
  }, rt.value?.running ? 4000 : 60000);
}
onMounted(async () => {
  await load();
  schedule();
});
onBeforeUnmount(() => clearTimeout(timer));
</script>

<style scoped>
.sched {
  padding: 8px 0;
  border-bottom: 1px solid #f0f2f5;
}
.sched:last-child {
  border-bottom: none;
}
.sched-row {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  color: var(--ws-text);
  line-height: 1.7;
}
</style>
