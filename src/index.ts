/**
 * LLM Chat Application Template
 *
 * A simple chat application using Cloudflare Workers AI.
 * This template demonstrates how to implement an LLM-powered chat interface with
 * streaming responses using Server-Sent Events (SSE).
 *
 * @license MIT
 */
import { Env, ChatMessage } from "./types";
import { jwtVerify, createRemoteJWKSet } from "jose";

// Model ID for Workers AI model
// https://developers.cloudflare.com/workers-ai/models/
const MODEL_ID = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

// Default system prompt
const SYSTEM_PROMPT =
  "You are a helpful, friendly assistant. Provide concise and accurate responses.";

export default {
  /**
   * Main request handler for the Worker
   */
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
      // Handle POST requests for chat
      if (request.method === "POST") {
        return handleChatRequest(request, env);
      }

      // Method not allowed for other request types
      return new Response("Method not allowed", { status: 405 });
    }

    // Handle 404 for unmatched routes
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

/**
 * Handles chat API requests
 */
async function handleChatRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  try {
    // Verify Cloudflare Access JWT before processing the chat request
    const authResponse = await verifyAccessJwt(request, env);
    if (authResponse) {
      return authResponse;
    }

    // Parse JSON request body
    const { messages = [] } = (await request.json()) as {
      messages: ChatMessage[];
    };

    // Add system prompt if not present
    if (!messages.some((msg) => msg.role === "system")) {
      messages.unshift({ role: "system", content: SYSTEM_PROMPT });
    }

    const response = await env.AI.run(
      MODEL_ID,
      {
        messages,
        max_tokens: 1024,
      },
      {
        returnRawResponse: true,
        // Uncomment to use AI Gateway
        gateway: {
          id: "oracle", // Replace with your AI Gateway ID
          skipCache: false,      // Set to true to bypass cache
          cacheTtl: 3600,        // Cache time-to-live in seconds
        },
      },
    );

    // Return streaming response
    return response;
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

/**
 * Verifies the Cloudflare Access JWT included in the request headers.
 * Returns a Response on failure, or undefined on success so the caller can proceed.
 */
async function verifyAccessJwt(
  request: Request,
  env: Env,
): Promise<Response | undefined> {
  if (!env.POLICY_AUD) {
    return new Response("Missing required audience", {
      status: 403,
      headers: { "Content-Type": "text/plain" },
    });
  }

  const token = request.headers.get("cf-access-jwt-assertion");

  if (!token) {
    return new Response("Missing required CF Access JWT", {
      status: 403,
      headers: { "Content-Type": "text/plain" },
    });
  }

  try {
    const JWKS = createRemoteJWKSet(
      new URL(`${env.TEAM_DOMAIN}/cdn-cgi/access/certs`),
    );

    await jwtVerify(token, JWKS, {
      issuer: env.TEAM_DOMAIN,
      audience: env.POLICY_AUD,
    });

    // Token is valid; allow caller to continue
    return undefined;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown verification error";
    return new Response(`Invalid token: ${message}`, {
      status: 403,
      headers: { "Content-Type": "text/plain" },
    });
  }
}

