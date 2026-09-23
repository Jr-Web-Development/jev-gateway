import type { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { Config } from "../src/config.js";
import { fakeJev, fakeUpstream, testConfig, tools } from "./helpers.js";

/**
 * The gateway contract jev-omp depends on.
 *
 * jev-omp re-points exactly one OMP provider (`opencode-go`) at this gateway, and the gateway
 * keeps the contract every other launcher already relies on: one process, one fixed upstream.
 * Nothing in a request may select a different destination — not a header, not a route token —
 * and the opencode-go wires must all land on that same upstream root.
 */

/** Canonical upstream of OMP's `opencode-go` provider (OMP 18.2.11 provider catalog). */
const OPENCODE_GO = "https://opencode.ai/zen/go/v1";

const setup = (overrides: Partial<Config> = {}) => {
  const upstream = fakeUpstream();
  const jev = fakeJev({});
  const app = createApp({
    config: testConfig({ client: "omp", upstreamBaseUrl: OPENCODE_GO, ...overrides }),
    askJev: jev.askJev,
    fetch: upstream.fetchImpl,
  });
  return { app, upstream, jev };
};

const post = (app: Hono, path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

describe("fixed upstream", () => {
  it("reports its own upstream on /health", async () => {
    const { app } = setup();
    const body = (await (await app.request("/health")).json()) as Record<string, unknown>;

    expect(body.status).toBe("ok");
    expect(body.upstream).toBe(OPENCODE_GO);
  });

  it("sends every opencode-go wire to that one upstream root", async () => {
    const { app, upstream } = setup();

    await post(app, "/v1/chat/completions", { model: "deepseek-v4.1-flash", messages: [] });
    await post(app, "/v1/responses", { model: "muse-spark-1.3-contributor", input: [] });
    await post(app, "/v1/messages", { model: "union-alpha", messages: [] });

    expect(upstream.calls.map((call) => call.url)).toEqual([
      `${OPENCODE_GO}/chat/completions`,
      `${OPENCODE_GO}/responses`,
      `${OPENCODE_GO}/messages`,
    ]);
  });
});

describe("tool selection still applies to routed opencode-go traffic", () => {
  it("forces the tool Jev picks for a chat request that carries tools", async () => {
    const upstream = fakeUpstream();
    // `tool` picks among the offered tools; `needs_tool` decides whether one is called at all.
    const jev = fakeJev({ tool: { choice: "get_weather" }, needs_tool: { noul: 0.9 } });
    const app = createApp({
      config: testConfig({ client: "omp", upstreamBaseUrl: OPENCODE_GO, argsModel: "deepseek-v4.1-flash" }),
      askJev: jev.askJev,
      fetch: upstream.fetchImpl,
    });
    // Only the open-argument tool: a closed one would add argument questions of its own.
    const routedTools = tools.filter((tool) => tool.function?.name === "get_weather");
    expect(routedTools).toHaveLength(1);

    const response = await post(app, "/v1/chat/completions", {
      model: "deepseek-v4.1-flash",
      messages: [{ role: "user", content: "what is the weather in Lisbon?" }],
      tools: routedTools,
      tool_choice: "auto",
    });

    expect(response.headers.get("x-jev-gateway-mode")).toBe("forced");
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0]?.url).toBe(`${OPENCODE_GO}/chat/completions`);
    expect(upstream.calls[0]?.body).toMatchObject({
      model: "deepseek-v4.1-flash",
      tool_choice: { type: "function", function: { name: "get_weather" } },
    });
  });
});
