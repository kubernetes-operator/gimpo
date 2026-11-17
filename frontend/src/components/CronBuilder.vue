<template>
  <div>
    <el-radio-group v-model="s.mode" size="small" style="margin-bottom: 8px">
      <el-radio-button value="daily">매일</el-radio-button>
      <el-radio-button value="weekly">매주</el-radio-button>
      <el-radio-button value="monthly">매월</el-radio-button>
      <el-radio-button value="custom">직접 입력</el-radio-button>
    </el-radio-group>

    <div v-if="s.mode !== 'custom'" style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap">
      <el-select v-if="s.mode === 'weekly'" v-model="s.weekday" style="width: 110px">
        <el-option v-for="(w, i) in WEEKDAYS" :key="i" :label="`${w}요일`" :value="i" />
      </el-select>
      <el-select v-if="s.mode === 'monthly'" v-model="s.day" style="width: 100px">
        <el-option v-for="d in 28" :key="d" :label="`${d}일`" :value="d" />
      </el-select>
      <el-select v-model="s.hour" style="width: 90px">
        <el-option v-for="h in 24" :key="h - 1" :label="`${h - 1}시`" :value="h - 1" />
      </el-select>
      <el-select v-model="s.minute" style="width: 90px">
        <el-option v-for="m in 60" :key="m - 1" :label="`${m - 1}분`" :value="m - 1" />
      </el-select>
      <span style="color: var(--ws-muted); font-size: 12px">(한국 시간)</span>
    </div>
    <el-input
      v-else
      v-model="s.raw"
      placeholder="예: CRON_TZ=Asia/Seoul 0 3 * * 1-5  (분 시 일 월 요일)"
    />

    <el-alert
      v-if="s.convertedFromUtc && s.mode !== 'custom'"
      type="info"
      :closable="false"
      show-icon
      style="margin-top: 8px"
      title="기존 일정이 UTC 기준이라 한국 시간으로 바꿔 표시했습니다. 저장하면 한국 시간 표기로 바뀌며 실제 실행 시각은 같습니다."
    />

    <div style="margin-top: 8px; font-size: 12px; color: var(--ws-text)">
      <span v-if="previewError" style="color: var(--ws-danger)">{{ previewError }}</span>
      <template v-else-if="preview.length">
        다음 실행:
        <el-tag v-for="p in preview" :key="p" size="small" type="info" style="margin-right: 4px">
          {{ fmtTime(p) }}
        </el-tag>
      </template>
      <span style="margin-left: 6px; color: var(--ws-muted)">{{ modelValue }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref, watch } from 'vue';
import { http } from '@/api/client';
import { fromCron, toCron, WEEKDAYS } from '@/utils/cron';
import { fmtTime } from '@/utils/format';

const props = defineProps<{ modelValue: string }>();
const emit = defineEmits<{ (e: 'update:modelValue', v: string): void }>();

const s = reactive(fromCron(props.modelValue));
const preview = ref<string[]>([]);
const previewError = ref('');

let timer: ReturnType<typeof setTimeout> | undefined;
async function refreshPreview(v: string) {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    try {
      // 인터셉터의 오류 토스트를 피하려고 http 를 직접 사용
      const r = await http.post('/cron/preview', { schedule: v }, { validateStatus: () => true });
      if (r.status >= 400) {
        previewError.value = r.data?.error ?? '일정 형식 오류';
        preview.value = [];
      } else {
        previewError.value = '';
        preview.value = r.data.nextRuns.slice(0, 3);
      }
    } catch {
      /* 무시 */
    }
  }, 300);
}

watch(
  s,
  () => {
    const v = toCron(s);
    if (v !== props.modelValue) emit('update:modelValue', v);
    void refreshPreview(v);
  },
  { deep: true, immediate: true },
);
</script>
