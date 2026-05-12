import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchArtifacts,
  fetchInitiatives,
  fetchTasks,
} from '../../src/dashboard/utils/api.js';

interface CapturedRequest {
  url: string;
  method: string;
  body: unknown;
}

function stubFetch(envelope: unknown): {
  captured: CapturedRequest[];
  restore: () => void;
} {
  const captured: CapturedRequest[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const bodyText =
      typeof init?.body === 'string' ? init.body : String(init?.body ?? 'null');
    captured.push({
      url,
      method: init?.method ?? 'GET',
      body: JSON.parse(bodyText),
    });
    return new Response(JSON.stringify(envelope), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return {
    captured,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fetchInitiatives', () => {
  it('POSTs an empty body to /rpc/list and returns data on success', async () => {
    const expected = { sections: [], parse_errors: [] };
    const { captured, restore } = stubFetch({ ok: true, data: expected });
    try {
      const result = await fetchInitiatives();
      expect(result).toEqual(expected);
      expect(captured).toHaveLength(1);
      expect(captured[0].url).toBe('/rpc/list');
      expect(captured[0].method).toBe('POST');
      expect(captured[0].body).toEqual({});
    } finally {
      restore();
    }
  });

  it('throws when the envelope reports failure', async () => {
    const { restore } = stubFetch({ ok: false, error: 'kaboom', code: 1 });
    try {
      await expect(fetchInitiatives()).rejects.toThrow(/kaboom/);
    } finally {
      restore();
    }
  });
});

describe('fetchTasks', () => {
  it('POSTs to /rpc/task.list with cross-initiative open filter', async () => {
    const expected = { tasks: [] };
    const { captured, restore } = stubFetch({ ok: true, data: expected });
    try {
      const result = await fetchTasks();
      expect(result).toEqual(expected);
      expect(captured[0].url).toBe('/rpc/task.list');
      expect(captured[0].method).toBe('POST');
      expect(captured[0].body).toEqual({
        all_initiatives: true,
        status: 'open',
      });
    } finally {
      restore();
    }
  });

  it('throws on error envelope', async () => {
    const { restore } = stubFetch({ ok: false, error: 'nope', code: 1 });
    try {
      await expect(fetchTasks()).rejects.toThrow(/nope/);
    } finally {
      restore();
    }
  });
});

describe('fetchArtifacts', () => {
  it('POSTs to /rpc/artifact.list with all_initiatives flag', async () => {
    const expected = { items: [] };
    const { captured, restore } = stubFetch({ ok: true, data: expected });
    try {
      const result = await fetchArtifacts();
      expect(result).toEqual(expected);
      expect(captured[0].url).toBe('/rpc/artifact.list');
      expect(captured[0].method).toBe('POST');
      expect(captured[0].body).toEqual({ all_initiatives: true });
    } finally {
      restore();
    }
  });

  it('throws on error envelope', async () => {
    const { restore } = stubFetch({ ok: false, error: 'oops', code: 2 });
    try {
      await expect(fetchArtifacts()).rejects.toThrow(/oops/);
    } finally {
      restore();
    }
  });
});
