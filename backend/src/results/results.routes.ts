import { Router, type NextFunction, type Request, type Response } from "express";
import type { PrismaClient } from "@prisma/client";
import {
  AmendExamFindingSchema,
  AmendLabResultSchema,
  ComparisonQuerySchema,
  CreateLabResultSchema,
  ExamFindingSchema,
  LabResultListQuerySchema,
} from "@clinic/schemas";
import { getActor } from "../patients/patient.routes.js";
import { clinicalErrorHandler } from "../encounters/encounter.routes.js";
import { addFinding, amendFinding, deleteFinding, listFindings, replaceFinding } from "./examFinding.service.js";
import { amendLabResult, createLabResult, listLabResults } from "./labResult.service.js";
import { buildComparison } from "./comparison.service.js";

type Handler = (req: Request, res: Response) => Promise<void>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);

/**
 * Examination findings of one visit (S07). Doctor only.
 * Mount in app.ts:  app.use("/api/encounters/:encounterId/findings", createFindingRouter(prisma));
 *
 *   GET    /                         findings, including corrected originals
 *   POST   /                         add while the visit is OPEN; 409 FINDINGS_LOCKED once signed
 *   PUT    /:findingId               replace while OPEN
 *   DELETE /:findingId               remove while OPEN
 *   POST   /:findingId/amendments    correction after signing; body { valueText, unit, method?, amendmentReason }
 */
export function createFindingRouter(db: Pick<PrismaClient, "encounter" | "examFinding">): Router {
  const router = Router({ mergeParams: true });
  const encounterId = (req: Request) => (req.params as Record<string, string>).encounterId!;

  router.get(
    "/",
    wrap(async (req, res) => {
      res.json(await listFindings(db, encounterId(req), getActor(req)));
    }),
  );

  router.post(
    "/",
    wrap(async (req, res) => {
      const actor = getActor(req);
      const input = ExamFindingSchema.parse(req.body);
      res.status(201).json(await addFinding(db, encounterId(req), input, actor));
    }),
  );

  router.put(
    "/:findingId",
    wrap(async (req, res) => {
      const actor = getActor(req);
      const input = ExamFindingSchema.parse(req.body);
      res.json(await replaceFinding(db, encounterId(req), req.params.findingId!, input, actor));
    }),
  );

  router.delete(
    "/:findingId",
    wrap(async (req, res) => {
      await deleteFinding(db, encounterId(req), req.params.findingId!, getActor(req));
      res.status(204).end();
    }),
  );

  router.post(
    "/:findingId/amendments",
    wrap(async (req, res) => {
      const actor = getActor(req);
      const input = AmendExamFindingSchema.parse(req.body);
      res.status(201).json(await amendFinding(db, encounterId(req), req.params.findingId!, input, actor));
    }),
  );

  router.use(clinicalErrorHandler);
  return router;
}

/**
 * Laboratory results (S08 "Add Lab Result"). Doctor only.
 * Mount in app.ts:  app.use("/api/lab-results", createLabResultRouter(prisma));
 *
 *   GET   /?patientId=&testName=     results by collection date, including corrected originals
 *   POST  /                          record a result
 *   POST  /:id/amendments            correction; the original is kept
 */
export function createLabResultRouter(db: Pick<PrismaClient, "patient" | "encounter" | "labResult">): Router {
  const router = Router();

  router.get(
    "/",
    wrap(async (req, res) => {
      const actor = getActor(req);
      res.json(await listLabResults(db, LabResultListQuerySchema.parse(req.query), actor));
    }),
  );

  router.post(
    "/",
    wrap(async (req, res) => {
      const actor = getActor(req);
      const input = CreateLabResultSchema.parse(req.body);
      res.status(201).json(await createLabResult(db, input, actor));
    }),
  );

  router.post(
    "/:id/amendments",
    wrap(async (req, res) => {
      const actor = getActor(req);
      const input = AmendLabResultSchema.parse(req.body);
      res.status(201).json(await amendLabResult(db, req.params.id!, input, actor));
    }),
  );

  router.use(clinicalErrorHandler);
  return router;
}

/**
 * Comparison across visits (S08). Doctor only.
 * Mount in app.ts:  app.use("/api/patients", createComparisonRouter(prisma));
 *
 *   GET /:patientId/comparison?show=both&fields=VA,IOP&tests=HbA1c&from=&to=&encounterIds=&currentEncounterId=
 *
 * Returns { columns, rows, chart }; chart.data and chart.series plug straight
 * into a Recharts <LineChart> (see ComparisonChartSchema).
 */
export function createComparisonRouter(
  db: Pick<PrismaClient, "patient" | "encounter" | "examFinding" | "labResult">,
): Router {
  const router = Router();

  router.get(
    "/:patientId/comparison",
    wrap(async (req, res) => {
      const actor = getActor(req);
      const query = ComparisonQuerySchema.parse(req.query);
      res.json(await buildComparison(db, req.params.patientId!, query, actor));
    }),
  );

  router.use(clinicalErrorHandler);
  return router;
}
