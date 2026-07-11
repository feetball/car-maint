import { useEffect, useRef, useState } from 'react';
import { api } from '../../api.js';
import ConfirmDialog from '../../components/ConfirmDialog.jsx';
import Icon from '../../components/Icon.jsx';
import { EmptyState, ErrorBanner, Loading } from '../../components/ui.jsx';

export default function PhotosTab({ vehicle, onChanged }) {
  const photos = vehicle.photos || [];
  const inputRef = useRef(null);
  const [dragActive, setDragActive] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState(null);
  const [lightbox, setLightbox] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!lightbox) return undefined;
    function onKey(event) {
      if (event.key === 'Escape') setLightbox(null);
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [lightbox]);

  async function upload(fileList) {
    const files = Array.from(fileList || []).filter((f) => f.type.startsWith('image/'));
    if (files.length === 0) return;
    setUploading(true);
    setError(null);
    try {
      await api.uploadPhotos(vehicle.id, files.slice(0, 10));
      await onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
    }
  }

  async function makePrimary(photo) {
    setError(null);
    try {
      await api.setPrimaryPhoto(photo.id);
      await onChanged();
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleDelete() {
    setBusy(true);
    setError(null);
    try {
      await api.deletePhoto(pendingDelete.id);
      setPendingDelete(null);
      await onChanged();
    } catch (err) {
      setError(err.message);
      setPendingDelete(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Photos" className="photos-tab">
      {error && <ErrorBanner message={error} />}

      <div
        className={`dropzone${dragActive ? ' dropzone--active' : ''}`}
        role="button"
        tabIndex={0}
        aria-label="Add photos"
        onClick={() => inputRef.current?.click()}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            inputRef.current?.click();
          }
        }}
        onDragOver={(event) => {
          event.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragActive(false);
          upload(event.dataTransfer.files);
        }}
      >
        <Icon name="upload" size={22} />
        <p className="dropzone__title">
          <strong>Add photos</strong>
          <span className="dropzone__desktop-hint"> — click to browse or drag &amp; drop</span>
          <span className="dropzone__touch-hint"> — tap to use your camera or library</span>
        </p>
        <p className="dropzone__hint">JPEG, PNG, WebP, or GIF · up to 10 at a time · 10 MB each</p>
        {uploading && <Loading label="Uploading…" />}
        {/* No `capture` attribute: iOS then offers both camera and photo library. */}
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(event) => {
            upload(event.target.files);
            event.target.value = '';
          }}
        />
      </div>

      {photos.length === 0 ? (
        <EmptyState
          icon="camera"
          title="No photos yet"
          message="Add a few shots — the first upload becomes this vehicle's card photo."
        />
      ) : (
        <ul className="photo-grid">
          {photos.map((photo) => (
            <li key={photo.id} className="photo-tile">
              <button
                type="button"
                className="photo-tile__open"
                onClick={() => setLightbox(photo)}
                aria-label={`View ${photo.original_name || 'photo'} full size`}
              >
                <img
                  src={`/photos/${photo.filename}`}
                  alt={photo.original_name || 'Vehicle photo'}
                  loading="lazy"
                />
              </button>
              {photo.is_primary ? (
                <span className="photo-tile__badge">
                  <Icon name="star" size={11} filled /> Primary
                </span>
              ) : null}
              <div className="photo-tile__actions">
                {!photo.is_primary && (
                  <button
                    type="button"
                    className="icon-button"
                    aria-label="Set as primary photo"
                    title="Set as primary"
                    onClick={() => makePrimary(photo)}
                  >
                    <Icon name="star" size={15} />
                  </button>
                )}
                <button
                  type="button"
                  className="icon-button icon-button--danger"
                  aria-label="Delete photo"
                  title="Delete photo"
                  onClick={() => setPendingDelete(photo)}
                >
                  <Icon name="trash" size={15} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {lightbox && (
        <div
          className="lightbox"
          role="dialog"
          aria-modal="true"
          aria-label="Photo viewer"
          onClick={() => setLightbox(null)}
        >
          <button
            type="button"
            className="lightbox__close icon-button"
            aria-label="Close photo viewer"
            onClick={() => setLightbox(null)}
          >
            <Icon name="x" size={20} />
          </button>
          <img
            src={`/photos/${lightbox.filename}`}
            alt={lightbox.original_name || 'Vehicle photo'}
            onClick={(event) => event.stopPropagation()}
          />
        </div>
      )}

      {pendingDelete && (
        <ConfirmDialog
          title="Delete photo"
          message="This photo will be permanently removed."
          busy={busy}
          onConfirm={handleDelete}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </section>
  );
}
