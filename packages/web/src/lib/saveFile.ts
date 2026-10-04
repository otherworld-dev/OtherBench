/**
 * Hands `blob` to the browser as a download named `filename`. Works the same
 * in a browser tab and in the desktop window (WebView2 saves it to
 * Downloads), where the API needs a bearer token, so a plain link to the
 * route can't be used: the caller fetches with auth and passes the body here.
 */
export function saveFile(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoked after the click has had a chance to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
