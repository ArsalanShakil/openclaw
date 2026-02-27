import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveFetch } from "../infra/fetch.js";
import {
  createIPv4PreferredLookup,
  resetTelegramFetchStateForTests,
  resolveTelegramFetch,
} from "./fetch.js";

const setDefaultAutoSelectFamily = vi.hoisted(() => vi.fn());
const setDefaultResultOrder = vi.hoisted(() => vi.fn());
const setGlobalDispatcher = vi.hoisted(() => vi.fn());
const AgentCtor = vi.hoisted(() =>
  vi.fn(function MockAgent(this: { options: unknown }, options: unknown) {
    this.options = options;
  }),
);

vi.mock("node:net", async () => {
  const actual = await vi.importActual<typeof import("node:net")>("node:net");
  return {
    ...actual,
    setDefaultAutoSelectFamily,
  };
});

vi.mock("node:dns", async () => {
  const actual = await vi.importActual<typeof import("node:dns")>("node:dns");
  return {
    ...actual,
    setDefaultResultOrder,
  };
});

vi.mock("undici", () => ({
  Agent: AgentCtor,
  setGlobalDispatcher,
}));

const originalFetch = globalThis.fetch;

afterEach(() => {
  resetTelegramFetchStateForTests();
  setDefaultAutoSelectFamily.mockReset();
  setDefaultResultOrder.mockReset();
  setGlobalDispatcher.mockReset();
  AgentCtor.mockClear();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  if (originalFetch) {
    globalThis.fetch = originalFetch;
  } else {
    delete (globalThis as { fetch?: typeof fetch }).fetch;
  }
});

