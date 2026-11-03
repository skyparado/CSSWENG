import { Router, type NextFunction, type Request, type Response } from "express";
import type { PrismaClient } from "@prisma/client";
import { ZodError } from "zod";
import {
  CreateAddendumSchema,
  CreateEncounterSchema,
  EncounterListQuerySchema,
  SaveNoteDraftSchema,
  SignNoteSchema,
} from "@clinic/schemas";
import { getActor } from "../patients/patient.routes.js";
import { PatientError } from "../patients/patient.service.js";
import {
  EncounterError,
  addAddendum,
  createEncounter,
  getEncounter,
  listEncounters,
  saveDraft,
  signNote,
} from "./encounter.service.js";

type Handler = (req: Request, res: Response) => Promise<void>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);

/**
 * Mount in app.ts:  app.use("/api/encounters", createEncounterRouter(prisma));
 *
 *   GET   /api/encounters?patientId=              visit list for a chart (S06)
 *   POST  /api/encounters                         start a visit at the active clinic
 *   GET   /api/encounters/:id                     visit + note + addenda (note: doctor only)
 *   PUT   /api/encounters/:id/note                create / save draft (doctor); 409 NOTE_LOCKED once signed
 *   POST  /api/encounters/:id/note/sign           sign and lock (doctor); body { version }
 *   POST  /api/encounters/:id/note/addenda        dated addendum on a signed note (doctor);
 *                                                 body { addendumReason, ...SOAP fields being added }
 *
 * Examination findings for a visit are under /api/encounters/:id/findings
 * (see results/results.routes.ts).
 */
export function createEncounterRouter(
  db: Pick<PrismaClient, "patient" | "appointment" | "encounter" | "clinicalNote" | "user">,
): Router {
  const router = Router();

  router.get(
    "/",
    wrap(async (req, res) => {
      getActor(req);
      const { patientId } = EncounterListQuerySchema.parse(req.query);
      res.json(await listEncounters(db, patientId));
    }),
  );

  router.post(
    "/",
    wrap(async (req, res) => {
      const actor = getActor(req);
      const input = CreateEncounterSchema.parse(req.body);
      res.status(201).json(await createEncounter(db, input, actor));
    }),
  );

  router.get(
    "/:id",
    wrap(async (req, res) => {
      res.json(await getEncounter(db, req.params.id!, getActor(req)));
    }),
  );

  router.put(
    "/:id/note",
    wrap(async (req, res) => {
      const actor = getActor(req);
      const input = SaveNoteDraftSchema.parse(req.body);
      res.json(await saveDraft(db, req.params.id!, input, actor));
    }),
  );

  router.post(
    "/:id/note/sign",
    wrap(async (req, res) => {
      const actor = getActor(req);
      const input = SignNoteSchema.parse(req.body);
      res.json(await signNote(db, req.params.id!, input, actor));
    }),
  );

  router.post(
    "/:id/note/addenda",
    wrap(async (req, res) => {
      const actor = getActor(req);
      const input = CreateAddendumSchema.parse(req.body);
      res.status(201).json(await addAddendum(db, req.params.id!, input, actor));
    }),
  );

  router.use(clinicalErrorHandler);

  return router;
}

/** Same error shape as the patients router. Shared by the clinical routers. */
export function clinicalErrorHandler(err: unknown, _req: Request, res: Response, next: NextFunction) {
  if (err instanceof ZodError) {
    res.status(400).json({ error: "VALIDATION_ERROR", issues: err.flatten().fieldErrors });
    return;
  }
  if (err instanceof EncounterError || err instanceof PatientError) {
    res.status(err.status).json({ error: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) });
    return;
  }
  next(err);
}
