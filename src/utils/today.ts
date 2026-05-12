/** Return today's local date as `YYYY-MM-DD`. */
export function today(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Return the current instant as an ISO 8601 string with millisecond precision. */
export function nowIso(): string {
  return new Date().toISOString();
}
