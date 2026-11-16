import type { FastifyInstance } from 'fastify';
import { velero, PLURALS, API_VERSION } from '../k8s/velero';
import { pruneEmpty } from '../util/clean';
import { config } from '../config';
import { nextRuns, prevRun, parseVeleroCron, validateVeleroCron } from '../util/cron';
import type { Schedule, ScheduleSpec, CustomResource, Backup } from '../types/velero';

/** 대시보드 전용 어노테이션 — Velero 동작에는 영향 없음. */
export const ANN = {
  displayName: 'gimpo.io/display-name',
  description: 'gimpo.io/description',
  /** 실제 이름 변경 시 "이력 연결"을 고르면 이전 이름들을 쉼표로 누적한다. */
  previousNames: 'gimpo.io/previous-names',
} as const;

const HELM_LABELS = ['app.kubernetes.io/managed-by', 'helm.sh/chart', 'app.kubernetes.io/instance'];
const HELM_ANNOTATIONS = ['meta.helm.sh/release-name', 'meta.helm.sh/release-namespace'];
const DNS1123 = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

interface CreateScheduleBody {
  name: string;
  displayName?: string;
  description?: string;
  labels?: Record<string, string>;
  spec: ScheduleSpec;
}

interface UpdateScheduleBody {
  displayName?: string;
  description?: string;
  schedule?: string;
  paused?: boolean;
  template?: ScheduleSpec['template'];
}

interface RenameBody {
  newName: string;
  /** link: 기존 백업 유지 + 새 이름 이력에 연결 / keep: 유지만 / delete: 기존 백업 삭제 */
  oldBackups: 'link' | 'keep' | 'delete';
}

export function previousNamesOf(s: Schedule): string[] {
  const v = s.metadata?.annotations?.[ANN.previousNames];
  return v ? v.split(',').map((x) => x.trim()).filter(Boolean) : [];
}

export function isHelmManaged(s: Schedule): boolean {
  return s.metadata?.labels?.['app.kubernetes.io/managed-by'] === 'Helm';
}

/** 화면 표시용 계산 필드. */
export function decorate(s: Schedule) {
  const raw = s.spec?.schedule ?? '';
  const p = parseVeleroCron(raw);
  return {
    ...s,
    gimpo: {
      displayName: s.metadata?.annotations?.[ANN.displayName] ?? '',
      description: s.metadata?.annotations?.[ANN.description] ?? '',
      previousNames: previousNamesOf(s),
      helmManaged: isHelmManaged(s),
      tz: p.tz,
      expr: p.expr,
      nextRuns: s.spec?.paused ? [] : nextRuns(raw, 3),
      prevExpected: prevRun(raw),
    },
  };
}

function setAnnotation(meta: NonNullable<CustomResource['metadata']>, key: string, value?: string) {
  if (value === undefined) return;
  meta.annotations = { ...(meta.annotations ?? {}) };
  if (value.trim() === '') delete meta.annotations[key];
  else meta.annotations[key] = value.trim();
}

/** 이 스케줄(및 연결된 이전 이름)로 만들어진 백업 목록. */
async function backupsOfNames(names: string[]): Promise<Backup[]> {
  if (names.length === 0) return [];
  const sel = `velero.io/schedule-name in (${names.join(',')})`;
  const list = await velero.listBySelector<Backup>(PLURALS.backups, sel);
  return list.items.sort((a, b) =>
    (b.metadata?.creationTimestamp ?? '').localeCompare(a.metadata?.creationTimestamp ?? ''),
  );
}

