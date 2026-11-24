import EyeTemplatePicker from '../EyeTemplatePicker';
import { clinicalApi } from '../clinicalApi';
import { imagesPath } from '../imageApi';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import PatientPicker from '../PatientPicker';
import { go } from '../session';
import {
  IS_DRAWABLE,
  formatBytes,
  imageApi,
  type ClinicalImage,
  type ImageStatus,
} from '../imageApi';

/**
 * S09 Clinical Image Upload.
 *
 * Doctor only, the same as the endpoints behind it. JPEG and PNG can be drawn
 * on; a PDF is a referral or an outside report, so it opens for reading rather
 * than annotating.
 *
 * Nothing here deletes a file. "Remove" flips the row to DELETED and the
 * object stays in S3, because an image a diagnosis was written against has to
 * remain recoverable.
 */
const ACCEPT = 'image/jpeg,image/png,application/pdf';
const MAX_BYTES = 20 * 1024 * 1024;

export default function ClinicalImages({ patientId, visitId, appointmentId }: { patientId: string; visitId?: string; appointmentId?: string }) {
  const [images, setImages] = useState<ClinicalImage[] | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Removed images are kept, not destroyed, so they stay reachable here rather
  // than disappearing with no trace.
  const [status, setStatus] = useState<ImageStatus>('ACTIVE');

  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [walkInKey] = useState(() => crypto.randomUUID());
  const [visits, setVisits] = useState<Awaited<ReturnType<typeof clinicalApi.encounters>>['items']>([]);
  useEffect(() => {
    let active = true;
    clinicalApi.encounters(patientId).then(r => { if (active) setVisits(r.items); }, e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [patientId]);
  const selected = visits.find(v => visitId ? v.id === visitId : appointmentId && v.appointmentId === appointmentId);
  const currentVisit = visitId || selected?.id;
  const load = useCallback(async () => {
    setImages(undefined);
    try {
      const res = await imageApi.list(patientId, status, currentVisit, appointmentId, page);
      setTotal(res.total);
      setImages(res.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load images.');
      setImages([]);
    }
  }, [patientId, status, currentVisit, appointmentId, page]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <h1>Clinical Images</h1>
      <p className="muted">
        Photographs and outside reports for this patient. Drawings are saved as
        separate layers, so the original image is never changed.
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

      <label>Consultation visit
        <select value={currentVisit || ''} onChange={e => go(imagesPath(patientId, e.target.value || undefined))}>
          <option value="">{appointmentId ? 'Selected appointment' : 'Patient gallery and pre-visit uploads'}</option>
          {visits.map(v => <option key={v.id} value={v.id}>{v.visitDate} · {v.type} · {v.status} · {v.id.slice(-6)}</option>)}
        </select>
      </label>
      {currentVisit && <p><a href={`#/patients/${patientId}/visits/${currentVisit}`}>Return to consultation</a></p>}
      {selected?.status === 'OPEN' && <EyeTemplatePicker patientId={patientId} visitId={selected.id} />}
      {selected?.status !== 'SIGNED' && <UploadForm
        visitId={currentVisit} appointmentId={currentVisit ? undefined : appointmentId}
        walkInKey={currentVisit || appointmentId ? undefined : walkInKey}
        patientId={patientId}
        onUploaded={(image) => {
          setNotice(`Uploaded ${image.fileName}.`);
          void load();
        }}
        onError={setError}
      />}

      <div className="seg" role="radiogroup" aria-label="Which images to show">
        <button
          type="button"
          role="radio"
          aria-checked={status === 'ACTIVE'}
          onClick={() => { setPage(1); setStatus('ACTIVE'); }}
        >
          Current
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={status === 'DELETED'}
          onClick={() => { setPage(1); setStatus('DELETED'); }}
        >
          Removed
        </button>
      </div>

      {images === undefined ? (
        <p className="muted">Loading images...</p>
      ) : images.length === 0 ? (
        <p className="muted">
          {status === 'ACTIVE'
            ? 'No images for this patient yet.'
            : 'Nothing has been removed for this patient.'}
        </p>
      ) : (
        <ul className="image-list">
          {images.map((image) => (
            <ImageRow
              key={image.id}
              image={image}
              patientId={patientId}
              removed={status === 'DELETED'}
              onChanged={(message) => {
                setNotice(message);
                void load();
              }}
              onError={setError}
            />
          ))}
        </ul>
      )}
      {total > 100 && <div className="row"><button disabled={page === 1} onClick={() => setPage(page - 1)}>Previous</button>
        <span>Page {page} of {Math.ceil(total / 100)}</span><button disabled={page * 100 >= total} onClick={() => setPage(page + 1)}>Next</button></div>}
    </>
  );
}

/* ------------------------------- Upload ---------------------------------- */

function UploadForm({
  patientId, visitId, appointmentId, walkInKey,
  onUploaded,
  onError,
}: {
  patientId: string;
  visitId?: string; appointmentId?: string; walkInKey?: string;
  onUploaded: (image: ClinicalImage) => void;
  onError: (message: string) => void;
}) {
  const [caption, setCaption] = useState('');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) {
      onError('Choose a file to upload.');
      return;
    }
    // Checked here as well as on the server so a 20 MB fundus photo does not
    // travel the whole way up only to be refused.
    if (file.size > MAX_BYTES) {
      onError(`${file.name} is ${formatBytes(file.size)}; the limit is 20 MB.`);
      return;
    }

    setBusy(true);
    try {
      const image = await imageApi.upload({
        patientId, visitId, appointmentId, walkInKey,
        file,
        caption: caption.trim() || undefined,
      });
      setCaption('');
      if (fileRef.current) fileRef.current.value = '';
      onUploaded(image);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Upload failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card image-upload" onSubmit={submit}>
      <h2>Add an image</h2>

      <label htmlFor="image-file">File</label>
      <input id="image-file" type="file" accept={ACCEPT} ref={fileRef} required />
      <p className="muted small">JPEG, PNG or PDF, up to 20 MB.</p>

      <label htmlFor="image-caption">Caption</label>
      <input
        id="image-caption"
        value={caption}
        onChange={(e) => setCaption(e.target.value)}
        maxLength={200}
        placeholder="Fundus OD, baseline"
      />

      <button type="submit" className="primary" disabled={busy}>
        {busy ? 'Uploading...' : 'Upload'}
      </button>
    </form>
  );
}

/* ------------------------------- One row --------------------------------- */

function ImageRow({
  image,
  patientId,
  removed,
  onChanged,
  onError,
}: {
  image: ClinicalImage;
  patientId: string;
  removed: boolean;
  onChanged: (message: string) => void;
  onError: (message: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [caption, setCaption] = useState(image.caption ?? '');
  const [busy, setBusy] = useState(false);
  // Two steps rather than one, because an image a diagnosis was written
  // against should not leave the list on a stray tap.
  const [confirming, setConfirming] = useState(false);

  /**
   * Presigned links expire in five minutes, so fetch one at the moment of the
   * click rather than holding it in the page.
   */
  async function open() {
    try {
      window.open(imageApi.contentUrl(image.id, { patientId, visitId: image.visitId || undefined }), '_blank', 'noopener,noreferrer');
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not open the file.');
    }
  }

  async function saveCaption(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await imageApi.setCaption(image.id, { patientId, visitId: image.visitId || undefined }, caption.trim() || null);
      setEditing(false);
      onChanged('Caption saved.');
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not save the caption.');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await imageApi.remove(image.id, { patientId, visitId: image.visitId || undefined });
      onChanged(`Removed ${image.fileName}. It is still available under Removed.`);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not remove the image.');
    } finally {
      setBusy(false);
    }
  }

  const drawable = IS_DRAWABLE(image.mimeType);

  return (
    <li className="card image-row">
      <div className="image-row-main">
        <strong>{image.caption || image.fileName}</strong>
        <p className="muted small">
          {image.fileName} · {formatBytes(image.sizeBytes)} ·{' '}
          {new Date(image.createdAt).toLocaleString()}
        </p>
      </div>

      {editing ? (
        <form className="row" onSubmit={saveCaption}>
          <input
            aria-label={`Caption for ${image.fileName}`}
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            maxLength={200}
          />
          <button type="submit" className="primary" disabled={busy}>
            Save
          </button>
          <button type="button" onClick={() => setEditing(false)} disabled={busy}>
            Cancel
          </button>
        </form>
      ) : removed ? (
        // A removed image is still here, and still openable, but nothing can
        // be changed about it from this screen.
        <div className="row image-row-actions">
          <span className="badge">Removed</span>
          <button type="button" onClick={() => void open()}>
            Open
          </button>
        </div>
      ) : confirming ? (
        <div className="row image-row-actions">
          <span className="muted small">Remove from the current list?</span>
          <button type="button" className="primary" onClick={() => void remove()} disabled={busy}>
            {busy ? 'Removing...' : 'Yes, remove'}
          </button>
          <button type="button" onClick={() => setConfirming(false)} disabled={busy}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="row image-row-actions">
          {!image.visitId && image.walkInKey && <button type="button" disabled={busy} onClick={async () => {
            setBusy(true);
            try {
              const visit = await clinicalApi.startVisit({ patientId, type: 'WALK_IN', walkInKey: image.walkInKey! });
              go(`/patients/${patientId}/visits/${visit.id}`);
            } catch (e) { onError(e instanceof Error ? e.message : 'Could not open walk-in visit'); }
            finally { setBusy(false); }
          }}>Start walk-in for this upload group</button>}
          {drawable ? (
            <button
              type="button"
              className="primary"
              onClick={() => go(imagesPath(patientId, image.visitId ?? undefined, image.id))}
            >
              Draw
            </button>
          ) : (
            // A PDF would have to be rasterized before it could be drawn on,
            // so it opens for reading instead.
            <span className="muted small">PDF, view only</span>
          )}
          <button type="button" onClick={() => void open()}>
            Open
          </button>
          <button type="button" onClick={() => setEditing(true)}>
            Caption
          </button>
          <button type="button" onClick={() => setConfirming(true)}>
            Remove
          </button>
        </div>
      )}
    </li>
  );
}

/**
 * Reached from the sidebar, where no patient is chosen yet. Mirrors
 * MedicationsLanding: pick a patient and go straight to their images.
 */
export function ClinicalImagesLanding() {
  return (
    <>
      <h1>Clinical Images</h1>
      <p className="muted">Choose a patient to see their images and drawings.</p>
      <section className="card" style={{ maxWidth: 520 }}>
        <label htmlFor="image-patient">Patient</label>
        <PatientPicker id="image-patient" onChange={(p) => p && go(`/patients/${p.id}/images`)} />
      </section>
    </>
  );
}
