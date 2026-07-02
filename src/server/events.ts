/**
 * Event hub: fan-out of daemon-side events to connected dashboard clients
 * over Server-Sent Events.
 *
 * The hub is transport-agnostic — a subscriber is just an async `send`
 * function. `http.ts` wires each SSE connection's `writeSSE` in as a
 * subscriber; `daemon.ts` feeds `broadcast` from the filesystem watcher.
 */

export interface SseMessage {
  event: string;
  data: string;
}

export type Subscriber = (message: SseMessage) => void | Promise<void>;

export class EventHub {
  private readonly subscribers = new Set<Subscriber>();

  /** Register a subscriber; returns an unsubscribe function. */
  subscribe(send: Subscriber): () => void {
    this.subscribers.add(send);
    return () => {
      this.subscribers.delete(send);
    };
  }

  /** Number of currently-connected clients (exposed for /health + tests). */
  get size(): number {
    return this.subscribers.size;
  }

  /**
   * Push a message to every subscriber. A slow or broken subscriber never
   * blocks the others and never throws out of `broadcast`; failures drop that
   * subscriber so a dead connection can't wedge future broadcasts.
   */
  broadcast(message: SseMessage): void {
    for (const send of this.subscribers) {
      try {
        const result = send(message);
        if (result && typeof result.then === 'function') {
          result.catch(() => this.subscribers.delete(send));
        }
      } catch {
        this.subscribers.delete(send);
      }
    }
  }
}
