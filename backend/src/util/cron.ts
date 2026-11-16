import { CronExpressionParser } from 'cron-parser';

/**
 * Velero Schedule 의 cron 문자열 해석.
 *
 * Velero(robfig/cron v3 ParseStandard)는 `CRON_TZ=Asia/Seoul 0 3 * * *` 처럼 앞에 타임존을
 * 붙인 표기를 지원한다(이 클러스터 v1.18 에서 검증됨). 접두어가 없으면 UTC 로 해석된다.
 */
export const DEFAULT_TZ = 'Asia/Seoul';

export interface ParsedCron {
  /** 원문 */
  raw: string;
  /** 타임존 (접두어 없으면 UTC) */
  tz: string;
  /** 5필드 표현식 (타임존 접두어 제거) */
  expr: string;
}

export function parseVeleroCron(raw: string): ParsedCron {
  const trimmed = (raw ?? '').trim();
  const m = /^(?:CRON_TZ|TZ)=(\S+)\s+(.+)$/.exec(trimmed);
  if (m) return { raw: trimmed, tz: m[1], expr: m[2].trim() };
  return { raw: trimmed, tz: 'UTC', expr: trimmed };
}

/** 표현식 유효성 검사. 잘못되면 사람이 읽을 수 있는 메시지를 던진다. */
export function validateVeleroCron(raw: string): ParsedCron {
  const p = parseVeleroCron(raw);
  if (p.expr.split(/\s+/).length !== 5) {
    throw new Error(`cron 은 5개 필드(분 시 일 월 요일)여야 합니다: "${p.expr}"`);
  }
  try {
    CronExpressionParser.parse(p.expr, { tz: p.tz });
  } catch (err) {
    throw new Error(`cron 해석 실패: ${(err as Error).message}`);
  }
  return p;
}

/** from 이후 n 개의 실행 시각(ISO). */
export function nextRuns(raw: string, n = 1, from: Date = new Date()): string[] {
  const p = parseVeleroCron(raw);
  try {
    const it = CronExpressionParser.parse(p.expr, { tz: p.tz, currentDate: from });
    const out: string[] = [];
    for (let i = 0; i < n; i++) out.push(it.next().toDate().toISOString());
    return out;
  } catch {
    return [];
  }
}

/** from 이전(또는 같은) 가장 최근 예정 실행 시각(ISO). */
export function prevRun(raw: string, from: Date = new Date()): string | undefined {
  const p = parseVeleroCron(raw);
  try {
    const it = CronExpressionParser.parse(p.expr, { tz: p.tz, currentDate: from });
    return it.prev().toDate().toISOString();
  } catch {
    return undefined;
  }
}

/** 두 연속 실행 사이 간격(ms). 지연 판정의 허용 오차 계산용. */
export function intervalMs(raw: string, from: Date = new Date()): number | undefined {
  const runs = nextRuns(raw, 2, from);
  if (runs.length < 2) return undefined;
  return new Date(runs[1]).getTime() - new Date(runs[0]).getTime();
}
