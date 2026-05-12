/**
 * Thin REST client over the daemon's `/rpc/<name>` endpoints.
 *
 * Each fetcher POSTs a JSON body matching the command's args schema and
 * parses the standard JsonEnvelope, returning `data` on success or
 * throwing an Error carrying the server-supplied message on failure.
 *
 * Same-origin: the daemon also serves the dashboard, so we use relative
 * paths and never need to think about CORS.
 */

import type {
  ArtifactsResult,
  InitiativesResult,
  JsonEnvelope,
  TasksResult,
} from '../types.js';

async function rpc<T>(name: string, body: unknown): Promise<T> {
  const res = await fetch(`/rpc/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });

  let envelope: JsonEnvelope<T>;
  try {
    envelope = (await res.json()) as JsonEnvelope<T>;
  } catch {
    throw new Error(`rpc ${name}: invalid JSON response (HTTP ${res.status})`);
  }

  if (!envelope.ok) {
    throw new Error(`rpc ${name}: ${envelope.error}`);
  }
  return envelope.data;
}

export function fetchInitiatives(): Promise<InitiativesResult> {
  return rpc<InitiativesResult>('list', {});
}

export function fetchTasks(): Promise<TasksResult> {
  return rpc<TasksResult>('task.list', {
    all_initiatives: true,
    status: 'open',
  });
}

export function fetchArtifacts(): Promise<ArtifactsResult> {
  return rpc<ArtifactsResult>('artifact.list', { all_initiatives: true });
}
