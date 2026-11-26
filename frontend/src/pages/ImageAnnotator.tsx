import { useCallback, useEffect, useRef, useState } from 'react';
import { Arrow, Image as KonvaImage, Layer, Line, Stage, Text } from 'react-konva';
import type Konva from 'konva';
import type { DiagramTemplate } from '@clinic/schemas';
import {
  EYE_TEMPLATE_LABEL,
  eyeTemplateUrl,
  imageApi,
  type AnnotationData,
  type ClinicalImage,
  type ImageAnnotation,
  type Shape,
} from '../imageApi';

/**
 * S09 drawing over a clinical image, with Konva.
 *
 * The original image is never touched. Each save is a new annotation layer with
 * the next version number, so a drawing can be reviewed against the one before
 * it and nothing is lost by correcting a mark.
 *
 * Marks are stored in the image's own pixel coordinates, not the screen's, so a
 * drawing made on the clinic tablet lines up when it is opened on a laptop.
 */

/** Widest the canvas is drawn, so a 4000px fundus photo still fits a screen. */
const MAX_DISPLAY_WIDTH = 900;

const COLORS = [
  { value: '#e23b3b', label: 'Red' },
  { value: '#f5a524', label: 'Amber' },
  { value: '#2f7d32', label: 'Green' },
  { value: '#1e5fb4', label: 'Blue' },
  { value: '#ffffff', label: 'White' },
];

type Tool = 'pen' | 'arrow' | 'text';

/** Flatten the loaded diagram to a PNG so it can be stored as the image the layers sit on. */
function rasterize(el: HTMLImageElement): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = el.naturalWidth;
  canvas.height = el.naturalHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.reject(new Error('Could not prepare the diagram.'));
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(el, 0, 0);
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not prepare the diagram.'))), 'image/png'),
  );
}

/**
 * Open with an `imageId` to draw on an existing image. Open with `template` and
 * `encounterId` (and no imageId) to start a drawing on a blank eye diagram from
 * S07: nothing is stored until the first save, which clones the diagram into a
 * clinical image linked to that visit and saves the first layer on it. If the
 * visit already has a drawing on that diagram, that one opens instead, so the
 * doctor never ends up with two copies.
 */
