import { Router, type NextFunction, type Request, type Response } from "express";
import { writeAudit } from "../audit/audit.service.js";
import { AuditActions } from "../audit/actions.js";
import { PatientError } from "./patient.service.js";
import { getActor } from "./patient.routes.js";
import { chartSummary } from "./chartSummary.service.js";

/**
 * Mount in app.ts:  app.use("/api/patients", requireAuth, chartSummaryRouter);
 *
 *   GET /api/patients/:id/summary   everything S06 shows (Doctor and Secretary;
 *                                   clinical content Doctor only)
 */
export const chartSummaryRouter = Router();

chartSummaryRouter.get("/:id/summary", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const actor = getActor(req);
    const summary = await chartSummary(req.params.id!, actor);
    // S06 footnote: every view of the chart is recorded in the audit log.
    await writeAudit({
      userId: actor.id,
      userEmail: null,
      userRole: actor.role,
      action: AuditActions.PATIENT_CHART_VIEWED,
      resourceType: "PATIENT",
      resourceId: summary.patient.id as string,
      method: req.method,
      path: req.originalUrl,
      statusCode: 200,
      ipAddress: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
      metadata: { clinicId: actor.activeClinicId },
    });
    res.json(summary);
  } catch (err) {
    if (err instanceof PatientError) {
      res.status(err.status).json({ error: err.code, message: err.message });
      return;
    }
    next(err);
  }
});
