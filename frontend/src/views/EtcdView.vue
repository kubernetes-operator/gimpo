<template>
  <div>
    <div class="page-header">
      <h2>etcd 백업</h2>
      <div class="toolbar">
        <el-button :icon="Refresh" :loading="loading" @click="load">새로고침</el-button>
        <el-button v-if="canWrite" type="primary" :disabled="!installed || busy('snapshot')" :loading="busy('snapshot')" @click="snapshotNow">
          {{ busy('snapshot') ? '스냅샷 중…' : '지금 스냅샷' }}
        </el-button>
        <el-button v-if="canWrite" :disabled="!installed || busy('drill') || !st?.lastSuccess" :loading="busy('drill')" @click="drillNow()">
          {{ busy('drill') ? '복원 연습 중…' : '지금 복원 연습' }}
        </el-button>
        <el-button type="warning" plain :disabled="!st?.lastSuccess" @click="openRunbook()">롤백 절차서</el-button>
      </div>
    </div>

    <el-alert v-if="st && !installed" type="warning" :closable="false" show-icon style="margin-bottom: 16px"
      title="etcd 백업 CronJob 이 아직 설치되지 않았습니다 (deploy/etcd-backup.yaml 이 ArgoCD 로 배포되면 자동으로 시작됩니다)." />

    <el-alert type="info" :closable="false" style="margin-bottom: 16px">
      etcd 는 <b>쿠버네티스 전체 상태</b>를 담은 저장소입니다. 여기의 스냅샷은 클러스터 전체를 한 시점으로 되돌릴 때 씁니다.
      앱 하나·네임스페이스 하나의 복구는 <b>Velero(백업·복구 메뉴)</b>를 쓰세요.
    </el-alert>

    <!-- 요약 카드 -->
    <div class="stat-cards">
      <el-card shadow="hover">
        <div class="lbl">최근 스냅샷</div>
        <div class="big">
          <el-tag v-if="st?.latest" :type="st.latest.status === 'success' ? 'success' : 'danger'" size="small">
            {{ st.latest.status === 'success' ? '성공' : '실패' }}
          </el-tag>
          <span v-else>-</span>
        </div>
        <div class="sub">{{ fmtTime(st?.latest?.finishedAt || st?.latest?.startedAt) }}</div>
      </el-card>
      <el-card shadow="hover">
        <div class="lbl">보관 중인 스냅샷</div>
        <div class="big">{{ st?.inventory?.count ?? '-' }}<span class="unit">개</span></div>
        <div class="sub">{{ st?.inventory ? mb(st.inventory.totalBytes) + " · " : "" }}SeaweedFS</div>
      </el-card>
      <el-card shadow="hover">
        <div class="lbl">etcd 멤버</div>
        <div class="big">{{ st?.endpoints?.length ?? 0 }}/{{ st?.members?.length ?? 0 }}<span class="unit">응답</span></div>
        <div class="sub">v{{ st?.lastSuccess?.etcdVersion ?? '-' }} · 리더 {{ leaderName }}</div>
      </el-card>
      <el-card shadow="hover">
        <div class="lbl">최근 복원 연습</div>
        <div class="big">
          <el-tag v-if="st?.drills?.[0]" :type="st.drills[0].status === 'success' ? 'success' : 'danger'" size="small">
            {{ st.drills[0].status === 'success' ? '성공' : '실패' }}
          </el-tag>
          <span v-else>-</span>
        </div>
        <div class="sub">{{ fmtTime(st?.drills?.[0]?.finishedAt) }}</div>
      </el-card>
    </div>

    <el-row :gutter="16">
      <el-col :span="14">
        <el-card shadow="never" header="멤버 상태 (최근 성공한 스냅샷 시점)">
          <el-table :data="memberRows" size="small">
            <el-table-column prop="name" label="이름" width="90" />
            <el-table-column prop="host" label="주소" min-width="150" />
            <el-table-column label="역할" width="80">
              <template #default="{ row }"><el-tag v-if="row.leader" size="small" type="warning">리더</el-tag><span v-else>팔로워</span></template>
            </el-table-column>
            <el-table-column label="DB 크기" width="100"><template #default="{ row }">{{ row.dbSize ? mb(row.dbSize) : '-' }}</template></el-table-column>
            <el-table-column label="버전" prop="version" width="80" />
            <el-table-column label="상태" width="90">
              <template #default="{ row }"><span>{{ row.errors?.length ? '🔴 ' + row.errors[0] : row.responded ? '🟢 정상' : '🟡 무응답' }}</span></template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-col>
      <el-col :span="10">
        <el-card shadow="never" header="자동 실행 일정">
          <div v-for="c in st?.crons ?? []" :key="c.name" class="cron">
            <div><b>{{ c.kind === 'snapshot' ? '스냅샷' : '복원 연습' }}</b>
              <el-tag size="small" :type="!c.installed ? 'info' : c.suspend ? 'warning' : 'success'" style="margin-left: 6px">
                {{ !c.installed ? '미설치' : c.suspend ? '일시정지' : '사용 중' }}
              </el-tag>
            </div>
            <div class="sub">{{ c.installed ? describe(c) : '-' }}</div>
            <div class="sub">다음 실행 {{ fmtTime(c.nextRuns[0]) }}</div>
          </div>
          <div class="sub" style="margin-top: 8px">일정·보관 기간은 Git 의 <code>deploy/etcd-backup.yaml</code> 에서 바꿉니다.</div>
        </el-card>
      </el-col>
    </el-row>

    <el-card v-if="st?.running?.length" shadow="never" style="margin-top: 16px" header="진행 중">
      <div v-for="j in st.running" :key="j.name" class="sub">⏳ {{ j.kind === 'snapshot' ? '스냅샷' : '복원 연습' }} — {{ j.name }} ({{ fmtTime(j.startedAt) }} 시작)</div>
    </el-card>

    <el-tabs style="margin-top: 16px" type="border-card">
      <el-tab-pane label="스냅샷 이력">
        <el-table :data="st?.snapshots ?? []" size="small" stripe max-height="420">
          <el-table-column type="expand">
            <template #default="{ row }">
              <div class="detail">
                <div v-if="row.error" style="color: #f56c6c">오류: {{ row.error }}</div>
                <div>sha256 <code>{{ row.sha256 ?? '-' }}</code></div>
                <div>리비전 {{ row.revision ?? '-' }} · 키 {{ row.totalKey ?? '-' }}개 · 네임스페이스 {{ row.liveNamespaces ?? '-' }}개 · 노드 {{ row.node }}</div>
                <div v-if="row.s3">저장 위치 <code>s3://{{ row.s3.bucket }}/{{ row.s3.key }}</code></div>
                <div v-if="row.retention?.deleted?.length">보관 기간이 지나 삭제: {{ row.retention.deleted.join(', ') }}</div>
                <div class="sub">Job {{ row.jobName }}</div>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="결과" width="80">
            <template #default="{ row }"><el-tag size="small" :type="row.status === 'success' ? 'success' : 'danger'">{{ row.status === 'success' ? '성공' : '실패' }}</el-tag></template>
          </el-table-column>
          <el-table-column label="시각" width="170"><template #default="{ row }">{{ fmtTime(row.startedAt) }}</template></el-table-column>
          <el-table-column label="방식" width="70"><template #default="{ row }">{{ row.trigger === 'manual' ? '수동' : '예약' }}</template></el-table-column>
          <el-table-column prop="name" label="스냅샷" min-width="250" show-overflow-tooltip />
          <el-table-column label="크기" width="90"><template #default="{ row }">{{ row.sizeBytes ? mb(row.sizeBytes) : '-' }}</template></el-table-column>
          <el-table-column label="소요" width="70"><template #default="{ row }">{{ row.durationMs != null ? `${Math.round(row.durationMs / 1000)}초` : '-' }}</template></el-table-column>
          <el-table-column label="" width="210" fixed="right">
            <template #default="{ row }">
              <template v-if="row.status === 'success'">
                <el-button v-if="canWrite" size="small" :disabled="busy('drill')" @click="drillNow(row.name)">이 스냅샷으로 연습</el-button>
                <el-button size="small" type="warning" plain @click="openRunbook(row.name)">절차서</el-button>
              </template>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>
      <el-tab-pane label="복원 연습 이력">
        <el-table :data="st?.drills ?? []" size="small" stripe max-height="420">
          <el-table-column type="expand">
            <template #default="{ row }">
              <div class="detail">
                <div v-for="c in row.checks" :key="c.name">{{ c.ok ? '✅' : c.level === 'info' ? '⚠️' : '❌' }} <b>{{ c.name }}</b> <span class="sub">{{ c.detail }}</span></div>
                <div v-if="row.error" style="color: #f56c6c">오류: {{ row.error }}</div>
                <div class="sub">Job {{ row.jobName }} · 노드 {{ row.node }}</div>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="결과" width="80">
            <template #default="{ row }"><el-tag size="small" :type="row.status === 'success' ? 'success' : 'danger'">{{ row.status === 'success' ? '성공' : '실패' }}</el-tag></template>
          </el-table-column>
          <el-table-column label="시각" width="170"><template #default="{ row }">{{ fmtTime(row.startedAt) }}</template></el-table-column>
          <el-table-column label="방식" width="70"><template #default="{ row }">{{ row.trigger === 'manual' ? '수동' : '예약' }}</template></el-table-column>
          <el-table-column prop="snapshot" label="대상 스냅샷" min-width="250" show-overflow-tooltip />
          <el-table-column label="검증" width="110"><template #default="{ row }">{{ row.checks.filter((c: any) => c.ok).length }}/{{ row.checks.length }} 통과</template></el-table-column>
          <el-table-column label="소요" width="70"><template #default="{ row }">{{ row.durationMs != null ? `${Math.round(row.durationMs / 1000)}초` : '-' }}</template></el-table-column>
        </el-table>
      </el-tab-pane>
    </el-tabs>

    <!-- 롤백 절차서 -->
    <el-dialog v-model="rbVisible" :title="`etcd 롤백 절차서 — ${rb?.snapshot ?? ''}`" width="960px" top="3vh" destroy-on-close>
      <el-alert type="error" :closable="false" show-icon style="margin-bottom: 12px"
        title="클러스터 전체를 이 스냅샷 시점으로 되돌리는 작업입니다. 웹에서 실행되지 않으며, 운영자가 각 컨트롤 플레인 노드에서 순서대로 실행합니다." />
      <el-alert v-for="w in rb?.warnings ?? []" :key="w" type="warning" :closable="false" :title="w" style="margin-bottom: 8px" />
      <div style="margin-bottom: 8px; display: flex; gap: 8px">
        <el-button size="small" @click="copy(rb?.markdown ?? '')">전체 복사</el-button>
        <el-button size="small" @click="download">Markdown 파일로 저장</el-button>
      </div>
      <el-tabs>
        <el-tab-pane label="전체 절차">
          <pre class="md">{{ rb?.markdown }}</pre>
        </el-tab-pane>
        <el-tab-pane v-for="n in rb?.nodes ?? []" :key="n.name" :label="`4단계: ${n.name} (${n.host})`">
          <el-button size="small" style="margin-bottom: 6px" @click="copy(n.script)">이 노드 명령 복사</el-button>
          <pre class="md">{{ n.script }}</pre>
        </el-tab-pane>
      </el-tabs>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { Refresh } from '@element-plus/icons-vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api, type EtcdCron, type EtcdRunbook, type EtcdState } from '@/api/client';
