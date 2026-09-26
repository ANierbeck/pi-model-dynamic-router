import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('isOllamaAvailable (Ollama daemon reachability probe)', () => {
  beforeEach(() => {
    // The probe keeps a module-level negative cache (lastProbeDownAt) that
    // must not leak between tests — load a FRESH module per test, after the
    // fetch global has been stubbed.
    vi.resetModules();
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const loadProbe = () =>
    import('../src/ollama-utils.ts').then((m) => m.isOllamaAvailable);

  it('returns false when fetch rejects (ECONNREFUSED)', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('ECONNREFUSED'));
    const probe = await loadProbe();

    expect(await probe()).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('returns true when fetch responds with ok', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true } as Response);
    const probe = await loadProbe();

    expect(await probe()).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('returns false when fetch responds with non-ok status', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 500 } as Response);
    const probe = await loadProbe();

    expect(await probe()).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('returns false when the timeout signal aborts a hanging request', async () => {
    // Real timers here: AbortSignal.timeout uses native timers that vitest
    // fake timers cannot advance. The fetch mock never settles on its own
    // and rejects exactly when the probe's abort signal fires.
    vi.useRealTimers();
    vi.mocked(fetch).mockImplementation(
      (_url: any, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        })
    );
    const probe = await loadProbe();

    expect(await probe(50)).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('caches a "down" result and skips fetches within the TTL window', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('ECONNREFUSED'));
    const probe = await loadProbe();

    expect(await probe()).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(14_000); // still within the 15s TTL
    expect(await probe()).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1); // cached — no second fetch
  });

  it('re-probes once the negative TTL has expired', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('ECONNREFUSED'));
    const probe = await loadProbe();

    expect(await probe()).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(16_000); // past the TTL
    expect(await probe()).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(2); // re-probe happened
  });

  it('keeps an "up" result un-cached (a healthy daemon is probed each call)', async () => {
    // Only "down" results are cached — positive probes are cheap and must
    // not mask a daemon that goes down between two classifications.
    vi.mocked(fetch).mockResolvedValue({ ok: true } as Response);
    const probe = await loadProbe();

    expect(await probe()).toBe(true);
    vi.advanceTimersByTime(20_000);
    expect(await probe()).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