export default async function scheduleRoutes(app: FastifyInstance) {
  app.get('/api/schedules', async () => {
    const list = await velero.list<Schedule>(PLURALS.schedules);
    return list.items.map(decorate);
  });

  app.get<{ Params: { name: string } }>('/api/schedules/:name', async (req) => {
    return decorate(await velero.get<Schedule>(PLURALS.schedules, req.params.name));
  });

  /** cron 미리보기 — 화면의 일정 빌더가 다음 실행 시각을 보여줄 때 사용. */
  app.post<{ Body: { schedule: string } }>('/api/cron/preview', async (req, reply) => {
    try {
      const p = validateVeleroCron(req.body?.schedule ?? '');
      return { tz: p.tz, expr: p.expr, nextRuns: nextRuns(p.raw, 5) };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.post<{ Body: CreateScheduleBody }>('/api/schedules', async (req, reply) => {
    const { name, labels, spec, displayName, description } = req.body;
    if (!name) return reply.code(400).send({ error: 'name 은 필수입니다' });
    if (!DNS1123.test(name)) {
      return reply.code(400).send({ error: '이름은 영문 소문자·숫자·하이픈만 사용할 수 있습니다' });
    }
    if (!spec?.schedule) return reply.code(400).send({ error: 'schedule(cron) 은 필수입니다' });
    try {
      validateVeleroCron(spec.schedule);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    const metadata: NonNullable<CustomResource['metadata']> = {
      name,
      namespace: config.veleroNamespace,
      labels,
    };
    setAnnotation(metadata, ANN.displayName, displayName);
    setAnnotation(metadata, ANN.description, description);
    const body: CustomResource = {
      apiVersion: API_VERSION,
      kind: 'Schedule',
      metadata,
      spec: pruneEmpty(spec),
    };
    const created = await velero.create<Schedule>(PLURALS.schedules, pruneEmpty(body));
    return reply.code(201).send(decorate(created));
  });

  /**
   * 스케줄 편집 — 표시 이름/설명/일정/일시정지/백업 템플릿.
   * 템플릿은 통째로 교체한다(필드 삭제가 반영되도록). resourceVersion 으로 동시 수정 충돌을 막는다.
   */
  app.put<{ Params: { name: string }; Body: UpdateScheduleBody }>(
    '/api/schedules/:name',
    async (req, reply) => {
      const b = req.body ?? {};
      if (b.schedule !== undefined) {
        try {
          validateVeleroCron(b.schedule);
        } catch (err) {
          return reply.code(400).send({ error: (err as Error).message });
        }
      }
      const cur = await velero.get<Schedule>(PLURALS.schedules, req.params.name);
      const metadata = { ...(cur.metadata ?? {}) } as NonNullable<CustomResource['metadata']>;
      setAnnotation(metadata, ANN.displayName, b.displayName);
      setAnnotation(metadata, ANN.description, b.description);
      const spec: ScheduleSpec = {
        ...(cur.spec as ScheduleSpec),
        ...(b.schedule !== undefined ? { schedule: b.schedule.trim() } : {}),
        ...(b.paused !== undefined ? { paused: !!b.paused } : {}),
        ...(b.template !== undefined ? { template: pruneEmpty(b.template) } : {}),
      };
      const body: CustomResource = {
        apiVersion: API_VERSION,
        kind: 'Schedule',
        metadata,
        spec,
      };
      const updated = await velero.replace<Schedule>(PLURALS.schedules, req.params.name, body);
      return decorate(updated);
    },
  );

  /**
   * 실제 이름 변경 — Velero 스케줄 이름은 바꿀 수 없으므로 "같은 설정으로 새로 생성 → 기존 삭제".
   * 기존 백업은 velero.io/schedule-name 라벨에 옛 이름을 가진 채 남는다.
   *  - link  : 유지 + 새 스케줄의 previous-names 에 옛 이름을 기록해 이력 화면에서 함께 조회
   *  - keep  : 유지만(연결 안 함). 보관 기간이 끝나면 자동 삭제
   *  - delete: 옛 이름의 백업 전부 DeleteBackupRequest 로 삭제(되돌릴 수 없음)
   */
  app.post<{ Params: { name: string }; Body: RenameBody }>(
    '/api/schedules/:name/rename',
    async (req, reply) => {
      const oldName = req.params.name;
      const { newName, oldBackups } = req.body ?? ({} as RenameBody);
      if (!newName || !DNS1123.test(newName) || newName.length > 63) {
        return reply
          .code(400)
          .send({ error: '새 이름은 63자 이내 영문 소문자·숫자·하이픈만 사용할 수 있습니다' });
      }
      if (newName === oldName) return reply.code(400).send({ error: '기존 이름과 같습니다' });
      if (!['link', 'keep', 'delete'].includes(oldBackups)) {
        return reply.code(400).send({ error: 'oldBackups 는 link | keep | delete 중 하나' });
      }

      const cur = await velero.get<Schedule>(PLURALS.schedules, oldName);
      const labels = { ...(cur.metadata?.labels ?? {}) };
      for (const k of HELM_LABELS) delete labels[k];
      const annotations = { ...(cur.metadata?.annotations ?? {}) };
      for (const k of HELM_ANNOTATIONS) delete annotations[k];
      delete annotations['kubectl.kubernetes.io/last-applied-configuration'];
      const prev = previousNamesOf(cur);
      if (oldBackups === 'link') annotations[ANN.previousNames] = [...prev, oldName].join(',');
      else if (prev.length === 0) delete annotations[ANN.previousNames];

      const created = await velero.create<Schedule>(PLURALS.schedules, {
        apiVersion: API_VERSION,
        kind: 'Schedule',
        metadata: { name: newName, namespace: config.veleroNamespace, labels, annotations },
        spec: cur.spec,
      });

      const oldBackupList = await backupsOfNames([oldName]);
      // useOwnerReferencesInBackup 이 켜져 있으면 스케줄 삭제 시 백업이 GC 로 지워진다 → 유지 선택 시 소유권 해제
      if (oldBackups !== 'delete' && (cur.spec as ScheduleSpec)?.useOwnerReferencesInBackup) {
        for (const bk of oldBackupList) {
          if (bk.metadata?.ownerReferences?.length) {
            await velero.mergePatch(PLURALS.backups, bk.metadata.name!, {
              metadata: { ownerReferences: null },
            });
          }
        }
      }
      await velero.delete(PLURALS.schedules, oldName);

      let deleteRequested = 0;
      if (oldBackups === 'delete') {
        for (const bk of oldBackupList) {
          const bn = bk.metadata!.name!;
          await velero.create(PLURALS.deleteBackupRequests, {
            apiVersion: API_VERSION,
            kind: 'DeleteBackupRequest',
            metadata: {
              generateName: `${bn.slice(0, 50)}-`,
              namespace: config.veleroNamespace,
              labels: {
                'velero.io/backup-name': bn.slice(0, 63),
                ...(bk.metadata?.uid ? { 'velero.io/backup-uid': bk.metadata.uid } : {}),
              },
            },
            spec: { backupName: bn },
          });
          deleteRequested++;
        }
      }

      return reply.code(201).send({
        message: `스케줄 이름 변경: ${oldName} → ${newName}`,
        schedule: decorate(created),
        oldBackups: { policy: oldBackups, count: oldBackupList.length, deleteRequested },
        helmWarning: isHelmManaged(cur)
          ? '이 스케줄은 Helm 이 만든 것입니다. Helm values 의 스케줄 이름도 바꾸지 않으면 다음 helm upgrade 때 옛 이름으로 다시 생성됩니다.'
          : undefined,
      });
    },
  );

  /** 스케줄의 백업 이력 — previous=1 이면 연결된 이전 이름의 백업도 포함. */
  app.get<{ Params: { name: string }; Querystring: { previous?: string } }>(
    '/api/schedules/:name/backups',
    async (req) => {
      const s = await velero.get<Schedule>(PLURALS.schedules, req.params.name);
      const names = [req.params.name, ...(req.query.previous === '1' ? previousNamesOf(s) : [])];
      return await backupsOfNames(names);
    },
  );

  app.delete<{ Params: { name: string } }>('/api/schedules/:name', async (req) => {
    await velero.delete(PLURALS.schedules, req.params.name);
    return { message: 'Schedule 삭제됨', name: req.params.name };
  });

  // pause / resume 토글 (merge patch)
  app.patch<{ Params: { name: string }; Body: { paused: boolean } }>(
    '/api/schedules/:name/pause',
    async (req) => {
      return await velero.mergePatch<Schedule>(PLURALS.schedules, req.params.name, {
        spec: { paused: !!req.body.paused },
      });
    },
  );

  // 즉시 실행 — 스케줄의 template 으로 Backup 을 즉시 생성 (velero create backup --from-schedule 과 동등)
  app.post<{ Params: { name: string } }>('/api/schedules/:name/trigger', async (req, reply) => {
    const schedule = await velero.get<Schedule>(PLURALS.schedules, req.params.name);
    const template = schedule.spec?.template ?? {};
    const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const backupName = `${req.params.name}-${ts}`.slice(0, 253);
    const body: CustomResource = {
      apiVersion: API_VERSION,
      kind: 'Backup',
      metadata: {
        name: backupName,
        namespace: config.veleroNamespace,
        labels: { 'velero.io/schedule-name': req.params.name },
      },
      spec: pruneEmpty(template),
    };
    const created = await velero.create(PLURALS.backups, body);
    return reply.code(201).send({ message: '스케줄 template 으로 백업 즉시 생성', backup: created });
  });
}
