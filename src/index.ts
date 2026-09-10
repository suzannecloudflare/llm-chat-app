/**
 * LLM Chat Application Template
 *
 * A simple chat application using Cloudflare Workers AI.
 * This template demonstrates how to implement an LLM-powered chat interface with
 * streaming responses using Server-Sent Events (SSE).
 *
 * Includes two failover strategies:
 * 1. Gateway-managed failover via a dynamic route (recommended)
 * 2. Client-side fallback between models (no dynamic route needed)
 *
 * @license MIT
 */
import { Env, ChatMessage } from "./types";

// --- Configuration -------------------------------------------------------

// When set, the Worker routes requests through an AI Gateway dynamic route
// (e.g. "dynamic/failover"). The failover logic is configured entirely on the
// gateway side. When not set, the Worker falls back to client-side fallback.
const DYNAMIC_ROUTE = "dynamic/failover";

// Primary model for client-side fallback (used when DYNAMIC_ROUTE is empty)
// https://developers.cloudflare.com/workers-ai/models/
const PRIMARY_MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8";

// Fallback model if the primary model fails (used when DYNAMIC_ROUTE is empty)
const FALLBACK_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

// AI Gateway ID. Set this to use AI Gateway features (caching, analytics,
// dynamic routing). Leave empty to call Workers AI directly.
const GATEWAY_ID = "oracle";

// Default system prompt
const SYSTEM_PROMPT =
  "You are a helpful, friendly assistant. Provide concise and accurate responses.";

// --- Worker entry point -------------------------------------------------

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    // Handle static assets (frontend)
    if (url.pathname === "/" || !url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    // API Routes
    if (url.pathname === "/api/chat") {
      if (request.method === "POST") {
        return handleChatRequest(request, env);
      }
      return new Response("Method not allowed", { status: 405 });
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

// --- Chat handler --------------------------------------------------------

async function handleChatRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  try {
    // Guard: AI binding is not available in Workers Previews (private beta)
    // unless explicitly configured via `wrangler preview base-config`.
    // See: https://developers.cloudflare.com/workers/ci-cd/builds/
    if (!env.AI) {
      console.error(
        "AI binding is not configured. " +
          "If running via Workers Previews, add the AI binding using: " +
          "`wrangler preview base-config set --ai-binding AI`",
      );
      return new Response(
        JSON.stringify({
          error:
            "AI binding not available in this environment. " +
            "Deploy to production or configure the AI binding for Workers Previews.",
        }),
        {
          status: 503,
          headers: { "content-type": "application/json" },
        },
      );
    }

    const { messages = [] } = (await request.json()) as {
      messages: ChatMessage[];
    };

    if (!messages.some((msg) => msg.role === "system")) {
      messages.unshift({ role: "system", content: SYSTEM_PROMPT });
    }

    if (DYNAMIC_ROUTE) {
      return handleWithDynamicRoute(env, messages);
    }
    return handleWithClientFallback(env, messages);
  } catch (error) {
    console.error("Error processing chat request:", error);
    return new Response(
      JSON.stringify({ error: "Failed to process request" }),
      {
        status: 500,
        headers: { "content-type": "application/json" },
      },
    );
  }
}

// --- Strategy 1: Gateway-managed failover (recommended) ------------------
//
// Uses an AI Gateway dynamic route. The failover chain (e.g. OpenAI → Workers AI)
// is configured in the dashboard or via the API — no retry logic in your app.
//
// See: https://developers.cloudflare.com/ai-gateway/features/dynamic-routing/usage/

async function handleWithDynamicRoute(
  env: Env,
  messages: ChatMessage[],
): Promise<Response> {
  const gateway = GATEWAY_ID || "default";
  const response = await env.AI.gateway(gateway).run({
    provider: "compat",
    endpoint: "chat/completions",
    headers: {},
    query: {
      model: DYNAMIC_ROUTE,
      messages,
      max_tokens: 1024,
      stream: true,
    },
  });

  return response;
}

// --- Strategy 2: Client-side fallback ------------------------------------
//
// Tries the primary model first. If it fails, falls back to a secondary model.
// Only works within Workers AI (single provider). For cross-provider failover
// use Strategy 1 with a dynamic route.

async function handleWithClientFallback(
  env: Env,
  messages: ChatMessage[],
): Promise<Response> {
  const inputs = {
    messages,
    max_tokens: 1024,
    stream: true,
  } satisfies AiTextGenerationInput & { stream: true };

  const gatewayOptions = GATEWAY_ID
    ? { gateway: { id: GATEWAY_ID, skipCache: false, cacheTtl: 3600 } }
    : {};

  try {
    const stream = await env.AI.run<typeof PRIMARY_MODEL>(
      PRIMARY_MODEL,
      inputs,
      gatewayOptions,
    );
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  } catch (primaryError) {
    console.error(
      `Primary model ${PRIMARY_MODEL} failed, falling back to ${FALLBACK_MODEL}:`,
      primaryError,
    );
    try {
      const fallbackStream = await env.AI.run<typeof FALLBACK_MODEL>(
        FALLBACK_MODEL,
        inputs,
        gatewayOptions,
      );
      return new Response(fallbackStream, {
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
        },
      });
    } catch (fallbackError) {
      console.error(
        `Fallback model ${FALLBACK_MODEL} also failed:`,
        fallbackError,
      );
      return new Response(JSON.stringify({ error: "All models failed" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    }
  }
}
