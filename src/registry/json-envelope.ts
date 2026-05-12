export type JsonEnvelope<T> =
  | { ok: true; data: T; warnings?: string[] }
  | { ok: false; error: string; code: number };

export function successEnvelope<T>(
  data: T,
  warnings?: string[],
): JsonEnvelope<T> {
  if (warnings && warnings.length > 0) {
    return { ok: true, data, warnings };
  }
  return { ok: true, data };
}

export function errorEnvelope(error: string, code: number): JsonEnvelope<never> {
  return { ok: false, error, code };
}
