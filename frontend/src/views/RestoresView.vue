<template>
  <div>
    <div class="page-header">
      <h2>복구</h2>
      <div class="toolbar">
        <el-button :icon="Refresh" @click="load">새로고침</el-button>
        <el-button type="primary" :icon="Plus" @click="openCreate()">복구 생성</el-button>
      </div>
    </div>

    <el-table :data="restores" v-loading="loading" size="small" stripe>
      <el-table-column prop="metadata.name" label="이름" min-width="240" show-overflow-tooltip />
      <el-table-column label="소스 백업" min-width="220" show-overflow-tooltip>
        <template #default="{ row }">{{ row.spec?.backupName || row.spec?.scheduleName || '-' }}</template>
      </el-table-column>
      <el-table-column label="상태" width="130">
        <template #default="{ row }"><PhaseTag :phase="row.status?.phase" /></template>
      </el-table-column>
      <el-table-column label="errors/warnings" width="140">
        <template #default="{ row }">{{ row.status?.errors ?? 0 }} / {{ row.status?.warnings ?? 0 }}</template>
      </el-table-column>
      <el-table-column label="생성" width="170">
        <template #default="{ row }">{{ fmtTime(row.metadata?.creationTimestamp) }}</template>
      </el-table-column>
      <el-table-column label="작업" width="260" fixed="right">
        <template #default="{ row }">
          <el-button size="small" @click="openLogs(row)">로그</el-button>
          <el-button size="small" @click="showYaml(row)">YAML</el-button>
          <el-button size="small" type="danger" @click="del(row)">삭제</el-button>
        </template>
      </el-table-column>
    </el-table>

    <!-- 생성 다이얼로그 -->
    <el-dialog v-model="createVisible" title="복구 생성" width="820px" top="5vh">
      <el-form label-position="top">
        <el-row :gutter="16">
          <el-col :span="12">
            <el-form-item label="복구 이름" required>
              <el-input v-model="form.name" placeholder="예: restore-20260724" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="소스 백업 (backupName)" required>
              <el-select v-model="form.spec.backupName" filterable placeholder="백업 선택" style="width: 100%">
                <el-option v-for="b in completedBackups" :key="b.metadata?.name" :label="b.metadata?.name" :value="b.metadata?.name" />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>

        <el-row :gutter="16">
          <el-col :span="12">
            <el-form-item label="포함 네임스페이스">
              <NamespaceSelector v-model="form.spec.includedNamespaces" placeholder="비우면 백업의 전체 NS" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="제외 네임스페이스">
              <NamespaceSelector v-model="form.spec.excludedNamespaces" placeholder="제외할 NS" />
            </el-form-item>
          </el-col>
        </el-row>

        <el-row :gutter="16">
          <el-col :span="12">
            <el-form-item label="포함 리소스">
              <ResourceSelector v-model="form.spec.includedResources" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="제외 리소스">
              <ResourceSelector v-model="form.spec.excludedResources" />
            </el-form-item>
          </el-col>
        </el-row>

        <el-form-item label="네임스페이스 매핑 (namespaceMapping — src=dst)">
          <el-select v-model="nsMapping" multiple filterable allow-create default-first-option placeholder="예: prod=prod-restore" style="width: 100%" />
        </el-form-item>

        <el-row :gutter="16">
          <el-col :span="8">
            <el-form-item label="PV 복구 (restorePVs)">
              <el-select v-model="form.spec.restorePVs" style="width: 100%">
                <el-option label="자동" :value="null" />
                <el-option label="예" :value="true" />
                <el-option label="아니오" :value="false" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="NodePort 보존 (preserveNodePorts)">
              <el-select v-model="form.spec.preserveNodePorts" style="width: 100%">
                <el-option label="자동" :value="null" />
                <el-option label="예" :value="true" />
                <el-option label="아니오" :value="false" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="기존 리소스 정책 (existingResourcePolicy)">
              <el-select v-model="form.spec.existingResourcePolicy" clearable style="width: 100%">
                <el-option label="none (건너뜀)" value="none" />
                <el-option label="update (갱신)" value="update" />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>
      </el-form>
      <template #footer>
        <el-button @click="previewVisible = true">YAML 미리보기</el-button>
        <el-button @click="createVisible = false">취소</el-button>
        <el-button type="primary" :loading="submitting" @click="submit">복구 실행</el-button>
      </template>
    </el-dialog>

    <YamlViewer v-model="previewVisible" title="복구 spec 미리보기" :data="previewData" />
    <YamlViewer v-model="yamlVisible" title="Restore CR" :data="current" />

    <el-dialog v-model="logsVisible" :title="`로그 · ${current?.metadata?.name}`" width="80%" top="5vh">
      <div v-loading="logsLoading" class="log-viewer">{{ logs || '로그 없음' }}</div>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { Refresh, Plus } from '@element-plus/icons-vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api, type CR } from '@/api/client';
