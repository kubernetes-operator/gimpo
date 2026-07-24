/**
 * 사용자 입력에서 온 spec 오브젝트를 정리한다.
 * - undefined / null / 빈 문자열 / 빈 배열 / 빈 객체 필드를 제거.
 * - CRD 스키마가 빈 값에 민감할 수 있어 전송 전에 pruning 한다.
 * boolean/숫자 0/false 는 의미가 있으므로 보존한다.
 */
export function pruneEmpty<T>(value: T): T {
  if (Array.isArray(value)) {
    const arr = value.map((v) => pruneEmpty(v)).filter((v) => !isEmpty(v));
    return arr as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const cleaned = pruneEmpty(v);
      if (!isEmpty(cleaned)) out[k] = cleaned;
    }
    return out as unknown as T;
  }
  return value;
}

function isEmpty(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v as object).length === 0;
  return false;
}
