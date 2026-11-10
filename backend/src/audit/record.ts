import type { Request, Response } from 'express';
import { writeAudit } from './audit.service.js';
import type { AuditAction } from './actions.js';

/**
 * Details a route handler supplies for a named audit event. Everything the
 * request already knows (method, path, IP, user agent, who is signed in) is
 * filled in for you.
 */
export type AuditEventDetails = {
  action: AuditAction;
  /** Model or concept the event is about, for example 'User' or 'ClinicalImage'. */
  resourceType?: string | null;
  /** Id of the affected record. Deliberately not a foreign key (Table 1-21). */
  resourceId?: string | null;
  /** Status code to record. Defaults to whatever the response ended up with. */
  statusCode?: number | null;
  /** Anything else worth keeping. Never put a password or a full record here. */
  metadata?: unknown;
  /**
   * Override the acting user. Needed on the login path, where the session is
   * not set up yet but we do know which account was involved.
   */
  actor?: {
    userId?: string | null;
    userEmail?: string | null;
    userRole?: string | null;
  };
};

/**
 * Marks the request as already audited so auditMiddleware skips its generic
 * HTTP_REQUEST row. Without this a single login writes two entries: the named
 * LOGIN_SUCCESS and a duplicate HTTP_REQUEST, which makes the audit screen
 * twice as long and half as useful.
 */
export function markAudited(res: Response): void {
  res.locals.auditHandled = true;
}

export function wasAudited(res: Response): boolean {
  return res.locals.auditHandled === true;
}

/**
 * Write a named business event for this request. Fire-and-forget on purpose:
 * a failing audit write must never change the response the user sees. The
 * error is logged so operators notice if the chain stops advancing.
 *
 * Call this instead of writeAudit from route handlers. It suppresses the
 * generic middleware row for the same request.
 */
export function recordEvent(
  req: Request,
  res: Response,
  details: AuditEventDetails,
): void {
  const sessionUser = req.session?.user;
  const path = req.originalUrl.split('?')[0] ?? req.originalUrl;

  markAudited(res);

  writeAudit({
    userId: details.actor?.userId ?? sessionUser?.userId ?? null,
    userEmail: details.actor?.userEmail ?? null,
    userRole: details.actor?.userRole ?? sessionUser?.role ?? null,
    action: details.action,
    resourceType: details.resourceType ?? null,
    resourceId: details.resourceId ?? null,
    method: req.method,
    path,
    statusCode: details.statusCode ?? res.statusCode ?? null,
    ipAddress: req.ip ?? null,
    userAgent: req.get('user-agent') ?? null,
    metadata: details.metadata ?? null,
  }).catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`audit write failed for ${details.action}:`, err);
  });
}
