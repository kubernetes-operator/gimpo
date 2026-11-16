<template>
  <el-dialog
    :model-value="modelValue"
    :title="`스케줄 편집 — ${schedule?.metadata?.name ?? ''}`"
    width="860px"
    top="4vh"
    destroy-on-close
    @update:model-value="emit('update:modelValue', $event)"
  >
    <el-form v-if="schedule" label-position="top">
      <el-row :gutter="16">
        <el-col :span="12">
          <el-form-item label="표시 이름 (화면에만 보이는 이름)">
            <el-input v-model="form.displayName" placeholder="예: 앱 데이터 일일 백업" maxlength="60" show-word-limit />
          </el-form-item>
        </el-col>
        <el-col :span="12">
          <el-form-item label="설명">
            <el-input v-model="form.description" placeholder="예: default·demo-app·memonest, SeaweedFS" maxlength="200" />
          </el-form-item>
        </el-col>
      </el-row>

      <el-form-item>
        <el-checkbox v-model="form.renameEnabled">실제 스케줄 이름도 변경</el-checkbox>
      </el-form-item>

      <div v-if="form.renameEnabled" class="rename-box">
        <el-alert type="warning" :closable="false" show-icon title="실제 이름을 바꾸면 이렇게 됩니다">
          <ul style="margin: 4px 0 0; padding-left: 18px; line-height: 1.7">
            <li>Velero 스케줄 이름은 바꿀 수 없어서 <b>같은 설정으로 새 스케줄을 만들고 기존 스케줄을 삭제</b>합니다.</li>
            <li>
              기존 스케줄로 만든 백업 <b>{{ oldBackupCount }}개</b>는 옛 이름(<code>{{ schedule.metadata?.name }}</code>)을
              가진 채 남습니다. 아래에서 처리 방법을 고르세요.
            </li>
            <li v-if="schedule.gimpo?.helmManaged">
              <b>이 스케줄은 Helm 으로 만들어졌습니다.</b> Helm values 의 스케줄 이름도 바꾸지 않으면 다음 helm upgrade 때
              옛 이름의 스케줄이 다시 생겨 <b>백업이 두 번씩</b> 돌 수 있습니다.
            </li>
          </ul>
        </el-alert>

        <el-form-item label="새 이름 (영문 소문자·숫자·하이픈)" style="margin-top: 12px">
          <el-input v-model="form.newName" placeholder="예: app-data-daily" />
        </el-form-item>

        <el-form-item label="기존 백업 처리">
          <el-radio-group v-model="form.oldBackups" style="display: flex; flex-direction: column; align-items: flex-start; gap: 6px">
            <el-radio value="link">
              유지하고 새 이름의 이력에 연결 <span class="hint">— 이력 화면에서 과거 백업을 함께 확인 (권장)</span>
            </el-radio>
            <el-radio value="keep">
              유지만 <span class="hint">— 백업 목록에는 남지만 새 스케줄 이력에는 안 보임, 보관 기간 후 자동 삭제</span>
            </el-radio>
            <el-radio value="delete">
              <span style="color: #f56c6c">삭제</span>
              <span class="hint">— 기존 백업 {{ oldBackupCount }}개를 저장소에서 지움. 되돌릴 수 없음</span>
            </el-radio>
          </el-radio-group>
        </el-form-item>
      </div>

      <el-divider content-position="left">실행 일정</el-divider>
      <CronBuilder v-model="form.schedule" />

      <el-divider content-position="left">백업 내용 (대상·저장 위치·보관 기간)</el-divider>
      <BackupSpecForm v-model="form.template" />
    </el-form>

    <template #footer>
      <el-button @click="emit('update:modelValue', false)">취소</el-button>
      <el-button type="primary" :loading="saving" @click="save">저장</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { reactive, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api, type ScheduleCR } from '@/api/client';
import CronBuilder from './CronBuilder.vue';
import BackupSpecForm from './BackupSpecForm.vue';

const props = defineProps<{ modelValue: boolean; schedule: ScheduleCR | null }>();
const emit = defineEmits<{ (e: 'update:modelValue', v: boolean): void; (e: 'saved'): void }>();

const form = reactive({
  displayName: '',
  description: '',
  schedule: '',
  template: {} as Record<string, any>,
  renameEnabled: false,
  newName: '',
  oldBackups: 'link' as 'link' | 'keep' | 'delete',
});
const oldBackupCount = ref(0);
const saving = ref(false);

watch(
  () => [props.modelValue, props.schedule] as const,
  async ([open, s]) => {
    if (!open || !s) return;
    form.displayName = s.gimpo?.displayName ?? '';
    form.description = s.gimpo?.description ?? '';
    form.schedule = s.spec?.schedule ?? '';
    form.template = JSON.parse(JSON.stringify(s.spec?.template ?? {}));
    form.renameEnabled = false;
    form.newName = '';
    form.oldBackups = 'link';
    oldBackupCount.value = (await api.scheduleBackups(s.metadata.name!, false).catch(() => [])).length;
  },
  { immediate: true },
);

async function save() {
  const s = props.schedule;
  if (!s) return;
  const name = s.metadata.name!;
  if (form.renameEnabled) {
    if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(form.newName)) {
      return ElMessage.warning('새 이름은 영문 소문자·숫자·하이픈만 사용할 수 있습니다');
    }
    const what =
      form.oldBackups === 'delete'
        ? `기존 백업 ${oldBackupCount.value}개를 <b>삭제</b>합니다(되돌릴 수 없음).`
        : form.oldBackups === 'link'
          ? `기존 백업 ${oldBackupCount.value}개는 유지되고 새 이름의 이력에서 함께 보입니다.`
          : `기존 백업 ${oldBackupCount.value}개는 유지되지만 새 이름의 이력에는 보이지 않습니다.`;
    await ElMessageBox.confirm(
      `<p>스케줄 <code>${name}</code> → <code>${form.newName}</code></p><p>${what}</p>` +
        (s.gimpo?.helmManaged ? '<p style="color:#e6a23c">Helm values 의 이름도 함께 바꿔야 중복 실행을 막을 수 있습니다.</p>' : ''),
      '실제 이름 변경 확인',
      {
        type: form.oldBackups === 'delete' ? 'error' : 'warning',
        dangerouslyUseHTMLString: true,
        confirmButtonText: '변경',
        cancelButtonText: '취소',
      },
    );
  }
  saving.value = true;
  try {
    await api.updateSchedule(name, {
      displayName: form.displayName,
      description: form.description,
      schedule: form.schedule,
      template: form.template,
    });
    if (form.renameEnabled) {
      const r = await api.renameSchedule(name, { newName: form.newName, oldBackups: form.oldBackups });
      ElMessage.success(r.message);
      if (r.helmWarning) ElMessage.warning({ message: r.helmWarning, duration: 8000 });
    } else {
      ElMessage.success('저장됨');
    }
    emit('saved');
    emit('update:modelValue', false);
  } finally {
    saving.value = false;
  }
}
</script>

<style scoped>
.rename-box {
  border: 1px dashed #e6a23c;
  border-radius: 6px;
  padding: 12px;
  margin-bottom: 8px;
}
.hint {
  color: #909399;
  font-size: 12px;
}
</style>
