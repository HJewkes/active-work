/**
 * Live-reload client: a thin wrapper over the daemon's `/events` SSE stream.
 *
 * The browser's native `EventSource` reconnects automatically, so we only
 * translate its lifecycle into two callbacks: `onChange` (a file under the
 * active root changed — refetch) and `onStatus` (connection state, for a UI
 * indicator). One connection is shared across the whole dashboard.
 */

export type LiveStatus = 'connecting' | 'open' | 'closed';

export interface LiveHandlers {
  onChange: () => void;
  onStatus?: (status: LiveStatus) => void;
}

/**
 * Open a live-reload connection. Returns a teardown function that closes the
 * underlying `EventSource`. Safe to call in environments without EventSource
 * (returns a no-op teardown and reports `closed`).
 */
export function subscribeLive(handlers: LiveHandlers): () => void {
  if (typeof EventSource === 'undefined') {
    handlers.onStatus?.('closed');
    return () => {};
  }

  handlers.onStatus?.('connecting');
  const source = new EventSource('/events');

  source.addEventListener('open', () => handlers.onStatus?.('open'));
  source.addEventListener('change', () => handlers.onChange());
  source.addEventListener('error', () => {
    // EventSource retries on its own; surface the interim state.
    handlers.onStatus?.(source.readyState === source.OPEN ? 'open' : 'connecting');
  });

  return () => {
    source.close();
    handlers.onStatus?.('closed');
  };
}
