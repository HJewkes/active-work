/**
 * pino logger for the daemon.
 *
 * Logs to stderr (pretty when TTY, JSON otherwise) and additionally
 * appends a JSON record to `<state>/daemon.log`. Rotation is not yet
 * implemented; a future wave can layer pino-roll on top.
 */
import { mkdirSync, createWriteStream } from 'node:fs';
import path from 'node:path';
import pino, { type Logger, multistream, type StreamEntry } from 'pino';
import { getStateRoot } from '../utils/paths.js';

let cachedLogger: Logger | undefined;

function buildLogger(): Logger {
  const stateRoot = getStateRoot();
  mkdirSync(stateRoot, { recursive: true });
  const logPath = path.join(stateRoot, 'daemon.log');

  const fileStream = createWriteStream(logPath, { flags: 'a' });

  const stderrIsTTY = process.stderr.isTTY === true;
  const stderrStream: NodeJS.WritableStream = stderrIsTTY
    ? (pino.transport({
        target: 'pino-pretty',
        options: { destination: 2, colorize: true },
      }) as unknown as NodeJS.WritableStream)
    : process.stderr;

  const streams: StreamEntry[] = [
    { stream: stderrStream },
    { stream: fileStream },
  ];

  return pino({ level: process.env.AW_LOG_LEVEL ?? 'info' }, multistream(streams));
}

export function getLogger(): Logger {
  cachedLogger ??= buildLogger();
  return cachedLogger;
}

/** Reset the cached logger. Used by tests that need a clean instance. */
export function resetLogger(): void {
  cachedLogger = undefined;
}
