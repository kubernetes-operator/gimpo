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
      <el-table-column prop="metadata.name" label="이름" min-width="220" show-overflow-tooltip />
      <el-table-column label="cron" width="140" prop="spec.schedule" />
      <el-table-column label="상태" width="120">
        <template #default="{ row }">
          <el-tag :type="row.spec?.paused ? 'info' : 'success'" size="small">
            {{ row.spec?.paused ? 'Paused' : 'Enabled' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="마지막 백업" width="170">
        <template #default="{ row }">{{ fmtTime(row.status?.lastBackup) }}</template>
      </el-table-column>
      <el-table-column label="TTL" width="120" prop="spec.template.ttl" />
      <el-table-column label="작업" width="360" fixed="right">
        <template #default="{ row }">
          <el-button size="small" @click="showYaml(row)">YAML</el-button>
          <el-button size="small" type="warning" @click="togglePause(row)">
            {{ row.spec?.paused ? '재개' : '일시중지' }}
          </el-button>
          <el-button size="small" type="primary" @click="trigger(row)">즉시 실행</el-button>
          <el-button size="small" type="danger" @click="del(row)">삭제</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="createVisible" title="스케줄 생성" width="820px" top="5vh">
      <el-form label-position="top">
        <el-row :gutter="16">
          <el-col :span="12">
            <el-form-item label="스케줄 이름" required>
              <el-input v-model="form.name" placeholder="예: nightly-backup" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="cron (schedule)" required>
              <el-input v-model="form.schedule" placeholder="예: 0 2 * * *" />
            </el-form-item>
          </el-col>
        </el-row>
      </el-form>
      <el-divider content-position="left">백업 템플릿 (template)</el-divider>
      <BackupSpecForm v-model="form.spec" />
      <template #footer>
        <el-button @click="previewVisible = true">YAML 미리보기</el-button>
        <el-button @click="createVisible = false">취소</el-button>
        <el-button type="primary" :loading="submitting" @click="submit">생성</el-button>
      </template>
    </el-dialog>

    <YamlViewer v-model="previewVisible" title="스케줄 spec 미리보기" :data="previewData" />
    <YamlViewer v-model="yamlVisible" title="Schedule CR" :data="current" />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { Refresh, Plus } from '@element-plus/icons-vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api, type CR } from '@/api/client';
import YamlViewer from '@/components/YamlViewer.vue';
import BackupSpecForm from '@/components/BackupSpecForm.vue';
import { fmtTime } from '@/utils/format';

const schedules = ref<CR[]>([]);
const loading = ref(false);

async function load() {
  loading.value = true;
  try {
    schedules.value = await api.listSchedules();
  } finally {
    loading.value = false;
  }
}

const createVisible = ref(false);
const submitting = ref(false);
const previewVisible = ref(false);
const form = reactive<{ name: string; schedule: string; spec: Record<string, any> }>({
  name: '',
  schedule: '',
  spec: {},
});

function openCreate() {
  form.name = '';
  form.schedule = '0 2 * * *';
  form.spec = { ttl: '720h0m0s' };
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
  if (!form.schedule) return ElMessage.warning('cron 을 입력하세요');
  submitting.value = true;
  try {
    await api.createSchedule({
      name: form.name,
      spec: { schedule: form.schedule, template: form.spec },
    });
    ElMessage.success('스케줄 생성됨');
    createVisible.value = false;
    await load();
  } finally {
    submitting.value = false;
  }
}

const current = ref<CR | null>(null);
const yamlVisible = ref(false);
function showYaml(row: CR) {
  current.value = row;
  yamlVisible.value = true;
}

async function togglePause(row: CR) {
  const paused = !row.spec?.paused;
  await api.pauseSchedule(row.metadata!.name!, paused);
  ElMessage.success(paused ? '일시중지됨' : '재개됨');
  await load();
}

async function trigger(row: CR) {
  const n = row.metadata!.name!;
  await ElMessageBox.confirm(`스케줄 '${n}' 의 템플릿으로 백업을 즉시 실행합니다.`, '즉시 실행', {
    type: 'warning',
    confirmButtonText: '실행',
    cancelButtonText: '취소',
  });
  await api.triggerSchedule(n);
  ElMessage.success('백업 생성 요청됨');
}

async function del(row: CR) {
  const n = row.metadata!.name!;
  await ElMessageBox.confirm(`스케줄 '${n}' 을(를) 삭제합니다.`, '삭제 확인', {
    type: 'warning',
    confirmButtonText: '삭제',
    cancelButtonText: '취소',
  });
  await api.deleteSchedule(n);
  ElMessage.success('삭제됨');
  await load();
}

onMounted(load);
</script>
