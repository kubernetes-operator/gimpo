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
    :placeholder="placeholder"
    style="width: 100%"
    @update:model-value="(v: string[]) => $emit('update:modelValue', v)"
  >
    <el-option
      v-for="ns in namespaces"
      :key="ns.name"
      :label="ns.name"
      :value="ns.name"
    >
      <span>{{ ns.name }}</span>
      <el-tag v-if="isSystem(ns.name)" size="small" type="warning" effect="plain" style="margin-left: 8px">
        system
      </el-tag>
    </el-option>
  </el-select>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api, type NamespaceInfo } from '@/api/client';

defineProps<{ modelValue: string[]; placeholder?: string }>();
defineEmits<{ (e: 'update:modelValue', v: string[]): void }>();

const namespaces = ref<NamespaceInfo[]>([]);

// kube-system 등 시스템 네임스페이스도 숨기지 않고 그대로 노출(요구사항).
const SYSTEM = ['kube-system', 'kube-public', 'kube-node-lease', 'velero'];
const isSystem = (n?: string) => !!n && SYSTEM.includes(n);

onMounted(async () => {
  try {
    namespaces.value = await api.listNamespaces();
  } catch {
    /* 무시 — allow-create 로 수동 입력 가능 */
  }
});
</script>