import PhaseTag from '@/components/PhaseTag.vue';
import YamlViewer from '@/components/YamlViewer.vue';
import NamespaceSelector from '@/components/NamespaceSelector.vue';
import ResourceSelector from '@/components/ResourceSelector.vue';
import { fmtTime } from '@/utils/format';

const route = useRoute();
const restores = ref<CR[]>([]);
const backups = ref<CR[]>([]);
const loading = ref(false);
const completedBackups = computed(() =>
  backups.value.filter((b) => ['Completed', 'PartiallyFailed'].includes(b.status?.phase ?? '')),
);

async function load() {
  loading.value = true;
  try {
    [restores.value, backups.value] = await Promise.all([api.listRestores(), api.listBackups()]);
  } finally {
    loading.value = false;
  }
}

const createVisible = ref(false);
const submitting = ref(false);
const form = reactive<{ name: string; spec: Record<string, any> }>({ name: '', spec: {} });
const nsMapping = ref<string[]>([]);
const previewVisible = ref(false);

watch(nsMapping, (pairs) => {
  const obj: Record<string, string> = {};
  for (const p of pairs) {
    const i = p.indexOf('=');
    if (i > 0) obj[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  }
  form.spec.namespaceMapping = Object.keys(obj).length ? obj : undefined;
});

function openCreate(backupName?: string) {
  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  form.name = `restore-${ts}`;
  form.spec = { backupName: backupName ?? '', restorePVs: null, preserveNodePorts: null };
  nsMapping.value = [];
  createVisible.value = true;
}

const previewData = computed(() => ({
  apiVersion: 'velero.io/v1',
  kind: 'Restore',
  metadata: { name: form.name, namespace: 'velero' },
  spec: form.spec,
}));

async function submit() {
  if (!form.name) return ElMessage.warning('복구 이름을 입력하세요');
  if (!form.spec.backupName) return ElMessage.warning('소스 백업을 선택하세요');
  await ElMessageBox.confirm(
    `'${form.spec.backupName}' 백업에서 복구를 실행합니다. 클러스터 리소스가 변경될 수 있습니다.`,
    '복구 실행 확인',
    { type: 'warning', confirmButtonText: '복구 실행', cancelButtonText: '취소' },
  );
  submitting.value = true;
  try {
    await api.createRestore({ name: form.name, spec: form.spec });
    ElMessage.success('복구 시작됨');
    createVisible.value = false;
    await load();
  } finally {
    submitting.value = false;
  }
}

const current = ref<CR | null>(null);
const yamlVisible = ref(false);
const logsVisible = ref(false);
const logsLoading = ref(false);
const logs = ref('');

function showYaml(row: CR) {
  current.value = row;
  yamlVisible.value = true;
}

async function openLogs(row: CR) {
  current.value = row;
  logs.value = '';
  logsVisible.value = true;
  logsLoading.value = true;
  try {
    logs.value = await api.restoreLogs(row.metadata!.name!);
  } finally {
    logsLoading.value = false;
  }
}

async function del(row: CR) {
  const n = row.metadata!.name!;
  await ElMessageBox.confirm(`복구 '${n}' 을(를) 삭제합니다.`, '삭제 확인', {
    type: 'warning',
    confirmButtonText: '삭제',
    cancelButtonText: '취소',
  });
  await api.deleteRestore(n);
  ElMessage.success('삭제됨');
  await load();
}

onMounted(async () => {
  await load();
  if (route.query.from) openCreate(String(route.query.from));
});
</script>
