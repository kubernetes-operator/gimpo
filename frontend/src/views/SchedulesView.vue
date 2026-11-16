<template>
  <div>
    <div class="page-header">
      <h2>스케줄</h2>
      <div class="toolbar">
        <el-button :icon="Refresh" @click="load">새로고침</el-button>
        <el-button type="primary" :icon="Plus" @click="openCreate">스케줄 생성</el-button>
      </div>
    </div>

    <el-table :data="schedules" v-loading="loading" size="small" stripe>
      <el-table-column label="이름" min-width="230">
        <template #default="{ row }">
          <div style="font-weight: 600">{{ row.gimpo?.displayName || row.metadata.name }}</div>
          <div v-if="row.gimpo?.displayName" style="font-size: 12px; color: #909399">{{ row.metadata.name }}</div>
          <div v-if="row.gimpo?.description" style="font-size: 12px; color: #909399">{{ row.gimpo.description }}</div>
          <el-tag v-if="row.gimpo?.helmManaged" size="small" type="info" effect="plain">Helm</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="일정 (한국 시간)" width="170">
        <template #default="{ row }">
          <div>{{ describeCron(row.spec?.schedule) }}</div>
          <div style="font-size: 11px; color: #c0c4cc">{{ row.spec?.schedule }}</div>
        </template>
      </el-table-column>
      <el-table-column label="다음 실행" width="170">
        <template #default="{ row }">{{ row.spec?.paused ? '일시정지' : fmtTime(row.gimpo?.nextRuns?.[0]) }}</template>
      </el-table-column>
      <el-table-column label="상태" width="100">
        <template #default="{ row }">
          <el-tag :type="row.spec?.paused ? 'info' : 'success'" size="small">
            {{ row.spec?.paused ? 'Paused' : 'Enabled' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="마지막 백업" width="160">
        <template #default="{ row }">{{ fmtTime(row.status?.lastBackup) }}</template>
      </el-table-column>
      <el-table-column label="저장 위치 / 보관" width="170">
        <template #default="{ row }">
          <div>{{ row.spec?.template?.storageLocation || '(기본)' }}</div>
          <div style="font-size: 12px; color: #909399">{{ fmtTtl(row.spec?.template?.ttl) }}</div>
        </template>
      </el-table-column>
      <el-table-column label="작업" width="400" fixed="right">
        <template #default="{ row }">
          <el-button size="small" type="primary" plain @click="openEdit(row)">편집</el-button>
          <el-button size="small" @click="openHistory(row)">이력</el-button>
          <el-button size="small" @click="showYaml(row)">YAML</el-button>
          <el-button size="small" type="warning" @click="togglePause(row)">
            {{ row.spec?.paused ? '재개' : '일시중지' }}
          </el-button>
          <el-button size="small" type="primary" @click="trigger(row)">즉시 실행</el-button>
          <el-button size="small" type="danger" @click="del(row)">삭제</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="createVisible" title="스케줄 생성" width="860px" top="4vh" destroy-on-close>
      <el-form label-position="top">
        <el-row :gutter="16">
          <el-col :span="12">
            <el-form-item label="스케줄 이름 (영문 소문자·숫자·하이픈, 나중에 바꾸기 어려움)" required>
              <el-input v-model="form.name" placeholder="예: app-data-daily" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="표시 이름 (언제든 변경 가능)">
              <el-input v-model="form.displayName" placeholder="예: 앱 데이터 일일 백업" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item label="설명">
          <el-input v-model="form.description" />
        </el-form-item>
      </el-form>
      <el-divider content-position="left">실행 일정</el-divider>
      <CronBuilder v-model="form.schedule" />
      <el-divider content-position="left">백업 내용 (template)</el-divider>
      <BackupSpecForm v-model="form.spec" />
      <template #footer>
        <el-button @click="previewVisible = true">YAML 미리보기</el-button>
        <el-button @click="createVisible = false">취소</el-button>
        <el-button type="primary" :loading="submitting" @click="submit">생성</el-button>
      </template>
    </el-dialog>

    <ScheduleEditDialog v-model="editVisible" :schedule="current" @saved="load" />
    <ScheduleHistoryDialog v-model="historyVisible" :schedule="current" />
    <YamlViewer v-model="previewVisible" title="스케줄 spec 미리보기" :data="previewData" />
    <YamlViewer v-model="yamlVisible" title="Schedule CR" :data="current" />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { Refresh, Plus } from '@element-plus/icons-vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api, type ScheduleCR } from '@/api/client';
import YamlViewer from '@/components/YamlViewer.vue';
import BackupSpecForm from '@/components/BackupSpecForm.vue';
import CronBuilder from '@/components/CronBuilder.vue';
import ScheduleEditDialog from '@/components/ScheduleEditDialog.vue';
import ScheduleHistoryDialog from '@/components/ScheduleHistoryDialog.vue';
import { fmtTime } from '@/utils/format';
import { describeCron, KST_PREFIX } from '@/utils/cron';

const schedules = ref<ScheduleCR[]>([]);
const loading = ref(false);

async function load() {
  loading.value = true;
  try {
    schedules.value = await api.listSchedules();
  } finally {
    loading.value = false;
  }
}

function fmtTtl(ttl?: string) {
  if (!ttl) return '보관 기간 기본값';
  const h = Number(/^(\d+)h/.exec(ttl)?.[1] ?? NaN);
  if (Number.isNaN(h)) return ttl;
  return h % 24 === 0 ? `${h / 24}일 보관` : `${h}시간 보관`;
}

const createVisible = ref(false);
const submitting = ref(false);
const previewVisible = ref(false);
const form = reactive<{ name: string; displayName: string; description: string; schedule: string; spec: Record<string, any> }>({
  name: '',
  displayName: '',
  description: '',
  schedule: '',
  spec: {},
});

function openCreate() {
  form.name = '';
  form.displayName = '';
  form.description = '';
  form.schedule = `${KST_PREFIX} 0 3 * * *`;
  form.spec = { ttl: '720h0m0s', defaultVolumesToFsBackup: true, snapshotVolumes: false };
  createVisible.value = true;
}

const previewData = computed(() => ({
  apiVersion: 'velero.io/v1',
  kind: 'Schedule',
  metadata: { name: form.name, namespace: 'velero' },
  spec: { schedule: form.schedule, template: form.spec },
}));

async function submit() {
  if (!form.name) return ElMessage.warning('스케줄 이름을 입력하세요');
  if (!form.schedule) return ElMessage.warning('일정을 입력하세요');
  submitting.value = true;
  try {
    await api.createSchedule({
      name: form.name,
      displayName: form.displayName,
      description: form.description,
      spec: { schedule: form.schedule, template: form.spec },
    });
    ElMessage.success('스케줄 생성됨');
    createVisible.value = false;
    await load();
  } finally {
    submitting.value = false;
  }
}

const current = ref<ScheduleCR | null>(null);
const yamlVisible = ref(false);
const editVisible = ref(false);
const historyVisible = ref(false);
function showYaml(row: ScheduleCR) {
  current.value = row;
  yamlVisible.value = true;
}
function openEdit(row: ScheduleCR) {
  current.value = row;
  editVisible.value = true;
}
function openHistory(row: ScheduleCR) {
  current.value = row;
  historyVisible.value = true;
}

const label = (row: ScheduleCR) => row.gimpo?.displayName || row.metadata.name!;

async function togglePause(row: ScheduleCR) {
  const paused = !row.spec?.paused;
  await api.pauseSchedule(row.metadata!.name!, paused);
  ElMessage.success(paused ? '일시중지됨' : '재개됨');
  await load();
}

async function trigger(row: ScheduleCR) {
  await ElMessageBox.confirm(`'${label(row)}' 스케줄의 설정으로 백업을 지금 실행합니다.`, '즉시 실행', {
    type: 'warning',
    confirmButtonText: '실행',
    cancelButtonText: '취소',
  });
  await api.triggerSchedule(row.metadata!.name!);
  ElMessage.success('백업 생성 요청됨');
}

async function del(row: ScheduleCR) {
  await ElMessageBox.confirm(
    `'${label(row)}' 스케줄을 삭제합니다. 이미 만들어진 백업은 보관 기간까지 남습니다.`,
    '삭제 확인',
    { type: 'warning', confirmButtonText: '삭제', cancelButtonText: '취소' },
  );
  await api.deleteSchedule(row.metadata!.name!);
  ElMessage.success('삭제됨');
  await load();
}

onMounted(load);
</script>
