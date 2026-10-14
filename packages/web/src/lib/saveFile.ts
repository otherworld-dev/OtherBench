import { isMainWindowFocused, saveDownload, showNotification } from '../desktop/bridge.js';
import { toast } from './toasts.js';

/**
 * Saves `blob` as a download named `filename` and says where it went. The API needs a bearer token, so a
 * plain link to the route can't be used: the caller fetches with auth and passes the body here.
 *
 * In the desktop app the shell writes it into Downloads (desktop/src-tauri/src/download.rs) and returns
 * the path, so the toast can offer "Show in folder"; when the window isn't focused a desktop
 * notification says so too, and clicking it shows the file. In a browser the browser saves it, without
 * telling the page where, so the toast just names the file. Never throws: a failure is a toast too.
 */
export async function saveFile(blob: Blob, filename: string): Promise<void> {
  let path: string | null;
  try {
    path = await saveDownload(blob, filename);
  } catch (err) {
    toast({ tone: 'error', text: `Couldn't save ${filename}: ${err instanceof Error ? err.message : String(err)}` });
    return;
  }
  if (path === null) {
    browserDownload(blob, filename);
    toast({ tone: 'ok', text: `Downloaded ${filename}` });
    return;
  }
  const name = path.split(/[\\/]/).pop() ?? filename;
  toast({ tone: 'ok', text: `Downloaded ${name} to Downloads`, path });
  try {
    if (!(await isMainWindowFocused())) await showNotification('Download complete', `${name} is in your Downloads folder. Click to show it.`, null, path);
  } catch (err) {
    console.error('[grunt-web] download notification failed:', err);
  }
}

function browserDownload(blob: Blob, filename: string): void {
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
