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
      return reply.code(statusCode).send(parsed);
    } catch {
      return reply.code(statusCode).send(error.rawBody);
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
