import { useEffect, useRef, type JSX } from 'react';
import { createPortal } from 'react-dom';
import { AuthedImage } from './AuthedImage.js';

/**
 * An image at full size over the whole window. Portalled to the body, so it stays on top wherever it was opened from: a
 * stacking context around a chip in the composer, a message or a note can't cover it.
 */
export function ImageLightbox({ src, label, onClose }: { src: string; label: string; onClose: () => void }): JSX.Element {
  const closeRef = useRef<HTMLButtonElement>(null);
  // Focus goes into the dialog, and back to whatever opened it when it closes.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    return () => opener?.focus();
  }, []);
  useEffect(() => {
    // Caught on the way down and kept here: Escape would otherwise also hide the Quick Chat window.
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      e.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={label}
      data-testid="image-lightbox"
      // React events still bubble through a portal, so a click here stays away from the message or composer behind it.
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
    >
      <button ref={closeRef} type="button" aria-label="Close" onClick={onClose} className="btn absolute top-3 right-3 px-2 py-1">
        Close
      </button>
      <AuthedImage src={src} alt={`${label}, full size`} data-testid="image-lightbox-full" onClick={(e) => e.stopPropagation()} className="max-h-full max-w-full object-contain" />
    </div>,
    document.body,
  );
}
