import { describe, it, expect, vi } from 'vitest';
import { EventHub } from '../../src/server/events.js';

describe('EventHub', () => {
  it('delivers broadcasts to every subscriber', () => {
    const hub = new EventHub();
    const a = vi.fn();
    const b = vi.fn();
    hub.subscribe(a);
    hub.subscribe(b);

    const msg = { event: 'change', data: 'active-root' };
    hub.broadcast(msg);

    expect(a).toHaveBeenCalledWith(msg);
    expect(b).toHaveBeenCalledWith(msg);
    expect(hub.size).toBe(2);
  });

  it('stops delivering after unsubscribe', () => {
    const hub = new EventHub();
    const a = vi.fn();
    const unsub = hub.subscribe(a);
    unsub();
    hub.broadcast({ event: 'change', data: 'x' });
    expect(a).not.toHaveBeenCalled();
    expect(hub.size).toBe(0);
  });

  it('drops a subscriber that throws and keeps serving the rest', () => {
    const hub = new EventHub();
    const bad = vi.fn(() => {
      throw new Error('dead socket');
    });
    const good = vi.fn();
    hub.subscribe(bad);
    hub.subscribe(good);

    hub.broadcast({ event: 'change', data: 'x' });
    expect(good).toHaveBeenCalledOnce();
    expect(hub.size).toBe(1); // bad was evicted

    hub.broadcast({ event: 'change', data: 'y' });
    expect(good).toHaveBeenCalledTimes(2);
    expect(bad).toHaveBeenCalledOnce(); // never called again
  });

  it('drops a subscriber whose async send rejects', async () => {
    const hub = new EventHub();
    const bad = vi.fn(() => Promise.reject(new Error('write failed')));
    hub.subscribe(bad);
    hub.broadcast({ event: 'change', data: 'x' });
    await Promise.resolve();
    expect(hub.size).toBe(0);
  });
});
