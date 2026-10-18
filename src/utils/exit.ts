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

/**
 * Resolves once every write queued on `stream` before this call has completed.
 * Writes complete in order, so an empty write's callback fires after them. An
 * error (EPIPE when the reader closed early, e.g. `| head`) means nothing more
 * can be delivered, so it resolves too instead of crashing on an unhandled
 * 'error' event.
 */
function flushed(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((resolve) => {
    stream.on('error', () => resolve());
    stream.write('', () => resolve());
  });
}
