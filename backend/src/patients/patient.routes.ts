import { Router, type NextFunction, type Request, type Response } from "express";
import type { PrismaClient } from "@prisma/client";
import { ZodError } from "zod";
import { CreatePatientSchema, PatientSearchQuerySchema, UpdatePatientSchema } from "@clinic/schemas";
import {
  PatientError,
  getPatient,
  registerPatient,
  searchPatients,
  updatePatient,
  type Actor,
} from "./patient.service.js";

/**
 * Reads the signed-in user from the session.
 *
 * ADJUST HERE ONLY once Lance's session/auth middleware lands. This assumes
 * `req.session.user = { id, role, activeClinicId }`, with activeClinicId set
 * on Clinic Selection (S02). Lance's middleware should already reject
 * unauthenticated requests before they reach this router.
 */
export function getActor(req: Request): Actor {
  const user = (req as Request & { session?: { user?: Partial<Actor> } }).session?.user;
  if (!user?.id || !user.role) throw new PatientError(401, "UNAUTHENTICATED", "Sign in required");
  if (!user.activeClinicId) throw new PatientError(409, "NO_ACTIVE_CLINIC", "Select a clinic first");
  return user as Actor;
}

type Handler = (req: Request, res: Response) => Promise<void>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);

/**
 * Mount in app.ts:  app.use("/api/patients", createPatientRouter(prisma));
 *
 *   GET    /api/patients?q=&by=&scope=&page=&pageSize=   search / list (S04)
 *   POST   /api/patients                                 register (S05); 409 POSSIBLE_DUPLICATE
 *   GET    /api/patients/:id                             record (S06 header / secretary view)
 *   PATCH  /api/patients/:id                             update demographics
 */
export function createPatientRouter(db: Pick<PrismaClient, "patient">): Router {
  const router = Router();

  router.get(
    "/",
    wrap(async (req, res) => {
      const actor = getActor(req);
      const query = PatientSearchQuerySchema.parse(req.query);
      res.json(await searchPatients(db, query, actor));
    }),
  );

  router.post(
    "/",
    wrap(async (req, res) => {
      const actor = getActor(req);
      const input = CreatePatientSchema.parse(req.body);
      const result = await registerPatient(db, input, actor);
      res.status(201).json(result);
    }),
  );

  router.get(
    "/:id",
    wrap(async (req, res) => {
      res.json(await getPatient(db, req.params.id!, getActor(req)));
    }),
  );

  router.patch(
    "/:id",
    wrap(async (req, res) => {
      const actor = getActor(req);
      const input = UpdatePatientSchema.parse(req.body);
      res.json(await updatePatient(db, req.params.id!, input, actor));
    }),
  );

  // Module-local error handler so this works before a shared one exists.
  // If src/http.ts already has an error handler, you can drop this and
  // throw PatientError / ZodError up to it instead.
  router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (err instanceof ZodError) {
      res.status(400).json({ error: "VALIDATION_ERROR", issues: err.flatten().fieldErrors });
      return;
    }
    if (err instanceof PatientError) {
      res.status(err.status).json({ error: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) });
      return;
    }
    next(err);
  });

  return router;
}
