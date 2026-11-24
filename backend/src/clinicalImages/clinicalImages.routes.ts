import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import {
  imageUploadMetadataSchema,
  imageUpdateSchema,
  imageListQuerySchema,
  annotationSaveSchema, drawingSchema, eyeTemplateSchema, templateCommitSchema, imageContextSchema,
  idParamSchema,
  ALLOWED_IMAGE_MIME_TYPES,
  MAX_IMAGE_SIZE_BYTES,
} from '@clinic/schemas';
import { asyncHandler, badRequest, validate } from '../http.js';
import { requireAuth, requireDoctor } from '../auth/middleware.js';
import { changeImage, commitTemplate, createImage, getImage, listAnnotations, listImages, selectTemplate } from './clinicalImages.service.js';
import { getObject, presignedGetUrl } from './s3Client.js';
import { prepareUpload } from './prepareUpload.js';
export const clinicalImagesRouter = Router();

/*
 * All clinical-image endpoints are Doctor-only per the SDD Role Permission
 * Matrix (SDD 7.1): the Doctor owns the clinical record end to end.
 */
clinicalImagesRouter.use(requireAuth, requireDoctor, (_req, res, next) => {
  res.set('Cache-Control', 'private, no-store');
  next();
});

function actor(req: Request) {
  const { userId, activeClinicId } = req.session.user!;
  if (!activeClinicId) throw badRequest('Select an active clinic first');
  return { userId, clinicId: activeClinicId };
}

/* ------------------------------- Upload ---------------------------------- */

/** multer stores the file in memory so we can stream it straight to S3. */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_SIZE_BYTES },
  fileFilter: (_req, file, cb) => {
    if ((ALLOWED_IMAGE_MIME_TYPES as readonly string[]).includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported image type: ${file.mimetype}`));
    }
  },
});

/** Convert multer's unhelpful errors into our standard HttpError shape. */
function multerErrorHandler(
  err: unknown,
  _req: Request,
  _res: Response,
  next: NextFunction,
): void {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return next(badRequest(`Image exceeds ${MAX_IMAGE_SIZE_BYTES} bytes`));
    }
    return next(badRequest(`Upload error: ${err.message}`));
  }
  if (err instanceof Error && err.message.startsWith('Unsupported image type')) {
    return next(badRequest(err.message));
  }
  next(err);
}

/** POST /api/clinical-images — multipart upload. Field name: `file`. */
clinicalImagesRouter.post(
  '/',
  upload.single('file'),
  multerErrorHandler,
  asyncHandler(async (req, res) => {
    if (!req.file) throw badRequest('No file uploaded; use multipart field `file`');
    const metadata = imageUploadMetadataSchema.parse(req.body);
    const bytes = await prepareUpload(req.file.buffer, req.file.mimetype);
    const image = await createImage({ ...metadata, bytes, fileName: req.file.originalname, mimeType: req.file.mimetype }, actor(req));
    res.status(201).json(image);
  }),
);

clinicalImagesRouter.get('/', validate(imageListQuerySchema, 'query'), asyncHandler(async (req, res) => {
  res.json(await listImages(imageListQuerySchema.parse(req.query)));
}));

clinicalImagesRouter.get('/templates/:type', asyncHandler(async (req, res) => {
  const context = imageContextSchema.required().parse(req.query);
  const bytes = await selectTemplate(context, eyeTemplateSchema.parse(req.params.type), actor(req));
  res.type('image/svg+xml').send(bytes);
}));

clinicalImagesRouter.post('/templates', validate(templateCommitSchema), asyncHandler(async (req, res) => {
  res.status(201).json(await commitTemplate(req.body, actor(req)));
}));

clinicalImagesRouter.use('/:id', validate(idParamSchema, 'params'), validate(imageContextSchema, 'query'));

clinicalImagesRouter.get('/:id', asyncHandler(async (req, res) => {
  res.json(await getImage(req.params.id, imageContextSchema.parse(req.query)));
}));

clinicalImagesRouter.get('/:id/download', asyncHandler(async (req, res) => {
  const image = await getImage(req.params.id, imageContextSchema.parse(req.query), true);
  res.json({ url: await presignedGetUrl(image.storageKey, 300), expiresIn: 300 });
}));

// Same-origin bytes work with Helmet, private buckets and tablets without S3 CORS.
clinicalImagesRouter.get('/:id/content', asyncHandler(async (req, res) => {
  const image = await getImage(req.params.id, imageContextSchema.parse(req.query), true);
  res.type(image.mimeType).send(await getObject(image.storageKey));
}));

clinicalImagesRouter.patch('/:id', validate(imageUpdateSchema), asyncHandler(async (req, res) => {
  res.json(await changeImage(req.params.id, imageContextSchema.parse(req.query), actor(req), { action: 'caption', caption: req.body.caption }));
}));
clinicalImagesRouter.delete('/:id', asyncHandler(async (req, res) => {
  res.json(await changeImage(req.params.id, imageContextSchema.parse(req.query), actor(req), { action: 'remove' }));
}));
clinicalImagesRouter.post('/:id/annotations', validate(annotationSaveSchema), asyncHandler(async (req, res) => {
  const data = drawingSchema.parse(req.body.konvaData);
  res.status(201).json(await changeImage(req.params.id, imageContextSchema.parse(req.query), actor(req), { action: 'annotate', data }));
}));
clinicalImagesRouter.get('/:id/annotations', asyncHandler(async (req, res) => {
  res.json({ items: await listAnnotations(req.params.id, imageContextSchema.parse(req.query)) });
}));
clinicalImagesRouter.get('/:id/annotations/latest', asyncHandler(async (req, res) => {
  const [latest] = await listAnnotations(req.params.id, imageContextSchema.parse(req.query), true);
  res.json(latest ?? null);
}));
