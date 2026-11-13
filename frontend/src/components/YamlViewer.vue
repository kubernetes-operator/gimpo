<template>
  <el-dialog :model-value="modelValue" :title="title" width="720px" @close="$emit('update:modelValue', false)">
    <pre class="log-viewer" style="max-height: 65vh">{{ yaml }}</pre>
    <template #footer>
      <el-button @click="copy">클립보드 복사</el-button>
      <el-button type="primary" @click="$emit('update:modelValue', false)">닫기</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import yamlLib from 'js-yaml';
import { ElMessage } from 'element-plus';

const props = defineProps<{ modelValue: boolean; title?: string; data: unknown }>();
defineEmits<{ (e: 'update:modelValue', v: boolean): void }>();

const yaml = computed(() => {
  try {
    return yamlLib.dump(props.data, { noRefs: true, lineWidth: 120 });
  } catch {
    return JSON.stringify(props.data, null, 2);
  }
});

async function copy() {
  try {
    await navigator.clipboard.writeText(yaml.value);
    ElMessage.success('복사됨');
  } catch {
    ElMessage.warning('복사 실패');
  }
}
</script>
