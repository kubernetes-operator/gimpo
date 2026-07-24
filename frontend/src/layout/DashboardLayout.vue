<template>
  <el-container style="height: 100vh">
    <el-aside width="220px" style="background: #1f2d3d">
      <div style="color: #fff; padding: 18px 16px; font-size: 18px; font-weight: 600">
        🗄️ Velero
        <div style="font-size: 12px; color: #8fa4b8; font-weight: 400">gimpo dashboard</div>
      </div>
      <el-menu
        :default-active="activeRoute"
        router
        background-color="#1f2d3d"
        text-color="#c0ccda"
        active-text-color="#ffd04b"
      >
        <el-menu-item index="/overview"><el-icon><Odometer /></el-icon>개요</el-menu-item>
        <el-menu-item index="/backups"><el-icon><Files /></el-icon>백업</el-menu-item>
        <el-menu-item index="/restores"><el-icon><RefreshLeft /></el-icon>복구</el-menu-item>
        <el-menu-item index="/schedules"><el-icon><Timer /></el-icon>스케줄</el-menu-item>
        <el-menu-item index="/storage"><el-icon><Coin /></el-icon>스토리지 위치</el-menu-item>
        <el-menu-item index="/repositories"><el-icon><Box /></el-icon>리포지토리/볼륨</el-menu-item>
      </el-menu>
    </el-aside>

    <el-container>
      <el-header
        style="display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid #ebeef5"
      >
        <span style="font-weight: 600">백업 · 복구 관리</span>
        <el-tag v-if="status?.serverVersion" type="success" effect="plain">
          Velero {{ status.serverVersion }}
        </el-tag>
        <el-tag v-else type="info" effect="plain">서버 상태 조회 중…</el-tag>
      </el-header>

      <el-main style="background: #f5f7fa">
        <router-view />
      </el-main>
    </el-container>
  </el-container>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { api, type ServerStatus } from '@/api/client';

const route = useRoute();
const activeRoute = computed(() => route.path);
const status = ref<ServerStatus | null>(null);

onMounted(async () => {
  try {
    status.value = await api.serverStatus();
  } catch {
    /* 헤더 표시는 실패해도 무시 */
  }
});
</script>
