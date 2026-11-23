<template>
  <div>
    <div class="page-header"><h2>개요</h2>
      <el-button :icon="Refresh" @click="load">새로고침</el-button>
    </div>

    <el-alert
      v-if="health"
      :type="health.overall === 'ok' ? 'success' : health.overall === 'warn' ? 'warning' : 'error'"
      :closable="false"
      show-icon
      style="margin-bottom: 16px; cursor: pointer"
      @click="router.push('/health')"
    >
      <template #title>
        {{ health.overall === 'ok' ? '백업·복구 정상' : health.overall === 'warn' ? '확인이 필요한 항목이 있습니다' : '이상 항목이 있습니다' }}
        — 정상 {{ health.counts.ok }} · 주의 {{ health.counts.warn }} · 이상 {{ health.counts.fail }}
        <span style="text-decoration: underline; margin-left: 6px">상태 점검 보기 →</span>
      </template>
    </el-alert>

    <el-alert v-if="stats?.errors.length" :title="'일부 현황을 불러오지 못했습니다: '+stats.errors.join(', ')" type="warning" :closable="false" />
    <div class="stat-cards">
      <el-card shadow="hover">
        <div style="font-size: 13px; color: var(--ws-muted)">백업</div>
        <div style="font-size: 28px; font-weight: 700">{{ stats?.backups.total ?? 0 }}</div>
        <div style="font-size: 12px; color: var(--ws-success)">완료 {{ stats?.backups.completed ?? 0 }}</div>
      </el-card>
      <el-card shadow="hover">
        <div style="font-size: 13px; color: var(--ws-muted)">복구</div>
        <div style="font-size: 28px; font-weight: 700">{{ stats?.restores.total ?? 0 }}</div>
        <div style="font-size: 12px; color: var(--ws-success)">완료 {{ stats?.restores.completed ?? 0 }}</div>
      </el-card>
      <el-card shadow="hover">
        <div style="font-size: 13px; color: var(--ws-muted)">스케줄</div>
        <div style="font-size: 28px; font-weight: 700">{{ stats?.schedules.total ?? 0 }}</div>
      </el-card>
      <el-card shadow="hover">
        <div style="font-size: 13px; color: var(--ws-muted)">스토리지 위치</div>
        <div style="font-size: 28px; font-weight: 700">{{ stats?.storage.total ?? 0 }}</div>
        <div style="font-size: 12px; color: var(--ws-success)">가용 {{ stats?.storage.available ?? 0 }}</div>
      </el-card>
    </div>

    <el-row :gutter="16">
      <el-col :span="12">
        <el-card shadow="never" header="Velero 서버">
          <el-descriptions :column="1" border size="small">
            <el-descriptions-item label="버전">{{ status?.serverVersion || '-' }}</el-descriptions-item>
            <el-descriptions-item label="상태">{{ status?.phase || '-' }}</el-descriptions-item>
            <el-descriptions-item label="플러그인 수">{{ status?.plugins?.length ?? 0 }}</el-descriptions-item>
          </el-descriptions>
        </el-card>
      </el-col>
      <el-col :span="12">
        <el-card shadow="never" header="최근 백업">
          <el-table :data="recent" size="small">
            <el-table-column prop="metadata.name" label="이름" show-overflow-tooltip />
            <el-table-column label="상태" width="120">
              <template #default="{ row }"><PhaseTag :phase="row.status?.phase" /></template>
            </el-table-column>
            <el-table-column label="생성" width="170">
              <template #default="{ row }">{{ fmtTime(row.metadata?.creationTimestamp) }}</template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { Refresh } from '@element-plus/icons-vue';
import { useRouter } from 'vue-router';
import { api, type CR, type HealthReport, type ServerStatus, type OverviewSummary } from '@/api/client';
import PhaseTag from '@/components/PhaseTag.vue';
import { fmtTime } from '@/utils/format';

const stats=ref<OverviewSummary|null>(null);
const recent=ref<CR[]>([]);
const status = ref<ServerStatus | null>(null);
const health = ref<Pick<HealthReport,'overall'|'counts'> | null>(null);
const router = useRouter();
async function load() {
  const value=await api.overview();stats.value=value;recent.value=value.backups.recent;
  api.serverStatus().then(v=>status.value=v).catch(()=>undefined);
  api.overviewHealth().then(v=>health.value=v).catch(()=>undefined);
}

onMounted(load);
</script>
