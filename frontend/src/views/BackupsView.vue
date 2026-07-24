<template>
  <div>
    <div class="page-header">
      <h2>백업</h2>
      <div class="toolbar">
        <el-button :icon="Refresh" @click="load">새로고침</el-button>
        <el-button type="primary" :icon="Plus" @click="openCreate">백업 생성</el-button>
      </div>
    </div>

    <el-input v-model="q" placeholder="이름 필터" clearable :prefix-icon="Search" style="max-width: 320px; margin-bottom: 12px" />

    <el-table :data="filtered" v-loading="loading" size="small" stripe>
      <el-table-column prop="metadata.name" label="이름" min-width="260" show-overflow-tooltip sortable
        :sort-method="(a: any, b: any) => (a.metadata.name).localeCompare(b.metadata.name)" />
      <el-table-column label="상태" width="130">
        <template #default="{ row }"><PhaseTag :phase="row.status?.phase" /></template>
      </el-table-column>
      <el-table-column label="errors/warnings" width="140">
        <template #default="{ row }">
          <span :style="{ color: row.status?.errors ? '#f56c6c' : '#909399' }">{{ row.status?.errors ?? 0 }}</span>
          /
          <span :style="{ color: row.status?.warnings ? '#e6a23c' : '#909399' }">{{ row.status?.warnings ?? 0 }}</span>
        </template>
      </el-table-column>
      <el-table-column label="스토리지" width="140" prop="spec.storageLocation" />
      <el-table-column label="생성" width="170">
        <template #default="{ row }">{{ fmtTime(row.metadata?.creationTimestamp) }}</template>
      </el-table-column>
      <el-table-column label="만료" width="170">
        <template #default="{ row }">{{ fmtTime(row.status?.expiration) }}</template>
      </el-table-column>
      <el-table-column label="작업" width="320" fixed="right">
        <template #default="{ row }">
          <el-button size="small" @click="openDetail(row)">상세</el-button>
          <el-button size="small" @click="openLogs(row)">로그</el-button>
          <el-button size="small" type="success" @click="restoreFrom(row)">복구</el-button>
          <el-button size="small" type="danger" @click="del(row)">삭제</el-button>
        </template>
      </el-table-column>
    </el-table>

    <!-- 생성 다이얼로그 -->
    <el-dialog v-model="createVisible" title="백업 생성" width="820px" top="5vh">
      <el-form label-position="top">
        <el-form-item label="백업 이름" required>
          <el-input v-model="form.name" placeholder="예: manual-backup-20260724" />
        </el-form-item>
      </el-form>
      <BackupSpecForm v-model="form.spec" />
      <template #footer>
        <el-button @click="previewVisible = true">YAML 미리보기</el-button>
        <el-button @click="createVisible = false">취소</el-button>
        <el-button type="primary" :loading="submitting" @click="submit">생성</el-button>
      </template>
    </el-dialog>

    <YamlViewer v-model="previewVisible" title="백업 spec 미리보기" :data="previewData" />

    <!-- 상세 드로어 -->
    <el-drawer v-model="detailVisible" :title="current?.metadata?.name" size="52%">
      <el-tabs v-model="detailTab">
        <el-tab-pane label="개요" name="overview">
          <el-descriptions :column="1" border size="small">
            <el-descriptions-item label="상태"><PhaseTag :phase="current?.status?.phase" /></el-descriptions-item>
            <el-descriptions-item label="시작">{{ fmtTime(current?.status?.startTimestamp) }}</el-descriptions-item>
            <el-descriptions-item label="완료">{{ fmtTime(current?.status?.completionTimestamp) }}</el-descriptions-item>
            <el-descriptions-item label="errors">{{ current?.status?.errors ?? 0 }}</el-descriptions-item>
            <el-descriptions-item label="warnings">{{ current?.status?.warnings ?? 0 }}</el-descriptions-item>
            <el-descriptions-item label="포함 NS">{{ (current?.spec?.includedNamespaces || ['전체']).join(', ') }}</el-descriptions-item>
          </el-descriptions>
          <el-button style="margin-top: 12px" @click="yamlVisible = true">전체 YAML 보기</el-button>
        </el-tab-pane>
        <el-tab-pane label="결과(warnings/errors)" name="results">
          <pre class="log-viewer">{{ pretty(results) }}</pre>
        </el-tab-pane>
        <el-tab-pane label="리소스 목록" name="resources">
          <pre class="log-viewer">{{ pretty(resourceList) }}</pre>
        </el-tab-pane>
        <el-tab-pane label="볼륨 스냅샷" name="snapshots">
          <pre class="log-viewer">{{ pretty(volumeSnapshots) }}</pre>
        </el-tab-pane>
      </el-tabs>
    </el-drawer>

    <YamlViewer v-model="yamlVisible" title="Backup CR" :data="current" />

    <!-- 로그 다이얼로그 -->
    <el-dialog v-model="logsVisible" :title="`로그 · ${current?.metadata?.name}`" width="80%" top="5vh">
      <div v-loading="logsLoading" class="log-viewer">{{ logs || '로그 없음' }}</div>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { Refresh, Plus, Search } from '@element-plus/icons-vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api, type CR } from '@/api/client';
