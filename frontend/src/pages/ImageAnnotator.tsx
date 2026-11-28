import { randomId } from '../randomId';
import { eyeTemplateLabels, type EyeTemplate } from '@clinic/schemas';
import { imagesPath } from '../imageApi';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Arrow, Image as KonvaImage, Layer, Line, Stage, Text } from 'react-konva';
import type Konva from 'konva';
import {
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

/** How long after stylus contact a touch is treated as a resting palm. */
const PALM_WINDOW_MS = 800;

const COLORS = [
  { value: '#e23b3b', label: 'Red' },
  { value: '#f5a524', label: 'Amber' },
  { value: '#2f7d32', label: 'Green' },
  { value: '#1e5fb4', label: 'Blue' },
  { value: '#ffffff', label: 'White' },
];

type Tool = 'pen' | 'arrow' | 'text';

export default function ImageAnnotator({
  patientId,
  imageId, visitId, templateType,
}: {
  patientId: string;
  imageId: string;
  visitId?: string;
  templateType?: EyeTemplate;
}) {
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
  // The one pointer drawing the current stroke, so a second finger or a resting
  // palm cannot add points to it or start a stroke of its own.
  const activePointer = useRef<{ id: number; type: string } | null>(null);
  // Last time an Apple Pencil or other stylus touched the canvas.
  const lastPenAt = useRef(0);
  const saving = useRef(false);
  const saveTouch = useRef<{ id: number; x: number; y: number } | null>(null);
  const savedOnTouch = useRef(false);
  const [commitKey] = useState(() => randomId());
  const container = useRef<HTMLDivElement>(null);
  const [availableWidth, setAvailableWidth] = useState(0);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setAvailableWidth(entry!.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  /* ----------------------------- Loading ---------------------------------- */

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const context = { patientId, visitId };
        let url: string;
        if (templateType && visitId && imageId === 'new') {
          url = imageApi.templateUrl(templateType, context);
        } else {
          const [meta, saved] = await Promise.all([imageApi.get(imageId, context), imageApi.listAnnotations(imageId, context)]);
          if (cancelled) return;
          setImage(meta);
          setLayers(saved.items);
          const latest = saved.items[0];
          if (latest) {
            setShapes(Array.isArray(latest.konvaData?.shapes) ? latest.konvaData.shapes : []);
            setBasedOn(latest.version);
          }
          url = imageApi.contentUrl(imageId, context);
        }
        const el = new window.Image();
        el.onload = () => {
          if (!cancelled) setBitmap(el);
        };
        el.onerror = () => {
          if (!cancelled) setError('The image could not be loaded from storage.');
        };
        el.src = url;
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
  }, [imageId, patientId, visitId, templateType]);

  const scale = bitmap ? Math.min(1, Math.min(MAX_DISPLAY_WIDTH, availableWidth) / bitmap.naturalWidth, 1200 / bitmap.naturalHeight) : 1;
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

  function start(e: Konva.KonvaEventObject<PointerEvent>) {
    const evt = e.evt;
    const pen = evt.pointerType === 'pen';
    if (pen) lastPenAt.current = Date.now();
    // Palm rejection: a hand resting on the screen while writing with a stylus
    // arrives as touch. Ignore touch shortly after stylus use.
    else if (evt.pointerType === 'touch' && Date.now() - lastPenAt.current < PALM_WINDOW_MS) return;

    // Already drawing. A stylus taking over from a stroke that a palm started
    // replaces that stroke; any other second pointer is ignored.
    let replacePalmStroke = false;
    if (drawing.current && activePointer.current) {
      if (!(pen && activePointer.current.type === 'touch')) return;
      replacePalmStroke = true;
    }

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
    activePointer.current = { id: evt.pointerId, type: evt.pointerType };
    setShapes((prev) => [
      ...(replacePalmStroke ? prev.slice(0, -1) : prev),
      tool === 'pen'
        ? { kind: 'pen', points: [at[0], at[1], at[0], at[1]], color, width: strokeWidth }
        : { kind: 'arrow', points: [at[0], at[1], at[0], at[1]], color, width: strokeWidth },
    ]);
  }

  function move(e: Konva.KonvaEventObject<PointerEvent>) {
    if (!drawing.current || e.evt.pointerId !== activePointer.current?.id) return;
    if (e.evt.pointerType === 'pen') lastPenAt.current = Date.now();
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

  function end(e: Konva.KonvaEventObject<PointerEvent>) {
    // Lifting a palm or a second finger must not end the stylus stroke.
    if (activePointer.current && e.evt.pointerId !== activePointer.current.id) return;
    if (e.evt.pointerType === 'pen') lastPenAt.current = Date.now();
    drawing.current = false;
    activePointer.current = null;
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
    if (!bitmap || saving.current) return;
    if (!templateType && !layers.length && shapes.length === 0) {
      setError('Nothing drawn yet.');
      return;
    }
    saving.current = true;
    setBusy(true);
    setError(null);
    try {
      const data: AnnotationData = {
        schema: 1,
        width: bitmap.naturalWidth,
        height: bitmap.naturalHeight,
        shapes,
      };
      const context = { patientId, visitId };
      if (templateType) {
        const created = await imageApi.commit({ ...context, templateType, commitKey, konvaData: data });
        window.location.replace('#' + imagesPath(patientId, visitId, created.id));
        return;
      }
      const saved = await imageApi.saveAnnotation(imageId, context, data);
      setLayers(previous => [saved, ...previous]);
      setBasedOn(saved.version);
      setNotice(`Saved as version ${saved.version}. The image itself is unchanged.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the drawing.');
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }

  /* ----------------------------- Render ----------------------------------- */

  return (
    <>
      <p className="crumbs">
        <a href={'#' + imagesPath(patientId, visitId)}>Clinical Images</a> / Draw
      </p>

      <h1>{templateType ? eyeTemplateLabels[templateType] : image?.caption || image?.fileName || 'Image'}</h1>
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
          <button type="button" className="primary" disabled={busy || !bitmap}
            onPointerDown={e => {
              savedOnTouch.current = false;
              // Finger or stylus (Apple Pencil reports 'pen'); a mouse uses the click below.
              saveTouch.current = e.pointerType !== 'mouse' ? { id: e.pointerId, x: e.clientX, y: e.clientY } : null;
            }}
            onPointerCancel={() => { saveTouch.current = null; }}
            onPointerUp={e => {
              const start = saveTouch.current;
              saveTouch.current = null;
              if (!start || start.id !== e.pointerId || Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) return;
              // Mobile Chrome can suppress the compatibility click immediately
              // after a canvas drag. Commit a stationary touch release once.
              savedOnTouch.current = true;
              void save();
            }}
            onClick={e => { if (e.detail === 0 || !savedOnTouch.current) void save(); }}
          >
            {busy ? 'Saving...' : 'Save as new layer'}
          </button>
        </div>
      </div>

      <div ref={container} className="drawing-area">
      {bitmap === null ? (
        <p className="muted">Loading image...</p>
      ) : (
        // touchAction none so drawing on the tablet does not scroll the page.
        // The annotate-canvas CSS also stops iPad Safari's long-press callout and text selection.
        <div className="annotate-canvas" style={{ touchAction: 'none' }}>
          <Stage
            width={displayWidth}
            height={displayHeight}
            scaleX={scale}
            scaleY={scale}
            onPointerDown={start}
            onPointerMove={move}
            onPointerUp={end}
            onPointerLeave={end}
            onPointerCancel={end}
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

      </div>
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
