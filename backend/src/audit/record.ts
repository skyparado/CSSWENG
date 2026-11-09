import type { Request } from 'express';
import { writeAudit, type AuditTx } from './audit.service.js';
import type { AuditAction } from './actions.js';

/** Who did something. `SYSTEM` is used for background jobs (reminder worker, etc.). */
export interface AuditActor {
  userId: string | null;
  userEmail: string | null;
  userRole: string | null;
  method: string | null;
  path: string | null;
  ipAddress: string | null;
  userAgent: string | null;
}

export const SYSTEM_ACTOR: AuditActor = {
  userId: null,
  userEmail: null,
  userRole: 'SYSTEM',
  method: null,
  path: null,
  ipAddress: null,
  userAgent: null,
};

/** The signed-in user and HTTP context of a request, as an audit actor. */
export function actorFromRequest(req: Request): AuditActor {
  const user = req.session?.user;
  return {
    userId: user?.userId ?? null,
    userEmail: null, // the session does not carry the email; the userId is the stable key
    userRole: user?.role ?? null,
    method: req.method,
    path: (req.originalUrl ?? '').split('?')[0] || null,
    ipAddress: req.ip ?? null,
    userAgent: req.get?.('user-agent') ?? null,
  };
}

export interface AuditEvent {
  action: AuditAction;
  resourceType: string;
  resourceId: string;
  metadata?: Record<string, unknown>;
}

/**
 * Record a business event in the shared, hash-chained audit log. Pass `tx` to
 * write inside the caller's transaction so the event and the change commit or
 * roll back together.
 */
export function recordAudit(actor: AuditActor, event: AuditEvent, tx?: AuditTx) {
  return writeAudit(
    {
      ...actor,
      action: event.action,
      resourceType: event.resourceType,
      resourceId: event.resourceId,
      statusCode: null,
      metadata: event.metadata ?? null,
    },
    tx,
  );
}
