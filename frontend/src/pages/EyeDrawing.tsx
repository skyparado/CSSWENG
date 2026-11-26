import { useCallback, useEffect, useRef, useState } from 'react';
import type { DiagramTemplate } from '@clinic/schemas';
import { go } from '../session';
import { EYE_TEMPLATE_LABEL, eyeTemplateUrl, imageApi, type ClinicalImage, type Shape } from '../imageApi';

/**
 * S07 item 7: eye drawing area.
 *
 * Outline diagrams of the right (OD) and left (OS) eye, anterior or posterior
 * segment, from the blank templates in backend/assets/eye-templates. Where this
 * visit already has a saved drawing, its small picture (template plus the latest
 * saved layer) is shown in place of the blank diagram.
 *
 * "Open Drawing" saves the note draft first, then opens S09 for this patient and
 * visit, either on the visit's existing drawing for that diagram or on a new one
 * (nothing is stored until the first save in S09). When the doctor returns, the
 * pictures are fetched again. On a signed note the buttons are gone and the
 * drawings stay on show, read-only.
 */

type Segment = 'ANTERIOR' | 'POSTERIOR';

const SEGMENTS: Segment[] = ['ANTERIOR', 'POSTERIOR'];
const SEGMENT_LABEL: Record<Segment, string> = { ANTERIOR: 'Anterior segment', POSTERIOR: 'Posterior segment' };
const EYES = [
  { eye: 'OD', label: 'Right eye (OD)' },
  { eye: 'OS', label: 'Left eye (OS)' },
] as const;

interface Drawing {
  image: ClinicalImage;
  shapes: Shape[];
}

const pairs = (points: number[]) => {
  const out: string[] = [];
  for (let i = 0; i + 1 < points.length; i += 2) out.push(`${points[i]},${points[i + 1]}`);
  return out.join(' ');
};

/** One saved mark, drawn in the image's own 800 × 600 coordinates. */
function Mark({ shape }: { shape: Shape }) {
  if (shape.kind === 'pen') {
    // A single tap has no length to stroke; draw it as a dot.
    if (shape.points.length < 4) {
      return <circle cx={shape.points[0]} cy={shape.points[1]} r={shape.width / 2} fill={shape.color} />;
    }
    return (
      <polyline
        points={pairs(shape.points)}
        fill="none"
        stroke={shape.color}
        strokeWidth={shape.width}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    );
  }
  if (shape.kind === 'arrow') {
    const [x1 = 0, y1 = 0, x2 = 0, y2 = 0] = shape.points;
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const len = shape.width * 3;
    const head = [0, 1, -1].map((side) => {
      if (side === 0) return `${x2},${y2}`;
      const a = angle + side * (Math.PI - Math.PI / 6);
      return `${x2 + len * Math.cos(a)},${y2 + len * Math.sin(a)}`;
    });
    return (
      <>
        <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={shape.color} strokeWidth={shape.width} strokeLinecap="round" />
        <polygon points={head.join(' ')} fill={shape.color} />
      </>
    );
  }
  return (
    <text x={shape.x} y={shape.y + shape.fontSize * 0.8} fill={shape.color} fontSize={shape.fontSize} fontWeight="bold">
      {shape.text}
    </text>
  );
}

/** The blank diagram with the latest saved layer drawn over it, as a small picture. */
function DiagramPreview({ template, shapes }: { template: DiagramTemplate; shapes: Shape[] }) {
  const drawn = shapes.length > 0;
  return (
    <svg
      viewBox="0 0 800 600"
      role="img"
      aria-label={`${EYE_TEMPLATE_LABEL[template]}: ${drawn ? 'saved drawing' : 'blank diagram'}`}
      data-drawn={drawn}
    >
      <image href={eyeTemplateUrl(template)} width="800" height="600" />
      {shapes.map((shape, i) => (
        <Mark key={i} shape={shape} />
      ))}
    </svg>
  );
}

