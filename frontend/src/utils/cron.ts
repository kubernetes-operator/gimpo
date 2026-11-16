/**
 * 한국 시간(KST) 일정 빌더 ↔ Velero cron 문자열 변환.
 * Velero 는 `CRON_TZ=Asia/Seoul 분 시 일 월 요일` 표기를 지원한다(이 클러스터에서 검증).
 */
export const KST_PREFIX = 'CRON_TZ=Asia/Seoul';

export type Mode = 'daily' | 'weekly' | 'monthly' | 'custom';
export interface Simple {
  mode: Mode;
  hour: number;
  minute: number;
  /** 0=일 … 6=토 */
  weekday: number;
  day: number;
  /** custom 일 때 원문 */
  raw: string;
  /** UTC 표기를 KST 로 변환해 읽었는지 */
  convertedFromUtc: boolean;
}

export const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

const num = (s: string) => (/^\d+$/.test(s) ? Number(s) : NaN);

export function toCron(s: Simple): string {
  if (s.mode === 'custom') return s.raw.trim();
  const m = s.minute;
  const h = s.hour;
  if (s.mode === 'daily') return `${KST_PREFIX} ${m} ${h} * * *`;
  if (s.mode === 'weekly') return `${KST_PREFIX} ${m} ${h} * * ${s.weekday}`;
  return `${KST_PREFIX} ${m} ${h} ${s.day} * *`;
}

export function fromCron(raw: string): Simple {
  const base: Simple = { mode: 'custom', hour: 3, minute: 0, weekday: 0, day: 1, raw: raw ?? '', convertedFromUtc: false };
  const t = (raw ?? '').trim();
  const tzm = /^(?:CRON_TZ|TZ)=(\S+)\s+(.+)$/.exec(t);
  const tz = tzm ? tzm[1] : 'UTC';
  const f = (tzm ? tzm[2] : t).split(/\s+/);
  if (f.length !== 5) return base;
  const [mi, ho, dom, mon, dow] = f;
  let minute = num(mi);
  let hour = num(ho);
  if (Number.isNaN(minute) || Number.isNaN(hour) || mon !== '*') return base;
  let mode: Mode;
  let weekday = 0;
  let day = 1;
  if (dom === '*' && dow === '*') mode = 'daily';
  else if (dom === '*' && !Number.isNaN(num(dow)) && num(dow) <= 6) {
    mode = 'weekly';
    weekday = num(dow);
  } else if (dow === '*' && !Number.isNaN(num(dom))) {
    mode = 'monthly';
    day = num(dom);
  } else return base;

  let converted = false;
  if (tz === 'UTC') {
    hour += 9;
    converted = true;
    if (hour >= 24) {
      hour -= 24;
      weekday = (weekday + 1) % 7;
      day += 1;
    }
    if (mode === 'monthly' && day > 28) return base; // 월말 넘김은 정확히 표현 불가 → 직접 입력
  } else if (tz !== 'Asia/Seoul') return base;
  minute = Math.min(59, minute);
  return { mode, hour, minute, weekday, day, raw: t, convertedFromUtc: converted };
}

export function describeCron(raw: string): string {
  const s = fromCron(raw);
  const hm = `${String(s.hour).padStart(2, '0')}:${String(s.minute).padStart(2, '0')}`;
  if (s.mode === 'daily') return `매일 ${hm}`;
  if (s.mode === 'weekly') return `매주 ${WEEKDAYS[s.weekday]}요일 ${hm}`;
  if (s.mode === 'monthly') return `매월 ${s.day}일 ${hm}`;
  return raw;
}
