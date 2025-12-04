/**
 * Type definitions for the LLM chat application.
 */

export interface Env {
  /**
   * Binding for the Workers AI API.
   */
  AI: Ai;

  /**
   * Binding for static assets.
   */
  ASSETS: { fetch: (request: Request) => Promise<Response> };

  /**
   * Cloudflare Access team domain (issuer for JWTs), e.g. "https://your-team.cloudflareaccess.com".
   */
  TEAM_DOMAIN: string;

  /**
   * Expected audience for the Access policy protecting this Worker.
   */
  POLICY_AUD: string;
}

/**
 * Represents a chat message.
 */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}