describe("resolveTelegramFetch", () => {
  it("returns wrapped global fetch when available", async () => {
    const fetchMock = vi.fn(async () => ({}));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const resolved = resolveTelegramFetch();

    expect(resolved).toBeTypeOf("function");
    expect(resolved).not.toBe(fetchMock);
  });

  it("wraps proxy fetches and normalizes foreign signals once", async () => {
    let seenSignal: AbortSignal | undefined;
    const proxyFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seenSignal = init?.signal as AbortSignal | undefined;
      return {} as Response;
    });

    const resolved = resolveTelegramFetch(proxyFetch as unknown as typeof fetch);
    expect(resolved).toBeTypeOf("function");

    let abortHandler: (() => void) | null = null;
    const addEventListener = vi.fn((event: string, handler: () => void) => {
      if (event === "abort") {
        abortHandler = handler;
      }
    });
    const removeEventListener = vi.fn((event: string, handler: () => void) => {
      if (event === "abort" && abortHandler === handler) {
        abortHandler = null;
      }
    });
    const fakeSignal = {
      aborted: false,
      addEventListener,
      removeEventListener,
    } as unknown as AbortSignal;

    if (!resolved) {
      throw new Error("expected resolved proxy fetch");
    }
    await resolved("https://example.com", { signal: fakeSignal });

    expect(proxyFetch).toHaveBeenCalledOnce();
    expect(seenSignal).toBeInstanceOf(AbortSignal);
    expect(seenSignal).not.toBe(fakeSignal);
    expect(addEventListener).toHaveBeenCalledTimes(1);
    expect(removeEventListener).toHaveBeenCalledTimes(1);
  });

  it("does not double-wrap an already wrapped proxy fetch", async () => {
    const proxyFetch = vi.fn(async () => ({ ok: true }) as Response) as unknown as typeof fetch;
    const alreadyWrapped = resolveFetch(proxyFetch);

    const resolved = resolveTelegramFetch(alreadyWrapped);

    expect(resolved).toBe(alreadyWrapped);
  });

  it("honors env enable override", async () => {
    vi.stubEnv("OPENCLAW_TELEGRAM_ENABLE_AUTO_SELECT_FAMILY", "1");
    globalThis.fetch = vi.fn(async () => ({})) as unknown as typeof fetch;
    resolveTelegramFetch();
    expect(setDefaultAutoSelectFamily).toHaveBeenCalledWith(true);
  });

  it("uses config override when provided", async () => {
    globalThis.fetch = vi.fn(async () => ({})) as unknown as typeof fetch;
    resolveTelegramFetch(undefined, { network: { autoSelectFamily: true } });
    expect(setDefaultAutoSelectFamily).toHaveBeenCalledWith(true);
  });

  it("env disable override wins over config", async () => {
    vi.stubEnv("OPENCLAW_TELEGRAM_ENABLE_AUTO_SELECT_FAMILY", "0");
    vi.stubEnv("OPENCLAW_TELEGRAM_DISABLE_AUTO_SELECT_FAMILY", "1");
    globalThis.fetch = vi.fn(async () => ({})) as unknown as typeof fetch;
    resolveTelegramFetch(undefined, { network: { autoSelectFamily: true } });
    expect(setDefaultAutoSelectFamily).toHaveBeenCalledWith(false);
  });

  it("applies dns result order from config", async () => {
    globalThis.fetch = vi.fn(async () => ({})) as unknown as typeof fetch;
    resolveTelegramFetch(undefined, { network: { dnsResultOrder: "verbatim" } });
    expect(setDefaultResultOrder).toHaveBeenCalledWith("verbatim");
  });

  it("retries dns setter on next call when previous attempt threw", async () => {
    setDefaultResultOrder.mockImplementationOnce(() => {
      throw new Error("dns setter failed once");
    });
    globalThis.fetch = vi.fn(async () => ({})) as unknown as typeof fetch;

    resolveTelegramFetch(undefined, { network: { dnsResultOrder: "ipv4first" } });
    resolveTelegramFetch(undefined, { network: { dnsResultOrder: "ipv4first" } });

    expect(setDefaultResultOrder).toHaveBeenCalledTimes(2);
  });

  it("replaces global undici dispatcher with autoSelectFamily-enabled agent", async () => {
    globalThis.fetch = vi.fn(async () => ({})) as unknown as typeof fetch;
    resolveTelegramFetch(undefined, { network: { autoSelectFamily: true } });

    expect(setGlobalDispatcher).toHaveBeenCalledTimes(1);
    const agentOpts = AgentCtor.mock.calls[0]?.[0] as { connect: Record<string, unknown> };
    expect(agentOpts.connect.autoSelectFamily).toBe(true);
    expect(agentOpts.connect.autoSelectFamilyAttemptTimeout).toBe(300);
  });

  it("sets global dispatcher only once across repeated equal decisions", async () => {
    globalThis.fetch = vi.fn(async () => ({})) as unknown as typeof fetch;
    resolveTelegramFetch(undefined, { network: { autoSelectFamily: true } });
    resolveTelegramFetch(undefined, { network: { autoSelectFamily: true } });

    expect(setGlobalDispatcher).toHaveBeenCalledTimes(1);
  });

  it("updates global dispatcher when autoSelectFamily decision changes", async () => {
    globalThis.fetch = vi.fn(async () => ({})) as unknown as typeof fetch;
    resolveTelegramFetch(undefined, { network: { autoSelectFamily: true } });
    resolveTelegramFetch(undefined, { network: { autoSelectFamily: false } });

    expect(setGlobalDispatcher).toHaveBeenCalledTimes(2);
    const firstOpts = AgentCtor.mock.calls[0]?.[0] as { connect: Record<string, unknown> };
    expect(firstOpts.connect.autoSelectFamily).toBe(true);
    const secondOpts = AgentCtor.mock.calls[1]?.[0] as { connect: Record<string, unknown> };
    expect(secondOpts.connect.autoSelectFamily).toBe(false);
  });

  it("includes ipv4-preferred lookup in dispatcher when dnsResultOrder is ipv4first", async () => {
    globalThis.fetch = vi.fn(async () => ({})) as unknown as typeof fetch;
    resolveTelegramFetch(undefined, {
      network: { autoSelectFamily: true, dnsResultOrder: "ipv4first" },
    });

    expect(setGlobalDispatcher).toHaveBeenCalledTimes(1);
    const agentOpts = AgentCtor.mock.calls[0]?.[0] as { connect: Record<string, unknown> };
    expect(agentOpts.connect.autoSelectFamily).toBe(true);
    expect(agentOpts.connect.lookup).toBeTypeOf("function");
  });

  it("omits custom lookup when dnsResultOrder is verbatim", async () => {
    globalThis.fetch = vi.fn(async () => ({})) as unknown as typeof fetch;
    resolveTelegramFetch(undefined, {
      network: { autoSelectFamily: true, dnsResultOrder: "verbatim" },
    });

    expect(setGlobalDispatcher).toHaveBeenCalledTimes(1);
    const agentOpts = AgentCtor.mock.calls[0]?.[0] as { connect: Record<string, unknown> };
    expect(agentOpts.connect.lookup).toBeUndefined();
  });

  it("updates dispatcher when dns decision changes from verbatim to ipv4first", async () => {
    globalThis.fetch = vi.fn(async () => ({})) as unknown as typeof fetch;
    resolveTelegramFetch(undefined, {
      network: { autoSelectFamily: true, dnsResultOrder: "verbatim" },
    });
    resolveTelegramFetch(undefined, {
      network: { autoSelectFamily: true, dnsResultOrder: "ipv4first" },
    });

    expect(setGlobalDispatcher).toHaveBeenCalledTimes(2);
    const secondOpts = AgentCtor.mock.calls[1]?.[0] as { connect: Record<string, unknown> };
    expect(secondOpts.connect.lookup).toBeTypeOf("function");
  });

  it("sets dispatcher with lookup when only dnsResultOrder is ipv4first (no explicit autoSelectFamily)", async () => {
    globalThis.fetch = vi.fn(async () => ({})) as unknown as typeof fetch;
    resolveTelegramFetch(undefined, { network: { dnsResultOrder: "ipv4first" } });

    expect(setGlobalDispatcher).toHaveBeenCalledTimes(1);
    const agentOpts = AgentCtor.mock.calls[0]?.[0] as { connect: Record<string, unknown> };
    expect(agentOpts.connect.lookup).toBeTypeOf("function");
  });
});

