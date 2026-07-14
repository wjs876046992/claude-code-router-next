/**
 * API key authentication middleware for the CCR runtime.
 *
 * Migrated verbatim from packages/server/src/middleware/auth.ts.
 * Local requests (127.0.0.1) are trusted and skip auth.
 */
import type { FastifyRequest, FastifyReply } from "fastify";

/**
 * Determine if a request originates from the local machine.
 * This is used to skip API key validation for local clients (Claude Code, Codex).
 */
function isLocalRequest(req: FastifyRequest): boolean {
  const ip = req.ip || (req as any).connection?.remoteAddress || "";
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

export const apiKeyAuth =
  (config: any) =>
  async (req: FastifyRequest, reply: FastifyReply, done: () => void) => {
    // Public endpoints that don't require authentication
    const publicPaths = ["/", "/health"];
    if (publicPaths.includes(req.url) || req.url.startsWith("/ui")) {
      return done();
    }

    // Local requests (127.0.0.1) are trusted — skip auth
    if (isLocalRequest(req)) {
      return done();
    }

    // Check if Providers is empty or not configured
    const providers = config.Providers || config.providers || [];
    if (!providers || providers.length === 0) {
      return done();
    }

    const apiKey = config.APIKEY;
    if (!apiKey) {
      const allowedOrigins = [
        `http://127.0.0.1:${config.PORT || 3456}`,
        `http://localhost:${config.PORT || 3456}`,
      ];
      if (req.headers.origin && !allowedOrigins.includes(req.headers.origin)) {
        reply.status(403).send("CORS not allowed for this origin");
        return;
      } else {
        reply.header('Access-Control-Allow-Origin', `http://127.0.0.1:${config.PORT || 3456}`);
        reply.header('Access-Control-Allow-Origin', `http://localhost:${config.PORT || 3456}`);
      }
      return done();
    }

    const authHeaderValue =
      req.headers.authorization || req.headers["x-api-key"];
    const authKey: string = Array.isArray(authHeaderValue)
      ? authHeaderValue[0]
      : authHeaderValue || "";
    if (!authKey) {
      reply.log.warn({ url: req.url, headers: Object.keys(req.headers) }, "[AUTH] No auth header");
      reply.status(401).send("APIKEY is missing");
      return;
    }
    let token = "";
    if (authKey.startsWith("Bearer")) {
      token = authKey.split(" ")[1];
    } else {
      token = authKey;
    }

    if (token !== apiKey) {
      reply.log.warn({
        url: req.url,
        gotPrefix: token.slice(0,10),
        gotSuffix: token.slice(-6),
        gotLen: token.length,
        expectedPrefix: apiKey.slice(0,6),
        expectedSuffix: apiKey.slice(-6),
        expectedLen: apiKey.length,
      }, "[AUTH] Key mismatch");
      reply.status(401).send("Invalid API key");
      return;
    }

    done();
  };