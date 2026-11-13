<template>
  <el-select
    :model-value="modelValue"
    multiple
    filterable
    allow-create
    default-first-option
    clearable
    collapse-tags
    collapse-tags-tooltip
    :placeholder="placeholder || '리소스 타입 (예: deployments, secrets, persistentvolumeclaims)'"
    style="width: 100%"
    @update:model-value="(v: string[]) => $emit('update:modelValue', v)"
  >
    <el-option
      v-for="r in resources"
      :key="r.group + '/' + r.name"
      :label="labelFor(r)"
      :value="valueFor(r)"
    />
  </el-select>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api, type ApiResource } from '@/api/client';

const props = defineProps<{
  modelValue: string[];
  placeholder?: string;
  /** true 면 클러스터 스코프 리소스만, false 면 네임스페이스 스코프만, 미지정이면 전체 */
  namespaced?: boolean;
  /** true 면 group 접미(resource.group) 형태로 값 생성(velero 권장 표기) */
  qualified?: boolean;
}>();
defineEmits<{ (e: 'update:modelValue', v: string[]): void }>();

const resources = ref<ApiResource[]>([]);

const labelFor = (r: ApiResource) =>
  r.group ? `${r.name}.${r.group} (${r.kind})` : `${r.name} (${r.kind})`;
const valueFor = (r: ApiResource) =>
  props.qualified && r.group ? `${r.name}.${r.group}` : r.name;

onMounted(async () => {
  try {
    let list = await api.listApiResources();
    if (props.namespaced !== undefined) {
      list = list.filter((r) => r.namespaced === props.namespaced);
    }
    resources.value = list;
  } catch {
    /* 무시 — allow-create 로 수동 입력 가능 */
  }
});
</script>