export default function ImageAnnotator({
  patientId,
  imageId,
  encounterId,
  template,
}: {
  patientId: string;
  imageId?: string;
  encounterId?: string;
  template?: DiagramTemplate;
}) {
  const [currentId, setCurrentId] = useState<string | undefined>(imageId);
  const [image, setImage] = useState<ClinicalImage | undefined>();
  const [bitmap, setBitmap] = useState<HTMLImageElement | null>(null);
  const [layers, setLayers] = useState<ImageAnnotation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [tool, setTool] = useState<Tool>('pen');
  const [color, setColor] = useState(COLORS[0]!.value);
  const [strokeWidth, setStrokeWidth] = useState(4);
  const [label, setLabel] = useState('');
  const [shapes, setShapes] = useState<Shape[]>([]);

  // Which saved layer the canvas was seeded from, for the "editing version N"
  // line. Null means a blank layer on top of whatever is saved.
  const [basedOn, setBasedOn] = useState<number | null>(null);

  const drawing = useRef(false);

  /* ----------------------------- Loading ---------------------------------- */

  useEffect(() => {
    let cancelled = false;

    /** Decode into a bitmap now and keep the bitmap rather than the (short-lived) URL. */
    function decode(src: string) {
      const el = new window.Image();
      el.crossOrigin = 'anonymous';
      el.onload = () => {
        if (!cancelled) setBitmap(el);
      };
      el.onerror = () => {
        if (!cancelled) setError('The image could not be loaded.');
      };
      el.src = src;
    }

    async function load() {
      try {
        let id = imageId;
        if (!id) {
          // A new drawing from S07. Reuse this visit's drawing on the same diagram if there is one.
          const existing =
            encounterId && template
              ? (await imageApi.list(patientId, 'ACTIVE', encounterId)).items.find((i) => i.diagramTemplate === template)
              : undefined;
          if (!existing) {
            if (!template) throw new Error('Choose an image to draw on.');
            if (!cancelled) decode(eyeTemplateUrl(template));
            return;
          }
          id = existing.id;
          setCurrentId(id);
          window.history.replaceState(null, '', `#/patients/${patientId}/images/${id}?visit=${encodeURIComponent(encounterId!)}`);
        }

        const [meta, link, saved] = await Promise.all([
          imageApi.get(id),
          imageApi.downloadUrl(id),
          imageApi.listAnnotations(id),
        ]);
        if (cancelled) return;
        setImage(meta);
        setLayers(saved.items);
        // A diagram drawn from S07 reopens with its latest drawing on it, ready to add to.
        const latest = saved.items[0];
        if (meta.diagramTemplate && latest && Array.isArray(latest.konvaData?.shapes)) {
          setShapes(latest.konvaData.shapes);
          setBasedOn(latest.version);
        }

        // The presigned link is short-lived, so decode it into a bitmap now.
        decode(link.url);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Could not open this image.');
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [imageId, patientId, encounterId, template]);

  const scale = bitmap ? Math.min(1, MAX_DISPLAY_WIDTH / bitmap.naturalWidth) : 1;
  const displayWidth = bitmap ? bitmap.naturalWidth * scale : 0;
  const displayHeight = bitmap ? bitmap.naturalHeight * scale : 0;

  /** Pointer position in the image's own pixels. */
  const pointIn = useCallback(
    (stage: Konva.Stage | null): [number, number] | null => {
      const pos = stage?.getPointerPosition();
      if (!pos) return null;
      return [pos.x / scale, pos.y / scale];
    },
    [scale],
  );

  /* ----------------------------- Drawing ---------------------------------- */

  function start(e: Konva.KonvaEventObject<MouseEvent | TouchEvent>) {
    const at = pointIn(e.target.getStage());
    if (!at) return;

    if (tool === 'text') {
      const text = label.trim();
      if (!text) {
        setError('Type the label first, then tap where it goes.');
        return;
      }
      setError(null);
      // Font size tracks stroke width so the toolbar has one size control.
      setShapes((prev) => [
        ...prev,
        { kind: 'text', x: at[0], y: at[1], text, color, fontSize: strokeWidth * 6 },
      ]);
      return;
    }

    drawing.current = true;
    setShapes((prev) => [
      ...prev,
      tool === 'pen'
        ? { kind: 'pen', points: [at[0], at[1]], color, width: strokeWidth }
        : { kind: 'arrow', points: [at[0], at[1], at[0], at[1]], color, width: strokeWidth },
    ]);
  }

  function move(e: Konva.KonvaEventObject<MouseEvent | TouchEvent>) {
    if (!drawing.current) return;
    const at = pointIn(e.target.getStage());
    if (!at) return;

    setShapes((prev) => {
      const last = prev[prev.length - 1];
      if (!last) return prev;
      const rest = prev.slice(0, -1);

      if (last.kind === 'pen') {
        return [...rest, { ...last, points: [...last.points, at[0], at[1]] }];
      }
      if (last.kind === 'arrow') {
        // An arrow is only ever start and end, so replace the end point.
        return [...rest, { ...last, points: [last.points[0]!, last.points[1]!, at[0], at[1]] }];
      }
      return prev;
    });
  }

  function end() {
    drawing.current = false;
  }

  /* ----------------------------- Actions ---------------------------------- */

  function undo() {
    setShapes((prev) => prev.slice(0, -1));
  }

  function clear() {
    setShapes([]);
    setBasedOn(null);
  }

  /** Open a saved layer as the starting point. Saving still makes a new one. */
  function loadLayer(layer: ImageAnnotation) {
    const data = layer.konvaData;
    setShapes(Array.isArray(data?.shapes) ? data.shapes : []);
    setBasedOn(layer.version);
    setNotice(`Showing version ${layer.version}. Saving will add a new version.`);
  }

  async function save() {
    if (!bitmap) return;
    if (shapes.length === 0) {
      setError('Nothing drawn yet.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const data: AnnotationData = {
        schema: 1,
        width: bitmap.naturalWidth,
        height: bitmap.naturalHeight,
        shapes,
      };
      let id = currentId;
      if (!id) {
        // First save of a new diagram drawing: clone the blank diagram into a visit-linked image.
        if (!template || !encounterId) throw new Error('Choose an image to draw on.');
        const png = await rasterize(bitmap);
        const created = await imageApi.upload({
          patientId,
          file: new File([png], `${template.toLowerCase().replace('_', '-')}.png`, { type: 'image/png' }),
          caption: EYE_TEMPLATE_LABEL[template],
          encounterId,
          diagramTemplate: template,
        });
        id = created.id;
        setCurrentId(id);
        setImage(created);
        // Reopening this page now opens the saved drawing rather than starting another.
        window.history.replaceState(null, '', `#/patients/${patientId}/images/${id}?visit=${encodeURIComponent(encounterId)}`);
      }
      const saved = await imageApi.saveAnnotation(id, data);
      const refreshed = await imageApi.listAnnotations(id);
      setLayers(refreshed.items);
      setBasedOn(saved.version);
      setNotice(`Saved as version ${saved.version}. The image itself is unchanged.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the drawing.');
    } finally {
      setBusy(false);
    }
  }

  /* ----------------------------- Render ----------------------------------- */

  return (
    <>
      <p className="crumbs">
        {encounterId ? (
          <a href={`#/patients/${patientId}/visits/${encounterId}`}>Consultation note</a>
        ) : (
          <a href={`#/patients/${patientId}/images`}>Clinical Images</a>
        )}{' '}
        / Draw
      </p>

      <h1>{image?.caption || image?.fileName || (template ? EYE_TEMPLATE_LABEL[template] : 'Image')}</h1>
      {encounterId && (
        <p>
          <a className="btn" href={`#/patients/${patientId}/visits/${encounterId}`}>
            ← Back to consultation note
          </a>
        </p>
      )}
      <p className="muted">
        Drawings save as a new layer. The uploaded image is never overwritten,
        so every earlier version stays available.
      </p>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}

      <div className="annotate-toolbar card">
        <fieldset className="plain">
          <legend className="label">Tool</legend>
          <div className="seg" role="radiogroup" aria-label="Tool">
            {(['pen', 'arrow', 'text'] as Tool[]).map((t) => (
              <button
                key={t}
                type="button"
                role="radio"
                aria-checked={tool === t}
                onClick={() => setTool(t)}
              >
                {t === 'pen' ? 'Pen' : t === 'arrow' ? 'Arrow' : 'Label'}
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset className="plain">
          <legend className="label">Color</legend>
          <div className="pills" role="radiogroup" aria-label="Color">
            {COLORS.map((c) => (
              <button
                key={c.value}
                type="button"
                role="radio"
                aria-checked={color === c.value}
                aria-label={c.label}
                className="swatch"
                style={{ background: c.value }}
                onClick={() => setColor(c.value)}
              />
            ))}
          </div>
        </fieldset>

        <fieldset className="plain">
          <legend className="label">
            Size <span className="muted small">({strokeWidth})</span>
          </legend>
          <input
            type="range"
            min={2}
            max={14}
            value={strokeWidth}
            aria-label="Stroke size"
            onChange={(e) => setStrokeWidth(Number(e.target.value))}
          />
        </fieldset>

        {tool === 'text' && (
          <fieldset className="plain grow">
            <legend className="label">Label text</legend>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              maxLength={60}
              placeholder="Type, then tap the image"
              aria-label="Label text"
            />
          </fieldset>
        )}

        <div className="row end grow">
          <button type="button" onClick={undo} disabled={shapes.length === 0}>
            Undo
          </button>
          <button type="button" onClick={clear} disabled={shapes.length === 0}>
            Clear
          </button>
          <button type="button" className="primary" onClick={() => void save()} disabled={busy}>
            {busy ? 'Saving...' : 'Save as new layer'}
          </button>
        </div>
      </div>

      {bitmap === null ? (
        <p className="muted">Loading image...</p>
      ) : (
        // touchAction none so drawing on the tablet does not scroll the page.
        <div className="annotate-canvas" style={{ touchAction: 'none' }}>
          <Stage
            width={displayWidth}
            height={displayHeight}
            scaleX={scale}
            scaleY={scale}
            onMouseDown={start}
            onMouseMove={move}
            onMouseUp={end}
            onMouseLeave={end}
            onTouchStart={start}
            onTouchMove={move}
            onTouchEnd={end}
          >
            <Layer listening={false}>
              <KonvaImage image={bitmap} />
            </Layer>
            <Layer listening={false}>
              {shapes.map((shape, i) => {
                if (shape.kind === 'pen') {
                  return (
                    <Line
                      key={i}
                      points={shape.points}
                      stroke={shape.color}
                      strokeWidth={shape.width}
                      lineCap="round"
                      lineJoin="round"
                      tension={0.4}
                    />
                  );
                }
                if (shape.kind === 'arrow') {
                  return (
                    <Arrow
                      key={i}
                      points={shape.points}
                      stroke={shape.color}
                      fill={shape.color}
                      strokeWidth={shape.width}
                      pointerLength={shape.width * 3}
                      pointerWidth={shape.width * 3}
                    />
                  );
                }
                return (
                  <Text
                    key={i}
                    x={shape.x}
                    y={shape.y}
                    text={shape.text}
                    fill={shape.color}
                    fontSize={shape.fontSize}
                    fontStyle="bold"
                  />
                );
              })}
            </Layer>
          </Stage>
        </div>
      )}

      <section className="card">
        <h2>Saved layers</h2>
        {layers.length === 0 ? (
          <p className="muted">No drawings saved for this image yet.</p>
        ) : (
          <ul className="layer-strip">
            {layers.map((layer) => (
              <li key={layer.id}>
                <button
                  type="button"
                  aria-pressed={basedOn === layer.version}
                  onClick={() => loadLayer(layer)}
                >
                  Version {layer.version}
                  <small className="muted">
                    {new Date(layer.createdAt).toLocaleString()}
                  </small>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
