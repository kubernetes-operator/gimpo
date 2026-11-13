<template>
  <el-table :data="rows" size="small">
    <el-table-column prop="metadata.name" label="이름" min-width="260" show-overflow-tooltip />
    <el-table-column label="상태" width="130">
      <template #default="{ row }"><PhaseTag :phase="row.status?.phase" /></template>
    </el-table-column>
    <el-table-column label="진행률" min-width="160">
      <template #default="{ row }">
        <span v-if="row.status?.progress">
          {{ row.status.progress.bytesDone ?? 0 }} / {{ row.status.progress.totalBytes ?? 0 }} bytes
        </span>
        <span v-else>-</span>
      </template>
    </el-table-column>
    <el-table-column label="생성" width="170">
      <template #default="{ row }">{{ fmtTime(row.metadata?.creationTimestamp) }}</template>
    </el-table-column>
    <el-table-column label="작업" width="120" fixed="right">
      <template #default="{ row }"><el-button size="small" @click="$emit('yaml', row)">YAML</el-button></template>
    </el-table-column>
  </el-table>
</template>

<script setup lang="ts">
import type { CR } from '@/api/client';
import PhaseTag from './PhaseTag.vue';
import { fmtTime } from '@/utils/format';

defineProps<{ rows: CR[] }>();
defineEmits<{ (e: 'yaml', row: CR): void }>();
</script>