export default function EyeDrawing({
  patientId,
  encounterId,
  locked,
  beforeOpen,
}: {
  patientId: string;
  encounterId: string;
  locked: boolean;
  /** Save the note draft. Resolves false if it could not be saved, so the doctor stays on the note. */
  beforeOpen: () => Promise<boolean>;
}) {
  const [drawings, setDrawings] = useState<Partial<Record<DiagramTemplate, Drawing>>>({});
  const [segment, setSegment] = useState<Segment>('ANTERIOR');
  const [opening, setOpening] = useState<DiagramTemplate>();
  const [error, setError] = useState<string>();
  const chosenSegment = useRef(false);

  /** This visit's drawings: the newest image per diagram, with its latest saved layer. */
  const load = useCallback(async () => {
    try {
      const { items } = await imageApi.list(patientId, 'ACTIVE', encounterId);
      const newest = new Map<DiagramTemplate, ClinicalImage>();
      for (const image of items) if (image.diagramTemplate && !newest.has(image.diagramTemplate)) newest.set(image.diagramTemplate, image);

      const found: Partial<Record<DiagramTemplate, Drawing>> = {};
      await Promise.all(
        [...newest].map(async ([template, image]) => {
          const layer = await imageApi.latestAnnotation(image.id);
          const shapes = layer && Array.isArray(layer.konvaData?.shapes) ? layer.konvaData.shapes : [];
          found[template] = { image, shapes };
        }),
      );
      setDrawings(found);
      setError(undefined);

      // Open on the segment that has a drawing, if only one does.
      if (!chosenSegment.current) {
        const drawn = (s: Segment) => EYES.some(({ eye }) => (found[`${s}_${eye}` as DiagramTemplate]?.shapes.length ?? 0) > 0);
        if (drawn('POSTERIOR') && !drawn('ANTERIOR')) setSegment('POSTERIOR');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load this visit’s drawings.');
    }
  }, [patientId, encounterId]);

  useEffect(() => {
    void load();
    // Fetch again when the doctor comes back to this tab or page (for example from S09).
    const refresh = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('pageshow', refresh);
    return () => {
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('pageshow', refresh);
    };
  }, [load]);

  const open = async (template: DiagramTemplate) => {
    setOpening(template);
    setError(undefined);
    try {
      if (!(await beforeOpen())) return; // the draft could not be saved: stay, the note shows why
      const existing = drawings[template];
      go(
        existing
          ? `/patients/${patientId}/images/${existing.image.id}?visit=${encounterId}`
          : `/patients/${patientId}/images?visit=${encounterId}&template=${template}`,
      );
    } finally {
      setOpening(undefined);
    }
  };

  const count = (s: Segment) => EYES.filter(({ eye }) => (drawings[`${s}_${eye}` as DiagramTemplate]?.shapes.length ?? 0) > 0).length;
  const any = SEGMENTS.some((s) => count(s) > 0);

  return (
    <section className="card eye-drawing">
      <div className="row between">
        <h2>Eye drawing and images</h2>
        {!locked && <a href={`#/patients/${patientId}/images?visit=${encounterId}`}>Upload image</a>}
      </div>
      <p className="muted small">
        {locked
          ? any
            ? 'This note is signed, so its drawings are read-only.'
            : 'This note is signed. No drawings were saved for this visit.'
          : 'Draw on an eye diagram on the tablet. Your note is saved first, and the drawing appears here when you come back.'}
      </p>

      <div className="seg" role="group" aria-label="Eye segment">
        {SEGMENTS.map((s) => (
          <button key={s} type="button" aria-pressed={segment === s} onClick={() => { chosenSegment.current = true; setSegment(s); }}>
            {SEGMENT_LABEL[s]}
            {count(s) > 0 && <span className="muted small"> · {count(s)} drawn</span>}
          </button>
        ))}
      </div>

      <div className="eye-pair">
        {EYES.map(({ eye, label }) => {
          const template = `${segment}_${eye}` as DiagramTemplate;
          const drawing = drawings[template];
          return (
            <figure key={template} className="eye-figure">
              <DiagramPreview template={template} shapes={drawing?.shapes ?? []} />
              <figcaption>
                <strong>{label}</strong>
                <span className="muted small"> · {drawing && drawing.shapes.length > 0 ? 'Drawing saved' : 'Blank diagram'}</span>
              </figcaption>
              {!locked && (
                <button
                  type="button"
                  className="primary"
                  disabled={opening !== undefined}
                  onClick={() => void open(template)}
                  aria-label={`Open drawing — ${EYE_TEMPLATE_LABEL[template]}`}
                >
                  {opening === template ? 'Saving note…' : 'Open Drawing'}
                </button>
              )}
            </figure>
          );
        })}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
