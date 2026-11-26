import { readFile } from 'node:fs/promises';
import { Router } from 'express';
import { DIAGRAM_TEMPLATES, type DiagramTemplate } from '@clinic/schemas';
import { requireAuth, requireDoctor } from '../auth/middleware.js';
import { markAudited } from '../audit/record.js';
import { asyncHandler, notFound } from '../http.js';

/**
 * The four blank eye diagrams the Doctor draws on from S07 (SDD 5.7), served
 * from backend/assets/eye-templates:
 *
 *   GET /api/eye-templates/:key    key is ANTERIOR_OD | ANTERIOR_OS | POSTERIOR_OD | POSTERIOR_OS
 *
 * The key is looked up in a fixed table, never joined into a path, so no other
 * file can be reached. The diagrams are blank and hold no patient data, so
 * fetching one is not written to the audit log (it would add rows on every
 * chart open). Doctor only, like the rest of the image tools.
 */
export const eyeTemplatesRouter = Router();
eyeTemplatesRouter.use(requireAuth, requireDoctor);

const FILE: Record<DiagramTemplate, string> = {
  ANTERIOR_OD: 'anterior-od.svg',
  ANTERIOR_OS: 'anterior-os.svg',
  POSTERIOR_OD: 'posterior-od.svg',
  POSTERIOR_OS: 'posterior-os.svg',
};

/** backend/assets/eye-templates from both src/ (tsx) and dist/ (compiled). */
const DIR = new URL('../../assets/eye-templates/', import.meta.url);
const cache = new Map<DiagramTemplate, Buffer>();

eyeTemplatesRouter.get(
  '/:key',
  asyncHandler(async (req, res) => {
    const key = req.params.key as DiagramTemplate;
    if (!(DIAGRAM_TEMPLATES as readonly string[]).includes(key)) throw notFound('Unknown eye template');

    let svg = cache.get(key);
    if (!svg) {
      svg = await readFile(new URL(FILE[key], DIR));
      cache.set(key, svg);
    }

    markAudited(res);
    res
      .status(200)
      .set({
        'Content-Type': 'image/svg+xml; charset=utf-8',
        'Cache-Control': 'private, max-age=86400',
        'X-Content-Type-Options': 'nosniff',
        // An SVG is a document: forbid scripts and any other loads if it is ever opened directly.
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
      })
      .send(svg);
  }),
);
