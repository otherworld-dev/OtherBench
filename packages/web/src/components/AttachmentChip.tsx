import type { JSX } from 'react';

export interface AttachmentChipProps {
  filename: string;
  mime: string;
  /** Bytes, when known -- the composer has it from the upload response; a rendered historical message doesn't need it and can omit it. */
  size?: number;
  /** Renders a small thumbnail instead of a generic icon when the mime type is an image -- typically `api.attachments.contentUrl(id)`. */
  previewUrl?: string;
  /** Renders a remove ("×") button that calls this -- composer-only; omit for a read-only chip inside a rendered message. */
  onRemove?: () => void;
  /** Disables the remove button (still rendered, visibly inert) without hiding it -- e.g. while a send is in flight, so a click can't race the attachment being sent. Ignored when `onRemove` is omitted. */
  removeDisabled?: boolean;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * One attachment reference, task 21 decision #5: "a visible chip per
 * attachment". Used both inside the composer (with `onRemove`, before
 * sending) and inside a rendered `Message` (read-only, `onRemove` omitted)
 * -- see Composer.tsx and Message.tsx.
 */
export function AttachmentChip({ filename, mime, size, previewUrl, onRemove, removeDisabled }: AttachmentChipProps): JSX.Element {
  const isImage = mime.startsWith('image/');

  return (
    <span
      data-testid="attachment-chip"
      className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--bg-sunken)] py-1 pr-1 pl-2 text-xs"
    >
      {isImage && previewUrl ? (
        <img src={previewUrl} alt="" className="h-4 w-4 rounded-sm object-cover" />
      ) : (
        <span aria-hidden="true">{isImage ? '🖼️' : '📎'}</span>
      )}
      <span className="max-w-[12rem] truncate" title={filename}>
        {filename}
      </span>
      {size !== undefined && <span className="text-[var(--text-muted)]">{formatBytes(size)}</span>}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          disabled={removeDisabled}
          aria-label={`Remove ${filename}`}
          className="ml-0.5 rounded-full px-1 text-[var(--text-muted)] hover:bg-[var(--bg-raised)] hover:text-[var(--danger)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-[var(--text-muted)]"
        >
          ×
        </button>
      )}
    </span>
  );
}
