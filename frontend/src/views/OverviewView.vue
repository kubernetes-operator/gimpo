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

    <div class="stat-cards">
      <el-card shadow="hover">
        <div style="font-size: 13px; color: var(--ws-muted)">백업</div>
        <div style="font-size: 28px; font-weight: 700">{{ backups.length }}</div>
        <div style="font-size: 12px; color: var(--ws-success)">완료 {{ count(backups, 'Completed') }}</div>
      </el-card>
      <el-card shadow="hover">
        <div style="font-size: 13px; color: var(--ws-muted)">복구</div>
        <div style="font-size: 28px; font-weight: 700">{{ restores.length }}</div>
        <div style="font-size: 12px; color: var(--ws-success)">완료 {{ count(restores, 'Completed') }}</div>
      </el-card>
      <el-card shadow="hover">
        <div style="font-size: 13px; color: var(--ws-muted)">스케줄</div>
        <div style="font-size: 28px; font-weight: 700">{{ schedules.length }}</div>
      </el-card>
      <el-card shadow="hover">
        <div style="font-size: 13px; color: var(--ws-muted)">스토리지 위치</div>
        <div style="font-size: 28px; font-weight: 700">{{ bsl.length }}</div>
        <div style="font-size: 12px; color: var(--ws-success)">가용 {{ count(bsl, 'Available') }}</div>
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
import { computed, onMounted, ref } from 'vue';
import { Refresh } from '@element-plus/icons-vue';
import { useRouter } from 'vue-router';
import { api, type CR, type HealthReport, type ServerStatus } from '@/api/client';
import PhaseTag from '@/components/PhaseTag.vue';
import { fmtTime } from '@/utils/format';

const backups = ref<CR[]>([]);
const restores = ref<CR[]>([]);
const schedules = ref<CR[]>([]);
const bsl = ref<CR[]>([]);
const status = ref<ServerStatus | null>(null);
const health = ref<HealthReport | null>(null);
const router = useRouter();

const count = (arr: CR[], phase: string) =>
  arr.filter((x) => x.status?.phase === phase).length;

const recent = computed(() =>
  [...backups.value]
    .sort((a, b) =>
      (b.metadata?.creationTimestamp ?? '').localeCompare(a.metadata?.creationTimestamp ?? ''),
    )
    .slice(0, 8),
);

async function load() {
  const [b, r, s, l] = await Promise.all([
    api.listBackups().catch(() => []),
    api.listRestores().catch(() => []),
    api.listSchedules().catch(() => []),
    api.listBSL().catch(() => []),
  ]);
  backups.value = b;
  restores.value = r;
  schedules.value = s;
  bsl.value = l;
  api.serverStatus().then((v) => (status.value = v)).catch(() => undefined);
  api.healthReport().then((v) => (health.value = v)).catch(() => undefined);
}

onMounted(load);
</script>
