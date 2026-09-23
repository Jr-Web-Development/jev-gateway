import { afterEach, describe, expect, it, vi } from "vitest";

// @ts-ignore: bin/ is plain JavaScript outside the tsconfig include; resolved at runtime.
const providerModule = await import("../bin/omp-provider.mjs");
// The extension's default export is plain JS on a dynamic import: its shape is declared here once.
const registerJevGateway = providerModule.default as (pi: ExtensionHost) => void;
const ROUTED_PROVIDER = providerModule.ROUTED_PROVIDER as string;

interface ProviderConfig {
  baseUrl?: string;
  headers?: Record<string, string>;
}

interface ModelRef {
  provider: string;
  id: string;
}

interface SessionContext {
  hasUI?: boolean;
  ui?: { notify: (message: string, type?: string) => void };
  models?: {
    list?: () => ModelRef[];
    current?: () => ModelRef | undefined;
    resolve?: (selector: string) => unknown;
  };
}

interface ExtensionHost {
  registerProvider: (name: string, config: ProviderConfig) => void;
  on: (event: string, handler: (event: unknown, ctx: SessionContext) => unknown) => void;
  setModel?: (model: unknown) => Promise<void>;
}

const gateway = "http://127.0.0.1:8792/v1";

/** Install the extension the way OMP does, and start one session against `current`. */
async function bootSession(current: ModelRef, resolve = (): unknown => undefined, hasUI = true) {
  const registrations: Array<{ name: string; config: ProviderConfig }> = [];
  const notify = vi.fn();
  const setModel = vi.fn(async () => {});
  let sessionStart: ((event: unknown, ctx: SessionContext) => unknown) | undefined;

  registerJevGateway({
    registerProvider: (name, config) => registrations.push({ name, config }),
    setModel,
    on: (event, handler) => {
      if (event === "session_start") sessionStart = handler;
    },
  });
  expect(sessionStart).toBeDefined();

  await sessionStart!(
    {},
    {
      hasUI,
      ui: { notify },
      models: {
        list: () => [
          { provider: "opencode-go", id: "deepseek-v4.1-flash" },
          { provider: "openai-codex", id: "gpt-6-luna" },
        ],
        current: () => current,
        resolve,
      },
    },
  );
  return { registrations, setModel, notify };
}

afterEach(() => {
  delete process.env.JEV_OMP_GATEWAY_BASE_URL;
});

describe("jev-omp provider override", () => {
  it("points opencode-go at the gateway and registers nothing else", async () => {
    process.env.JEV_OMP_GATEWAY_BASE_URL = gateway;
    const { registrations } = await bootSession({ provider: ROUTED_PROVIDER, id: "deepseek-v4.1-flash" });

    // No headers: the gateway forwards every request to its own fixed upstream, so no request
    // carries a route, and the provider's own credentials stay in OMP's hands.
    expect(registrations).toEqual([{ name: ROUTED_PROVIDER, config: { baseUrl: gateway } }]);
  });

  it("re-binds the selected model so the session uses the gateway transport", async () => {
    process.env.JEV_OMP_GATEWAY_BASE_URL = gateway;
    const model = { provider: ROUTED_PROVIDER, id: "deepseek-v4.1-flash" };
    const routed = { provider: ROUTED_PROVIDER, id: "deepseek-v4.1-flash", baseUrl: gateway };
    const resolve = vi.fn(() => routed);
    const { setModel, notify } = await bootSession(model, resolve);

    expect(resolve).toHaveBeenCalledWith(`${ROUTED_PROVIDER}/deepseek-v4.1-flash`);
    expect(setModel).toHaveBeenCalledWith(routed);
    expect(notify).not.toHaveBeenCalled();
  });

  it("warns, without blocking, when the session runs another provider", async () => {
    process.env.JEV_OMP_GATEWAY_BASE_URL = gateway;
    const { registrations, setModel, notify } = await bootSession({ provider: "openai-codex", id: "gpt-6-luna" });

    // opencode-go is still registered (the provider may be selected later), but openai-codex is
    // never re-pointed and the running session keeps its direct transport — said out loud, because
    // a session that skips the gateway looks the same as one where Jev had nothing to decide.
    expect(registrations.map(({ name }) => name)).toEqual([ROUTED_PROVIDER]);
    expect(setModel).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining(`routes only the ${ROUTED_PROVIDER} provider`), "warning");
  });

  it("stays silent in a run with no UI to warn in", async () => {
    process.env.JEV_OMP_GATEWAY_BASE_URL = gateway;
    const { notify } = await bootSession({ provider: "openai-codex", id: "gpt-6-luna" }, () => undefined, false);

    expect(notify).not.toHaveBeenCalled();
  });

  it("normalizes a trailing slash on the configured gateway root", async () => {
    process.env.JEV_OMP_GATEWAY_BASE_URL = `${gateway}/`;
    const { registrations } = await bootSession({ provider: ROUTED_PROVIDER, id: "deepseek-v4.1-flash" });

    expect(registrations[0]?.config.baseUrl).toBe(gateway);
  });

  it("fails loudly when the launcher did not pass a gateway root", () => {
    expect(() => registerJevGateway({ registerProvider: () => {}, on: () => {} })).toThrow(
      /JEV_OMP_GATEWAY_BASE_URL/,
    );
  });
});