import { fmtTime } from '@/utils/format';
import { webAccess } from '@/web-access';

const canWrite = computed(() => webAccess.role === 'admin');
const st = ref<EtcdState | null>(null);
const loading = ref(false);
const installed = computed(() => !!st.value?.crons?.find((c) => c.kind === 'snapshot')?.installed);
const snapCron = computed(() => st.value?.crons?.find((c) => c.kind === 'snapshot'));
const busy = (kind: 'snapshot' | 'drill') => !!st.value?.running?.some((j) => j.kind === kind);
const mb = (b: number) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)}MB` : `${Math.max(1, Math.round(b / 1024))}KB`);

const hostOf = (u?: string) => {
  try {
    return u ? new URL(u).host : '-';
  } catch {
    return u ?? '-';
  }
};
const memberRows = computed(() =>
  (st.value?.members ?? [])
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((m) => {
      const ep = st.value?.endpoints?.find((e) => e.memberId === m.id || m.clientURLs.includes(e.endpoint));
      return { name: m.name, host: hostOf(m.clientURLs[0]), leader: !!ep?.leader, dbSize: ep?.dbSize, version: ep?.version, errors: ep?.errors, responded: !!ep };
    }),
);
const leaderName = computed(() => memberRows.value.find((m) => m.leader)?.name ?? '-');

function describe(c: EtcdCron) {
  const [mi, ho, dom, , dow] = String(c.schedule).split(/\s+/);
  const tz = c.timeZone === 'Asia/Seoul' ? '(한국 시간)' : c.timeZone ? `(${c.timeZone})` : '(UTC)';
  if (/^\*\/\d+$/.test(ho) && dom === '*' && dow === '*') return `${ho.slice(2)}시간마다 ${mi}분 ${tz}`;
  if (/^\d+$/.test(ho) && dom === '*' && dow === '*') return `매일 ${ho.padStart(2, '0')}:${mi.padStart(2, '0')} ${tz}`;
  return `${c.schedule} ${tz}`;
}

async function load() {
  loading.value = true;
  try {
    st.value = await api.etcd();
  } finally {
    loading.value = false;
  }
}

async function snapshotNow() {
  await ElMessageBox.confirm('지금 etcd 스냅샷을 만들어 SeaweedFS 에 저장합니다. 보통 1분 안에 끝납니다.', 'etcd 스냅샷', {
    type: 'info', confirmButtonText: '실행', cancelButtonText: '취소',
  });
  await api.etcdSnapshotNow();
  ElMessage.success('스냅샷을 시작했습니다');
  await load();
}

async function drillNow(snapshot?: string) {
  await ElMessageBox.confirm(
    `${snapshot ? `스냅샷 ${snapshot}` : '최신 스냅샷'} 을(를) 임시 etcd 에 복원해 검증합니다. 운영 etcd 는 건드리지 않습니다.`,
    'etcd 복원 연습',
    { type: 'info', confirmButtonText: '실행', cancelButtonText: '취소' },
  );
  await api.etcdDrillNow(snapshot);
  ElMessage.success('복원 연습을 시작했습니다');
  await load();
}

const rbVisible = ref(false);
const rb = ref<EtcdRunbook | null>(null);
async function openRunbook(snapshot?: string) {
  rb.value = await api.etcdRunbook(snapshot);
  rbVisible.value = true;
}
async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    ElMessage.success('복사했습니다');
  } catch {
    ElMessage.warning('복사하지 못했습니다. 직접 선택해 복사하세요');
  }
}
function download() {
  if (!rb.value) return;
  const blob = new Blob([rb.value.markdown], { type: 'text/markdown;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `etcd-rollback-${rb.value.snapshot}.md`;
  a.click();
  URL.revokeObjectURL(a.href);
}

let timer: ReturnType<typeof setTimeout> | undefined;
function tick() {
  timer = setTimeout(async () => {
    try {
      await load();
    } catch {
      /* 다음 주기 */
    }
    tick();
  }, st.value?.running?.length ? 5000 : 60000);
}
onMounted(async () => {
  await load();
  tick();
});
onBeforeUnmount(() => clearTimeout(timer));
</script>

<style scoped>
.lbl { font-size: 13px; color: #909399; }
.big { font-size: 26px; font-weight: 700; min-height: 34px; }
.unit { font-size: 13px; font-weight: 400; margin-left: 4px; color: #909399; }
.sub { font-size: 12px; color: #909399; line-height: 1.7; }
.cron { padding: 6px 0; border-bottom: 1px solid #f0f2f5; }
.cron:last-of-type { border-bottom: none; }
.detail { padding: 4px 24px; font-size: 12px; line-height: 1.8; }
.md { white-space: pre-wrap; font-size: 12px; background: var(--el-fill-color-light, #f5f7fa); padding: 12px; border-radius: 6px; max-height: 62vh; overflow: auto; }
</style>
