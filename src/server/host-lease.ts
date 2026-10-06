/**
 * The factory host lease (TP-1777): `$AGENT_CHAT_HOME/factory-host`, else
 * `~/.agent-chat/factory-host`, holds one hostname, surrounding whitespace
 * ignored. A daemon on any other host refuses to start. No file means no lease.
 * agent-chat's broker and `titan-factory serve` read the same file by the same
 * rule, so keep this in step with agent-chat's `src/host-lease.ts`.
 */
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function leasePath(): string {
  const home = process.env.AGENT_CHAT_HOME ?? path.join(os.homedir(), '.agent-chat');
  return path.join(home, 'factory-host');
}

/** What a missing lease file reads as; any other read failure is `{ error }`. */
export type LeaseRead = { text: string } | { absent: true } | { error: string };

export type LeaseVerdict = { ok: true } | { ok: false; message: string };

export interface LeaseSeams {
  read: (file: string) => LeaseRead;
  hostname: () => string;
}

/**
 * Case-insensitive, and only the first label counts, so `Mac`, `mac.local` and
 * `mac.example.com` are one host.
 */
export function normaliseHost(name: string): string {
  return name.trim().toLowerCase().split('.')[0] ?? '';
}

export function checkHostLease(lease: LeaseRead, hostname: string, file: string): LeaseVerdict {
  if ('absent' in lease) return { ok: true };
  if ('error' in lease) {
    return refuse(`factory host lease ${file} is unreadable (${lease.error}); refusing to start`);
  }
  const leased = lease.text.trim();
  if (leased === '') return refuse(`factory host lease ${file} is empty; refusing to start`);
  if (normaliseHost(leased) === normaliseHost(hostname)) return { ok: true };
  return refuse(
    `factory host lease ${file} names host "${leased}", but this host is "${hostname}"; refusing to start`,
  );
}

function refuse(message: string): LeaseVerdict {
  return { ok: false, message };
}

function readLeaseFile(file: string): LeaseRead {
  try {
    return { text: readFileSync(file, 'utf8') };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { absent: true };
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

const defaultSeams: LeaseSeams = { read: readLeaseFile, hostname: () => os.hostname() };

/** The refusal message when this host is off the lease, else undefined. */
export function hostLeaseRefusal(seams: Partial<LeaseSeams> = {}): string | undefined {
  const { read, hostname } = { ...defaultSeams, ...seams };
  const file = leasePath();
  const verdict = checkHostLease(read(file), hostname(), file);
  return verdict.ok ? undefined : verdict.message;
}
