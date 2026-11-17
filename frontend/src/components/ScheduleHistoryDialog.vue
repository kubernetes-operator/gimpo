<template>
  <el-dialog
    :model-value="modelValue"
    :title="`백업 이력 — ${title}`"
    width="900px"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div style="margin-bottom: 10px; display: flex; align-items: center; gap: 12px">
      <el-switch
        v-model="includePrevious"
        :disabled="!previousNames.length"
        active-text="이전 이름의 백업도 보기"
      />
      <span v-if="previousNames.length" style="font-size: 12px; color: var(--ws-muted)">
        연결된 이전 이름: {{ previousNames.join(', ') }}
      </span>
      <span v-else style="font-size: 12px; color: var(--ws-muted)">연결된 이전 이름 없음</span>
    </div>
    <el-table :data="rows" v-loading="loading" size="small" stripe max-height="60vh">
      <el-table-column prop="metadata.name" label="백업" min-width="260" show-overflow-tooltip />
      <el-table-column label="스케줄 이름" width="200" show-overflow-tooltip>
        <template #default="{ row }">
          {{ row.metadata?.labels?.['velero.io/schedule-name'] }}
          <el-tag v-if="row.metadata?.labels?.['velero.io/schedule-name'] !== name" size="small" type="info">이전</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="상태" width="130">
        <template #default="{ row }"><PhaseTag :phase="row.status?.phase" /></template>
      </el-table-column>
      <el-table-column label="시작" width="170">
        <template #default="{ row }">{{ fmtTime(row.status?.startTimestamp) }}</template>
      </el-table-column>
      <el-table-column label="자동 삭제" width="170">
        <template #default="{ row }">{{ fmtTime(row.status?.expiration) }}</template>
      </el-table-column>
    </el-table>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { api, type CR, type ScheduleCR } from '@/api/client';
import PhaseTag from './PhaseTag.vue';
import { fmtTime } from '@/utils/format';

const props = defineProps<{ modelValue: boolean; schedule: ScheduleCR | null }>();
const emit = defineEmits<{ (e: 'update:modelValue', v: boolean): void }>();

const rows = ref<CR[]>([]);
const loading = ref(false);
const includePrevious = ref(true);
const name = computed(() => props.schedule?.metadata?.name ?? '');
const title = computed(() => props.schedule?.gimpo?.displayName || name.value);
const previousNames = computed(() => props.schedule?.gimpo?.previousNames ?? []);

async function load() {
  if (!props.modelValue || !name.value) return;
  loading.value = true;
  try {
    rows.value = await api.scheduleBackups(name.value, includePrevious.value);
  } finally {
    loading.value = false;
  }
}
watch(() => [props.modelValue, props.schedule, includePrevious.value], load, { immediate: true });
</script>
