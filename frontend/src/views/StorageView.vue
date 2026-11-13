<template>
  <div>
    <div class="page-header">
      <h2>스토리지 위치</h2>
      <el-button :icon="Refresh" @click="load">새로고침</el-button>
    </div>

    <el-card shadow="never" header="BackupStorageLocation (BSL)" style="margin-bottom: 16px">
      <el-table :data="bsl" v-loading="loading" size="small">
        <el-table-column prop="metadata.name" label="이름" min-width="160" />
        <el-table-column label="기본" width="90">
          <template #default="{ row }">
            <el-tag v-if="row.spec?.default" type="success" size="small">default</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="provider" width="120" prop="spec.provider" />
        <el-table-column label="bucket" min-width="160">
          <template #default="{ row }">{{ row.spec?.objectStorage?.bucket || '-' }}</template>
        </el-table-column>
        <el-table-column label="상태" width="120">
          <template #default="{ row }"><PhaseTag :phase="row.status?.phase" /></template>
        </el-table-column>
        <el-table-column label="마지막 검증" width="170">
          <template #default="{ row }">{{ fmtTime(row.status?.lastValidationTime) }}</template>
        </el-table-column>
        <el-table-column label="작업" width="200" fixed="right">
          <template #default="{ row }">
            <el-button size="small" :disabled="row.spec?.default" @click="setDefault(row)">기본으로</el-button>
            <el-button size="small" @click="showYaml(row)">YAML</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card shadow="never" header="VolumeSnapshotLocation (VSL)">
      <el-table :data="vsl" size="small">
        <el-table-column prop="metadata.name" label="이름" min-width="160" />
        <el-table-column label="provider" width="140" prop="spec.provider" />
        <el-table-column label="config" min-width="220">
          <template #default="{ row }">{{ JSON.stringify(row.spec?.config || {}) }}</template>
        </el-table-column>
        <el-table-column label="작업" width="120" fixed="right">
          <template #default="{ row }"><el-button size="small" @click="showYaml(row)">YAML</el-button></template>
        </el-table-column>
      </el-table>
    </el-card>

    <YamlViewer v-model="yamlVisible" :title="current?.kind" :data="current" />
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { Refresh } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';
import { api, type CR } from '@/api/client';
import PhaseTag from '@/components/PhaseTag.vue';
import YamlViewer from '@/components/YamlViewer.vue';
import { fmtTime } from '@/utils/format';

const bsl = ref<CR[]>([]);
const vsl = ref<CR[]>([]);
const loading = ref(false);

async function load() {
  loading.value = true;
  try {
    [bsl.value, vsl.value] = await Promise.all([api.listBSL(), api.listVSL()]);
  } finally {
    loading.value = false;
  }
}

async function setDefault(row: CR) {
  await api.setDefaultBSL(row.metadata!.name!);
  ElMessage.success(`기본 BSL → ${row.metadata!.name}`);
  await load();
}

const current = ref<CR | null>(null);
const yamlVisible = ref(false);
function showYaml(row: CR) {
  current.value = row;
  yamlVisible.value = true;
}

onMounted(load);
</script>
