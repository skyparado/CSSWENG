import type { NextFunction, Request, Response } from 'express';
import { ZodError, type ZodSchema } from 'zod';

/** An error carrying an HTTP status code. */
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const notFound = (msg = 'Not found') => new HttpError(404, msg);
export const badRequest = (msg: string, details?: unknown) =>
  new HttpError(400, msg, details);
export const conflict = (msg: string, details?: unknown) =>
  new HttpError(409, msg, details);

/** Wrap an async route handler so rejections reach the error middleware. */
export function asyncHandler<
  T extends (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
>(fn: T) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}

type Source = 'body' | 'query' | 'params';

/**
 * Validate and replace `req[source]` with the parsed value. On failure throws a
 * 400 HttpError with the Zod issues as details.
 */
export function validate<S extends ZodSchema>(schema: S, source: Source = 'body') {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      return next(badRequest('Validation failed', result.error.flatten()));
    }
    // Reassign the parsed/coerced value for handlers to use.
    (req as Record<Source, unknown>)[source] = result.data;
    next();
  };
}

/** Terminal error handler. Keep last in the middleware chain. */
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
) {
  if (err instanceof HttpError) {
    return res
      .status(err.status)
      .json({ error: err.message, details: err.details ?? null });
  }
  if (err instanceof ZodError) {
    return res
      .status(400)
      .json({ error: 'Validation failed', details: err.flatten() });
  }
  // Prisma "record not found" on update/delete.
  if (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: string }).code === 'P2025'
  ) {
    return res.status(404).json({ error: 'Not found', details: null });
  }
  // eslint-disable-next-line no-console
  console.error(err);
  return res.status(500).json({ error: 'Internal server error', details: null });
}
