import type { Request, Response } from 'express';
import { writeAudit, type AuditTx } from './audit.service.js';
import type { AuditAction } from './actions.js';

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

export function actorFromRequest(req: Request): AuditActor {
  const user = req.session?.user;
  return {
    userId: user?.userId ?? null,
    userEmail: null,
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

export type AuditEventDetails = {
  action: AuditAction;
  resourceType?: string | null;
  resourceId?: string | null;
  statusCode?: number | null;
  metadata?: unknown;
  actor?: {
    userId?: string | null;
    userEmail?: string | null;
    userRole?: string | null;
  };
};

export function markAudited(res: Response): void {
  res.locals.auditHandled = true;
}

export function wasAudited(res: Response): boolean {
  return res.locals.auditHandled === true;
}

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
    console.error(`audit write failed for ${details.action}:`, err);
  });
}

}
