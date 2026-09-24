import { FastifyRequest, FastifyReply } from "fastify";

export interface ApiError extends Error {
  statusCode?: number;
  code?: string;
  type?: string;
  rawBody?: string;
}

export function createApiError(
  message: string,
  statusCode: number = 500,
  code: string = "internal_error",
  type: string = "api_error"
): ApiError {
  const error = new Error(message) as ApiError;
  error.statusCode = statusCode;
  error.code = code;
  error.type = type;
  return error;
}

export async function errorHandler(
  error: ApiError,
  request: FastifyRequest,
  reply: FastifyReply
) {
  request.log.error(error);

  const statusCode = error.statusCode || 500;

  // When provider raw response body is available, pass it through directly
  if (error.rawBody) {
    try {
      const parsed = JSON.parse(error.rawBody);
      // If parsed is a valid object, send it as-is (provider returned proper JSON error)
      if (parsed && typeof parsed === "object") {
        return reply.code(statusCode).send(parsed);
      }
      // If parsed is not an object (e.g. string "Not Found"), wrap it in ApiError format
      return reply.code(statusCode).send({
        error: {
          message: typeof parsed === "string" ? parsed : String(parsed),
          type: error.type || "api_error",
          code: error.code || "provider_error",
        },
      });
    } catch {
      // rawBody is not JSON (e.g. plain text "Not Found"), wrap it in ApiError format
      return reply.code(statusCode).send({
        error: {
          message: error.rawBody,
          type: error.type || "api_error",
          code: error.code || "provider_error",
        },
      });
    }
  }

  const response = {
    error: {
      message: error.message || "Internal Server Error",
      type: error.type || "api_error",
      code: error.code || "internal_error",
    },
  };

  return reply.code(statusCode).send(response);
}

/**
 * Custom 404 handler that returns JSON format instead of plain text.
 * OpenAI-compatible clients (especially Rust SDK) expect JSON ApiError structure.
 */
export async function notFoundHandler(
  request: FastifyRequest,
  reply: FastifyReply
) {
  return reply.code(404).send({
    error: {
      message: `Route ${request.method}:${request.url} not found`,
      type: "invalid_request_error",
      code: "not_found",
    },
  });
}
