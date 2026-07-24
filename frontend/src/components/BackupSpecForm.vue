<template>
  <el-form label-position="top" size="default">
    <el-alert
      type="info"
      :closable="false"
      show-icon
      title="네임스페이스를 비워두면 전체 클러스터가 대상입니다. kube-system 등 시스템 네임스페이스도 선택할 수 있습니다."
      style="margin-bottom: 12px"
    />

    <el-row :gutter="16">
      <el-col :span="12">
        <el-form-item label="포함 네임스페이스 (includedNamespaces)">
          <NamespaceSelector v-model="m.includedNamespaces" placeholder="비우면 전체" />
        </el-form-item>
      </el-col>
      <el-col :span="12">
        <el-form-item label="제외 네임스페이스 (excludedNamespaces)">
          <NamespaceSelector v-model="m.excludedNamespaces" placeholder="제외할 NS" />
        </el-form-item>
      </el-col>
    </el-row>

    <el-row :gutter="16">
      <el-col :span="12">
        <el-form-item label="포함 리소스 (includedResources)">
          <ResourceSelector v-model="m.includedResources" />
        </el-form-item>
      </el-col>
      <el-col :span="12">
        <el-form-item label="제외 리소스 (excludedResources)">
          <ResourceSelector v-model="m.excludedResources" />
        </el-form-item>
      </el-col>
    </el-row>

    <el-form-item label="라벨 셀렉터 (matchLabels — key=value, 오브젝트 단위 선택)">
      <el-select
        v-model="labelPairs"
        multiple
        filterable
        allow-create
        default-first-option
        placeholder="예: app=nginx"
        style="width: 100%"
      />
    </el-form-item>

    <el-row :gutter="16">
      <el-col :span="8">
        <el-form-item label="클러스터 리소스 포함 (includeClusterResources)">
          <el-select v-model="m.includeClusterResources" style="width: 100%">
            <el-option label="자동 (auto)" :value="null" />
            <el-option label="포함 (true)" :value="true" />
            <el-option label="제외 (false)" :value="false" />
          </el-select>
        </el-form-item>
      </el-col>
      <el-col :span="8">
        <el-form-item label="볼륨 스냅샷 (snapshotVolumes)">
          <el-select v-model="m.snapshotVolumes" style="width: 100%">
            <el-option label="자동 (auto)" :value="null" />
            <el-option label="예 (true)" :value="true" />
            <el-option label="아니오 (false)" :value="false" />
          </el-select>
        </el-form-item>
      </el-col>
      <el-col :span="8">
        <el-form-item label="TTL (보관 기간)">
          <el-input v-model="m.ttl" placeholder="720h0m0s" />
        </el-form-item>
      </el-col>
    </el-row>

    <el-row :gutter="16">
      <el-col :span="8">
        <el-form-item label="파일시스템 백업 기본값 (defaultVolumesToFsBackup)">
          <el-switch v-model="fsBackup" />
        </el-form-item>
      </el-col>
      <el-col :span="8">
        <el-form-item label="스냅샷 데이터 이동 (snapshotMoveData)">
          <el-switch v-model="moveData" />
        </el-form-item>
      </el-col>
    </el-row>

    <el-row :gutter="16">
      <el-col :span="12">
        <el-form-item label="스토리지 위치 (storageLocation)">
          <el-select v-model="m.storageLocation" clearable placeholder="기본 BSL" style="width: 100%">
            <el-option v-for="b in bslNames" :key="b" :label="b" :value="b" />
          </el-select>
        </el-form-item>
      </el-col>
      <el-col :span="12">
        <el-form-item label="볼륨 스냅샷 위치 (volumeSnapshotLocations)">
          <el-select v-model="m.volumeSnapshotLocations" multiple clearable style="width: 100%">
            <el-option v-for="v in vslNames" :key="v" :label="v" :value="v" />
          </el-select>
        </el-form-item>
      </el-col>
    </el-row>

    <el-collapse>
      <el-collapse-item title="고급 (타임아웃 / hooks / orderedResources)">
        <el-row :gutter="16">
          <el-col :span="12">
            <el-form-item label="itemOperationTimeout">
              <el-input v-model="m.itemOperationTimeout" placeholder="예: 4h0m0s" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="csiSnapshotTimeout">
              <el-input v-model="m.csiSnapshotTimeout" placeholder="예: 10m0s" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item label="hooks (JSON) — 백업 pre/post exec 훅">
          <el-input v-model="hooksJson" type="textarea" :rows="4" placeholder='{"resources":[...]}' />
        </el-form-item>
      </el-collapse-item>
    </el-collapse>
  </el-form>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import NamespaceSelector from './NamespaceSelector.vue';
import ResourceSelector from './ResourceSelector.vue';
import { api } from '@/api/client';

// BackupSpec 을 v-model 로 양방향 바인딩
const m = defineModel<Record<string, any>>({ required: true });

const bslNames = ref<string[]>([]);
const vslNames = ref<string[]>([]);

// switch 는 undefined 를 다루지 못하므로 별도 계산 프록시
const fsBackup = computed({
  get: () => !!m.value.defaultVolumesToFsBackup,
  set: (v) => (m.value.defaultVolumesToFsBackup = v),
});
const moveData = computed({
  get: () => !!m.value.snapshotMoveData,
  set: (v) => (m.value.snapshotMoveData = v),
});

// matchLabels ↔ ["k=v"] 배열 변환
const labelPairs = ref<string[]>([]);
watch(
  labelPairs,
  (pairs) => {
    const obj: Record<string, string> = {};
    for (const p of pairs) {
      const i = p.indexOf('=');
      if (i > 0) obj[p.slice(0, i).trim()] = p.slice(i + 1).trim();
    }
    m.value.labelSelector = Object.keys(obj).length ? { matchLabels: obj } : undefined;
  },
  { deep: true },
);

// hooks JSON 파싱
const hooksJson = ref('');
watch(hooksJson, (txt) => {
  const t = txt.trim();
  if (!t) {
    m.value.hooks = undefined;
    return;
  }
  try {
    m.value.hooks = JSON.parse(t);
  } catch {
    /* 파싱 실패 시 그대로 두고 제출 검증에서 걸림 */
  }
});

onMounted(async () => {
  const [b, v] = await Promise.all([api.listBSL().catch(() => []), api.listVSL().catch(() => [])]);
  bslNames.value = b.map((x) => x.metadata?.name!).filter(Boolean);
  vslNames.value = v.map((x) => x.metadata?.name!).filter(Boolean);
});
</script>
