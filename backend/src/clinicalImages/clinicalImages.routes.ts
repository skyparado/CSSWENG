import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import {
  imageUploadMetadataSchema,
  imageUpdateSchema,
  imageListQuerySchema,
  annotationSaveSchema,
  idParamSchema,
  ALLOWED_IMAGE_MIME_TYPES,
  MAX_IMAGE_SIZE_BYTES,
} from '@clinic/schemas';
import { asyncHandler, badRequest, validate } from '../http.js';
import { requireAuth, requireDoctor } from '../auth/middleware.js';
import {
  getImage,
  getImageSignedUrl,
  getLatestAnnotation,
  listAnnotations,
  listImages,
  saveAnnotation,
  softDeleteImage,
  updateCaption,
  uploadImage,
} from './clinicalImages.service.js';

export const clinicalImagesRouter = Router();

/*
 * All clinical-image endpoints are Doctor-only per the SDD Role Permission
 * Matrix (SDD 7.1): the Doctor owns the clinical record end to end.
 */
clinicalImagesRouter.use(requireAuth, requireDoctor);

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
    const user = req.session.user!;
    const image = await uploadImage({
      ...metadata,
      fileName: req.file.originalname,
      mimeType: req.file.mimetype,
      bytes: req.file.buffer,
      uploadedById: user.userId,
      userEmail: null,
      userRole: user.role,
    });
    res.status(201).json(image);
  }),
);

/* ------------------------------- Read ------------------------------------ */

clinicalImagesRouter.get(
  '/',
  validate(imageListQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const query = req.query as unknown as import('@clinic/schemas').ImageListQuery;
    const result = await listImages(query);
    res.json(result);
  }),
);

clinicalImagesRouter.get(
  '/:id',
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const image = await getImage(req.params.id);
    res.json(image);
  }),
);

/** GET /api/clinical-images/:id/download — short-lived presigned S3 URL. */
clinicalImagesRouter.get(
  '/:id/download',
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const result = await getImageSignedUrl(req.params.id);
    res.json(result);
  }),
);

/* ------------------------------- Mutate ---------------------------------- */

clinicalImagesRouter.patch(
  '/:id',
  validate(idParamSchema, 'params'),
  validate(imageUpdateSchema),
  asyncHandler(async (req, res) => {
    const user = req.session.user!;
    const updated = await updateCaption(req.params.id, req.body.caption, {
      userId: user.userId,
      userEmail: null,
      userRole: user.role,
    });
    res.json(updated);
  }),
);

clinicalImagesRouter.delete(
  '/:id',
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const user = req.session.user!;
    const deleted = await softDeleteImage(req.params.id, {
      userId: user.userId,
      userEmail: null,
      userRole: user.role,
    });
    res.json(deleted);
  }),
);

/* ------------------------------- Annotations ------------------------------ */

clinicalImagesRouter.post(
  '/:id/annotations',
  validate(idParamSchema, 'params'),
  validate(annotationSaveSchema),
  asyncHandler(async (req, res) => {
    const user = req.session.user!;
    const row = await saveAnnotation(req.params.id, req.body.konvaData, {
      userId: user.userId,
      userEmail: null,
      userRole: user.role,
    });
    res.status(201).json(row);
  }),
);

clinicalImagesRouter.get(
  '/:id/annotations',
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const rows = await listAnnotations(req.params.id);
    res.json({ items: rows });
  }),
);

clinicalImagesRouter.get(
  '/:id/annotations/latest',
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const row = await getLatestAnnotation(req.params.id);
    res.json(row ?? null);
  }),
);