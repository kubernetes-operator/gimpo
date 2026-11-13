<template>
  <el-tag :type="tagType" effect="dark" size="small">{{ phase || 'Unknown' }}</el-tag>
</template>

<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{ phase?: string }>();

const tagType = computed(() => {
  switch (props.phase) {
    case 'Completed':
    case 'Available':
    case 'Enabled':
    case 'Processed':
      return 'success';
    case 'InProgress':
    case 'New':
    case 'Uploading':
    case 'Accepted':
    case 'Prepared':
      return 'warning';
    case 'PartiallyFailed':
    case 'FailedValidation':
      return 'warning';
    case 'Failed':
    case 'Deleting':
    case 'Unavailable':
      return 'danger';
    default:
      return 'info';
  }
});
</script>
