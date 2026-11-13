<template>
  <div>
    <div class="page-header">
      <h2>리포지토리 / 볼륨 작업</h2>
      <el-button :icon="Refresh" @click="load">새로고침</el-button>
    </div>

    <el-tabs v-model="tab" v-loading="loading">
      <el-tab-pane label="BackupRepository" name="repos">
        <el-table :data="repos" size="small">
          <el-table-column prop="metadata.name" label="이름" min-width="240" show-overflow-tooltip />
          <el-table-column label="타입" width="140" prop="spec.repositoryType" />
          <el-table-column label="볼륨 NS" width="160" prop="spec.volumeNamespace" />
          <el-table-column label="상태" width="130">
            <template #default="{ row }"><PhaseTag :phase="row.status?.phase" /></template>
          </el-table-column>
          <el-table-column label="작업" width="120" fixed="right">
            <template #default="{ row }"><el-button size="small" @click="showYaml(row)">YAML</el-button></template>
          </el-table-column>
        </el-table>
      </el-tab-pane>

      <el-tab-pane label="PodVolumeBackup" name="pvb">
        <VolumeOpTable :rows="pvb" @yaml="showYaml" />
      </el-tab-pane>
      <el-tab-pane label="PodVolumeRestore" name="pvr">
        <VolumeOpTable :rows="pvr" @yaml="showYaml" />
      </el-tab-pane>
      <el-tab-pane label="DataUpload (CSI)" name="du">
        <VolumeOpTable :rows="du" @yaml="showYaml" />
      </el-tab-pane>
      <el-tab-pane label="DataDownload (CSI)" name="dd">
        <VolumeOpTable :rows="dd" @yaml="showYaml" />
      </el-tab-pane>
    </el-tabs>

    <YamlViewer v-model="yamlVisible" :title="current?.kind" :data="current" />
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { Refresh } from '@element-plus/icons-vue';
import { api, type CR } from '@/api/client';
import PhaseTag from '@/components/PhaseTag.vue';
import YamlViewer from '@/components/YamlViewer.vue';
import VolumeOpTable from '@/components/VolumeOpTable.vue';

const tab = ref('repos');
const loading = ref(false);
const repos = ref<CR[]>([]);
const pvb = ref<CR[]>([]);
const pvr = ref<CR[]>([]);
const du = ref<CR[]>([]);
const dd = ref<CR[]>([]);

async function load() {
  loading.value = true;
  try {
    [repos.value, pvb.value, pvr.value, du.value, dd.value] = await Promise.all([
      api.listBackupRepositories().catch(() => []),
      api.listPodVolumeBackups().catch(() => []),
      api.listPodVolumeRestores().catch(() => []),
      api.listDataUploads().catch(() => []),
      api.listDataDownloads().catch(() => []),
    ]);
  } finally {
    loading.value = false;
  }
}

const current = ref<CR | null>(null);
const yamlVisible = ref(false);
function showYaml(row: CR) {
  current.value = row;
  yamlVisible.value = true;
}

onMounted(load);
</script>