import PhaseTag from '@/components/PhaseTag.vue';
import YamlViewer from '@/components/YamlViewer.vue';
import BackupSpecForm from '@/components/BackupSpecForm.vue';
import { fmtTime } from '@/utils/format';

const router = useRouter();
const backups = ref<CR[]>([]);
const loading = ref(false);
const q = ref('');
const filtered = computed(() =>
  backups.value.filter((b) => (b.metadata?.name ?? '').includes(q.value)),
);

async function load() {
  loading.value = true;
  try {
    backups.value = await api.listBackups();
  } finally {
    loading.value = false;
  }
}

// ─── 생성 ───
const createVisible = ref(false);
const submitting = ref(false);
const form = reactive<{ name: string; spec: Record<string, any> }>({ name: '', spec: {} });
const previewVisible = ref(false);
const previewData = computed(() => ({
  apiVersion: 'velero.io/v1',
  kind: 'Backup',
  metadata: { name: form.name, namespace: 'velero' },
  spec: form.spec,
}));

function openCreate() {
  form.name = '';
  form.spec = { ttl: '720h0m0s' };
  createVisible.value = true;
}

async function submit() {
  if (!form.name) return ElMessage.warning('백업 이름을 입력하세요');
  await ElMessageBox.confirm(
    `백업 '${form.name}' 을(를) 생성합니다. 실제 백업 작업이 시작됩니다.`,
    '백업 생성 확인',
    { type: 'warning', confirmButtonText: '생성', cancelButtonText: '취소' },
  );
  submitting.value = true;
  try {
    await api.createBackup({ name: form.name, spec: form.spec });
    ElMessage.success('백업 생성됨');
    createVisible.value = false;
    await load();
  } finally {
    submitting.value = false;
  }
}

// ─── 상세 ───
const detailVisible = ref(false);
const detailTab = ref('overview');
const current = ref<CR | null>(null);
const results = ref<unknown>(null);
const resourceList = ref<unknown>(null);
const volumeSnapshots = ref<unknown>(null);
const yamlVisible = ref(false);

async function openDetail(row: CR) {
  current.value = row;
  detailTab.value = 'overview';
  detailVisible.value = true;
  const n = row.metadata!.name!;
  results.value = resourceList.value = volumeSnapshots.value = null;
  api.backupResults(n).then((v) => (results.value = v)).catch(() => undefined);
  api.backupResourceList(n).then((v) => (resourceList.value = v)).catch(() => undefined);
  api.backupVolumeSnapshots(n).then((v) => (volumeSnapshots.value = v)).catch(() => undefined);
}

// ─── 로그 ───
const logsVisible = ref(false);
const logsLoading = ref(false);
const logs = ref('');
async function openLogs(row: CR) {
  current.value = row;
  logs.value = '';
  logsVisible.value = true;
  logsLoading.value = true;
  try {
    logs.value = await api.backupLogs(row.metadata!.name!);
  } finally {
    logsLoading.value = false;
  }
}

async function del(row: CR) {
  const n = row.metadata!.name!;
  await ElMessageBox.confirm(
    `백업 '${n}' 삭제(DeleteBackupRequest 생성) — 오브젝트 스토리지의 데이터까지 제거됩니다. 되돌릴 수 없습니다.`,
    '백업 삭제 확인',
    { type: 'error', confirmButtonText: '삭제', cancelButtonText: '취소' },
  );
  await api.deleteBackup(n);
  ElMessage.success('DeleteBackupRequest 생성됨');
  await load();
}

function restoreFrom(row: CR) {
  router.push({ name: 'restores', query: { from: row.metadata!.name! } });
}

const pretty = (v: unknown) => (v == null ? '로딩 중 또는 데이터 없음' : JSON.stringify(v, null, 2));

onMounted(load);
</script>
