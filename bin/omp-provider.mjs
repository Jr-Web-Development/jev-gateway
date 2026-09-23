// Process-local OMP provider override used by jev-omp.
//
// OMP loads this file only for the process the launcher starts; no ~/.omp file is written or
// replaced, and the override disappears with the process. Exactly one provider is re-pointed at
// the local gateway:
//
//   opencode-go/*  ->  http://127.0.0.1:8792/v1  ->  https://opencode.ai/zen/go/v1
//
// The model inside opencode-go varies normally (deepseek-v4.1-flash, muse-spark-*, …); the
// upstream does not. Every other provider (openai-codex, google-antigravity, openrouter, …) keeps
// its own transport and never reaches this gateway.
//
// The gateway has one fixed upstream per process, so this extension sends no routing header and
// asks it to forward nowhere else.

/** The only OMP provider jev-omp routes; the gateway's upstream is fixed to match it. */
export const ROUTED_PROVIDER = "opencode-go";

/** Why a model never reaches the gateway, without the speaker's name: the launcher prefixes its own. */
export const NOT_ROUTED_LINE = `routes only the ${ROUTED_PROVIDER} provider; this model will use OMP directly.`;

// A default export, not a named one: OMP loads an extension file and calls the module's default
// export with its extension API. A named export alone would load as a no-op.
export default function registerJevGateway(pi) {
  const configured = process.env.JEV_OMP_GATEWAY_BASE_URL?.trim();
  if (!configured) throw new Error("jev-omp: JEV_OMP_GATEWAY_BASE_URL is required");
  const baseUrl = configured.replace(/\/+$/, "");

  pi.on("session_start", async (_event, ctx) => {
    // registerProvider() merges the fields it is given into the provider definition, so passing
    // only baseUrl leaves the provider's own api key, OAuth flow, headers, models, and compat
    // exactly as OMP configured them.
    pi.registerProvider(ROUTED_PROVIDER, { baseUrl });

    // The session selected its model before session_start. Re-resolve that exact provider/id so
    // the Agent holds the gateway-bound Model: setModel keeps the logical model and only
    // refreshes its transport metadata.
    const current = ctx.models?.current?.() ?? ctx.model;
    if (current?.provider !== ROUTED_PROVIDER) {
      // A session that quietly skips the gateway looks exactly like one where Jev had nothing to
      // decide. Print and subagent runs have no UI to say it in, and a notice must never be the
      // reason a session fails to start.
      if (ctx.hasUI) ctx.ui.notify(`jev-omp ${NOT_ROUTED_LINE}`, "warning");
      return;
    }
    const routed = ctx.models?.resolve?.(`${current.provider}/${current.id}`);
    if (routed) await pi.setModel(routed);
  });
}