describe("createIPv4PreferredLookup", () => {
  it("returns IPv4 address from dns.resolve4 when OS resolver fails for single lookup", async () => {
    const dnsModule = await import("node:dns");
    const resolve4 = vi.spyOn(dnsModule, "resolve4");
    const lookupSpy = vi.spyOn(dnsModule, "lookup");
    resolve4.mockImplementation(((
      _hostname: string,
      callback: (err: NodeJS.ErrnoException | null, addresses: string[]) => void,
    ) => {
      callback(null, ["1.2.3.4", "5.6.7.8"]);
    }) as typeof dnsModule.resolve4);
    // OS resolver fails — c-ares result should be used
    lookupSpy.mockImplementation(((
      _hostname: string,
      _options: unknown,
      callback: (err: NodeJS.ErrnoException | null, address: string, family: number) => void,
    ) => {
      callback(new Error("ENODATA") as NodeJS.ErrnoException, "", 0);
    }) as typeof dnsModule.lookup);

    const lookup = createIPv4PreferredLookup();
    const result = await new Promise<{ address: string; family: number }>((resolve, reject) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (lookup as any)(
        "api.telegram.org",
        { all: false },
        (err: Error | null, address: string, family: number) => {
          if (err) {
            return reject(err);
          }
          resolve({ address, family });
        },
      );
    });

    expect(result.address).toBe("1.2.3.4");
    expect(result.family).toBe(4);
    resolve4.mockRestore();
    lookupSpy.mockRestore();
  });

  it("prefers OS resolver IPv4 over c-ares for single lookup (honors /etc/hosts)", async () => {
    const dnsModule = await import("node:dns");
    const resolve4 = vi.spyOn(dnsModule, "resolve4");
    const lookupSpy = vi.spyOn(dnsModule, "lookup");

    // c-ares returns public DNS answer
    resolve4.mockImplementation(((
      _hostname: string,
      callback: (err: NodeJS.ErrnoException | null, addresses: string[]) => void,
    ) => {
      callback(null, ["1.2.3.4"]);
    }) as typeof dnsModule.resolve4);
    // OS resolver returns a different IPv4 (e.g. /etc/hosts override)
    lookupSpy.mockImplementation(((
      _hostname: string,
      _options: unknown,
      callback: (err: NodeJS.ErrnoException | null, address: string, family: number) => void,
    ) => {
      callback(null, "10.0.0.1", 4);
    }) as typeof dnsModule.lookup);

    const lookup = createIPv4PreferredLookup();
    const result = await new Promise<{ address: string; family: number }>((resolve, reject) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (lookup as any)(
        "api.telegram.org",
        { all: false },
        (err: Error | null, address: string, family: number) => {
          if (err) {
            return reject(err);
          }
          resolve({ address, family });
        },
      );
    });

    // OS resolver (dns.lookup) should be preferred — it honors /etc/hosts
    expect(result.address).toBe("10.0.0.1");
    expect(result.family).toBe(4);
    resolve4.mockRestore();
    lookupSpy.mockRestore();
  });

  it("returns IPv4-first with IPv6 candidates preserved when all: true", async () => {
    const dnsModule = await import("node:dns");
    const resolve4 = vi.spyOn(dnsModule, "resolve4");
    const resolve6 = vi.spyOn(dnsModule, "resolve6");
    resolve4.mockImplementation(((
      _hostname: string,
      callback: (err: NodeJS.ErrnoException | null, addresses: string[]) => void,
    ) => {
      callback(null, ["1.2.3.4", "5.6.7.8"]);
    }) as typeof dnsModule.resolve4);
    resolve6.mockImplementation(((
      _hostname: string,
      callback: (err: NodeJS.ErrnoException | null, addresses: string[]) => void,
    ) => {
      callback(null, ["::1", "::2"]);
    }) as typeof dnsModule.resolve6);

    const lookup = createIPv4PreferredLookup();
    const result = await new Promise<Array<{ address: string; family: number }>>(
      (resolve, reject) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (lookup as any)(
          "api.telegram.org",
          { all: true },
          (err: Error | null, addresses: Array<{ address: string; family: number }>) => {
            if (err) {
              return reject(err);
            }
            resolve(addresses);
          },
        );
      },
    );

    expect(result).toEqual([
      { address: "1.2.3.4", family: 4 },
      { address: "5.6.7.8", family: 4 },
      { address: "::1", family: 6 },
      { address: "::2", family: 6 },
    ]);
    resolve4.mockRestore();
    resolve6.mockRestore();
  });

  it("returns only IPv6 when all: true and resolve4 fails (IPv6-only network)", async () => {
    const dnsModule = await import("node:dns");
    const resolve4 = vi.spyOn(dnsModule, "resolve4");
    const resolve6 = vi.spyOn(dnsModule, "resolve6");
    resolve4.mockImplementation(((
      _hostname: string,
      callback: (err: NodeJS.ErrnoException | null, addresses: string[]) => void,
    ) => {
      callback(new Error("ENODATA") as NodeJS.ErrnoException, []);
    }) as typeof dnsModule.resolve4);
    resolve6.mockImplementation(((
      _hostname: string,
      callback: (err: NodeJS.ErrnoException | null, addresses: string[]) => void,
    ) => {
      callback(null, ["2001:db8::1"]);
    }) as typeof dnsModule.resolve6);

    const lookup = createIPv4PreferredLookup();
    const result = await new Promise<Array<{ address: string; family: number }>>(
      (resolve, reject) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (lookup as any)(
          "ipv6only.example.com",
          { all: true },
          (err: Error | null, addresses: Array<{ address: string; family: number }>) => {
            if (err) {
              return reject(err);
            }
            resolve(addresses);
          },
        );
      },
    );

    expect(result).toEqual([{ address: "2001:db8::1", family: 6 }]);
    resolve4.mockRestore();
    resolve6.mockRestore();
  });

  it("does not block on slow AAAA when IPv4 resolves first (grace timer)", async () => {
    vi.useFakeTimers();
    const dnsModule = await import("node:dns");
    const resolve4 = vi.spyOn(dnsModule, "resolve4");
    const resolve6 = vi.spyOn(dnsModule, "resolve6");

    // resolve4 returns immediately
    resolve4.mockImplementation(((
      _hostname: string,
      callback: (err: NodeJS.ErrnoException | null, addresses: string[]) => void,
    ) => {
      callback(null, ["1.2.3.4"]);
    }) as typeof dnsModule.resolve4);

    // resolve6 never calls back (simulates dropped AAAA query)
    resolve6.mockImplementation((() => {}) as unknown as typeof dnsModule.resolve6);

    const lookup = createIPv4PreferredLookup();
    let result: Array<{ address: string; family: number }> | undefined;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (lookup as any)(
      "api.telegram.org",
      { all: true },
      (_err: Error | null, addresses: Array<{ address: string; family: number }>) => {
        result = addresses;
      },
    );

    // Before grace timer fires, result should not be set
    expect(result).toBeUndefined();

    // Advance past the 50ms grace timer
    await vi.advanceTimersByTimeAsync(60);

    expect(result).toEqual([{ address: "1.2.3.4", family: 4 }]);

    resolve4.mockRestore();
    resolve6.mockRestore();
    vi.useRealTimers();
  });

  it("waits for resolve4 when resolve6 returns first (does not emit IPv6-only)", async () => {
    vi.useFakeTimers();
    const dnsModule = await import("node:dns");
    const resolve4 = vi.spyOn(dnsModule, "resolve4");
    const resolve6 = vi.spyOn(dnsModule, "resolve6");

    // resolve6 returns immediately with IPv6 addresses
    resolve6.mockImplementation(((
      _hostname: string,
      callback: (err: NodeJS.ErrnoException | null, addresses: string[]) => void,
    ) => {
      callback(null, ["2001:db8::1"]);
    }) as typeof dnsModule.resolve6);

    // resolve4 is slow — returns after 100ms (beyond the 50ms grace window)
    let resolve4Callback:
      | ((err: NodeJS.ErrnoException | null, addresses: string[]) => void)
      | null = null;
    resolve4.mockImplementation(((
      _hostname: string,
      callback: (err: NodeJS.ErrnoException | null, addresses: string[]) => void,
    ) => {
      resolve4Callback = callback;
    }) as typeof dnsModule.resolve4);

    const lookup = createIPv4PreferredLookup();
    let result: Array<{ address: string; family: number }> | undefined;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (lookup as any)(
      "api.telegram.org",
      { all: true },
      (_err: Error | null, addresses: Array<{ address: string; family: number }>) => {
        result = addresses;
      },
    );

    // resolve6 returned immediately but resolve4 hasn't yet — no grace timer should fire
    // because the timer only starts when IPv4 resolves first.
    expect(result).toBeUndefined();

    // Advance well past the 50ms grace window — still should not emit
    await vi.advanceTimersByTimeAsync(100);
    expect(result).toBeUndefined();

    // Now resolve4 returns — both queries done, should emit with IPv4 + IPv6
    resolve4Callback!(null, ["1.2.3.4"]);

    expect(result).toEqual([
      { address: "1.2.3.4", family: 4 },
      { address: "2001:db8::1", family: 6 },
    ]);

    resolve4.mockRestore();
    resolve6.mockRestore();
    vi.useRealTimers();
  });

  it("falls back to dns.lookup when both resolve4 and resolve6 fail with all: true", async () => {
    const dnsModule = await import("node:dns");
    const resolve4 = vi.spyOn(dnsModule, "resolve4");
    const resolve6 = vi.spyOn(dnsModule, "resolve6");
    const lookupSpy = vi.spyOn(dnsModule, "lookup");

    resolve4.mockImplementation(((
      _hostname: string,
      callback: (err: NodeJS.ErrnoException | null, addresses: string[]) => void,
    ) => {
      callback(new Error("ENODATA") as NodeJS.ErrnoException, []);
    }) as typeof dnsModule.resolve4);
    resolve6.mockImplementation(((
      _hostname: string,
      callback: (err: NodeJS.ErrnoException | null, addresses: string[]) => void,
    ) => {
      callback(new Error("ENODATA") as NodeJS.ErrnoException, []);
    }) as typeof dnsModule.resolve6);
    lookupSpy.mockImplementation(((
      _hostname: string,
      _options: unknown,
      callback: (err: NodeJS.ErrnoException | null, address: string, family: number) => void,
    ) => {
      callback(null, "10.0.0.1", 4);
    }) as typeof dnsModule.lookup);

    const lookup = createIPv4PreferredLookup();
    await new Promise<void>((resolve) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (lookup as any)("raw-ip.local", { all: true }, () => {
        resolve();
      });
    });

    expect(lookupSpy).toHaveBeenCalled();
    resolve4.mockRestore();
    resolve6.mockRestore();
    lookupSpy.mockRestore();
  });

  it("falls back to dns.lookup when dns.resolve4 fails", async () => {
    const dnsModule = await import("node:dns");
    const resolve4 = vi.spyOn(dnsModule, "resolve4");
    const lookupSpy = vi.spyOn(dnsModule, "lookup");

    resolve4.mockImplementation(((
      _hostname: string,
      callback: (err: NodeJS.ErrnoException | null, addresses: string[]) => void,
    ) => {
      callback(new Error("ENODATA") as NodeJS.ErrnoException, []);
    }) as typeof dnsModule.resolve4);
    lookupSpy.mockImplementation(((
      _hostname: string,
      _options: unknown,
      callback: (err: NodeJS.ErrnoException | null, address: string, family: number) => void,
    ) => {
      callback(null, "::1", 6);
    }) as typeof dnsModule.lookup);

    const lookup = createIPv4PreferredLookup();
    const result = await new Promise<{ address: string; family: number }>((resolve, reject) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (lookup as any)(
        "localhost",
        { all: false },
        (err: Error | null, address: string, family: number) => {
          if (err) {
            return reject(err);
          }
          resolve({ address, family });
        },
      );
    });

    expect(result.address).toBe("::1");
    expect(result.family).toBe(6);
    expect(lookupSpy).toHaveBeenCalled();
    resolve4.mockRestore();
    lookupSpy.mockRestore();
  });

  it("falls back to dns.lookup when dns.resolve4 returns empty", async () => {
    const dnsModule = await import("node:dns");
    const resolve4 = vi.spyOn(dnsModule, "resolve4");
    const lookupSpy = vi.spyOn(dnsModule, "lookup");

    resolve4.mockImplementation(((
      _hostname: string,
      callback: (err: NodeJS.ErrnoException | null, addresses: string[]) => void,
    ) => {
      callback(null, []);
    }) as typeof dnsModule.resolve4);
    lookupSpy.mockImplementation(((
      _hostname: string,
      _options: unknown,
      callback: (err: NodeJS.ErrnoException | null, address: string, family: number) => void,
    ) => {
      callback(null, "10.0.0.1", 4);
    }) as typeof dnsModule.lookup);

    const lookup = createIPv4PreferredLookup();
    const result = await new Promise<{ address: string; family: number }>((resolve, reject) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (lookup as any)(
        "example.com",
        { all: false },
        (err: Error | null, address: string, family: number) => {
          if (err) {
            return reject(err);
          }
          resolve({ address, family });
        },
      );
    });

    expect(result.address).toBe("10.0.0.1");
    expect(lookupSpy).toHaveBeenCalled();
    resolve4.mockRestore();
    lookupSpy.mockRestore();
  });
});
