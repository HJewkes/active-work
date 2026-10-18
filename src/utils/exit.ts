/**
 * Exit with `code` once stdout and stderr have flushed.
 *
 * Node writes to a pipe asynchronously, and `process.exit` drops whatever the
 * reader hasn't drained yet: a multi-megabyte result piped into `jq` arrived
 * cut off at a 64 KiB boundary. We still exit explicitly rather than setting
 * `process.exitCode`, so an open handle (a watcher, a database) can't keep the
 * CLI alive after its result is written.
 */
export async function exitAfterFlush(code: number): Promise<never> {
  await Promise.all([flushed(process.stdout), flushed(process.stderr)]);
  process.exit(code);
}

/** Writes complete in order, so an empty write's callback fires after every earlier one. */
function flushed(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((resolve) => {
    stream.write('', () => resolve());
  });
}

/**
 * A reader that closed early (`| head`) wants no more output. Without a
 * listener the resulting EPIPE is an unhandled 'error' event, which prints a
 * stack trace and exits 1; stop quietly instead.
 */
export function exitQuietlyOnBrokenPipe(): void {
  for (const stream of [process.stdout, process.stderr]) {
    stream.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code !== 'EPIPE') throw err;
      process.exit(0);
    });
  }
}
