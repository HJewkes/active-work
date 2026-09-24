/**
 * Reader priority over the daemon's refresh pass (TP-343).
 *
 * A `context.related` request and the pass share one JavaScript thread. The
 * pass awaits `idle` between its chunks, so it does not resume while a reader
 * is in flight, and a request waits for at most the chunk already running. In
 * the CLI nothing ever enters, so `idle` resolves at once.
 */
export interface ReaderGate {
  /** Marks a reader in flight; call the returned function once it is done. */
  enter(): () => void;
  /** Resolves once no reader is in flight, or after `maxWaitMs` so readers cannot starve the pass. */
  idle(maxWaitMs: number): Promise<void>;
}

export function createReaderGate(): ReaderGate {
  let readers = 0;
  const waiters = new Set<() => void>();

  // A macrotask, not a microtask, so the released reader's reply is sent before the pass resumes.
  const wakeAll = (): void => {
    setImmediate(() => {
      if (readers === 0) for (const wake of [...waiters]) wake();
    });
  };

  return {
    enter() {
      readers += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        readers -= 1;
        if (readers === 0) wakeAll();
      };
    },
    idle(maxWaitMs) {
      if (readers === 0) return Promise.resolve();
      return new Promise((resolve) => {
        const wake = (): void => {
          clearTimeout(timer);
          waiters.delete(wake);
          resolve();
        };
        const timer = setTimeout(wake, maxWaitMs);
        waiters.add(wake);
      });
    },
  };
}

/** The daemon's one gate: related requests enter it, the watcher's pass waits on it. */
export const readerGate = createReaderGate();
