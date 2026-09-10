/**
 * LLM Chat Application Template
 *
 * A simple chat application using Cloudflare Workers AI.
 * This template demonstrates how to implement an LLM-powered chat interface with
 * streaming responses using Server-Sent Events (SSE).
 *
 * Demo configuration: routes chat through AI Gateway dynamic route
 * oracle / dynamic/failover for provider failover testing.
 *
 * @license MIT
 */
import { Env, ChatMessage } from "./types";

// AI Gateway dynamic route for failover demo.
// Route: oracle/failover
// Primary: openai/gpt-4o, timeout 3000ms, retries 3
// Fallback: workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast
const GATEWAY_ID = "oracle";
const DYNAMIC_ROUTE = "dynamic/failover";

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
    // Parse JSON request body
    const { messages = [] } = (await request.json()) as {
      messages: ChatMessage[];
    };

    // Add system prompt if not present
    if (!messages.some((msg) => msg.role === "system")) {
      messages.unshift({ role: "system", content: SYSTEM_PROMPT });
    }

    const response = await env.AI.gateway(GATEWAY_ID).run({
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

    if (!response.ok || !response.body) {
      const body = await response.text();
      console.error("AI Gateway dynamic route failed:", response.status, body);
      return new Response(
        JSON.stringify({ error: "AI Gateway dynamic route failed", status: response.status, body }),
        {
          status: response.status || 502,
          headers: { "content-type": "application/json" },
        },
      );
    }

    // The frontend expects Workers AI-style JSON lines with a `response` field.
    // Dynamic routes use the OpenAI-compatible streaming format, so normalize it.
    return new Response(normalizeOpenAIStream(response.body), {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "x-ai-gateway-route": DYNAMIC_ROUTE,
        "x-ai-gateway-provider": response.headers.get("cf-aig-provider") || "",
        "x-ai-gateway-model": response.headers.get("cf-aig-model") || "",
      },
    });
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
 * Converts OpenAI-compatible SSE chunks into the JSON-line format the existing
 * frontend already consumes: { "response": "text" }\n
 */
function normalizeOpenAIStream(stream: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";

  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === "data: [DONE]") {
            continue;
          }

          if (!trimmed.startsWith("data:")) {
            continue;
          }

          try {
            const data = JSON.parse(trimmed.slice("data:".length).trim());
            const content = data.choices?.[0]?.delta?.content;
            if (content) {
              controller.enqueue(
                encoder.encode(`${JSON.stringify({ response: content })}\n`),
              );
            }
          } catch (error) {
            console.error("Error parsing AI Gateway stream chunk:", error);
          }
        }
      },
      flush(controller) {
        const trimmed = buffer.trim();
        if (trimmed.startsWith("data:") && trimmed !== "data: [DONE]") {
          try {
            const data = JSON.parse(trimmed.slice("data:".length).trim());
            const content = data.choices?.[0]?.delta?.content;
            if (content) {
              controller.enqueue(
                encoder.encode(`${JSON.stringify({ response: content })}\n`),
              );
            }
          } catch (error) {
            console.error("Error parsing final AI Gateway stream chunk:", error);
          }
        }
      },
    }),
  );
}
