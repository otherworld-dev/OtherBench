import { useCallback, useEffect, useState, type JSX } from 'react';
import type { App } from '@otherbench/core/ports/store.js';
import { api, type ViewText } from '../state/api.js';
import { CodeView } from '../viewer/CodeView.js';
import { DirTree, type LoadDir } from '../viewer/FileTree.js';
import { languageOf } from '../viewer/ItemView.js';
import { viewerActionsFor } from '../viewer/ViewerContext.js';
import { codeErrorText, CodeErrorLine } from './CodeError.js';

const listFailure = (err: unknown): string => codeErrorText(err, "Couldn't list this folder.").message;

/**
 * The Code panel's Files tab (spec 2026-10-20-code-tab-design, Goal 4): the
 * app's folder as the viewer's own lazy tree, listed through the app's files
 * route rather than a chat's, so it works on the app home too. With an app
 * chat focused a file opens in that chat's viewer, exactly as a path in its
 * messages does (`viewerActionsFor(...).openPath`). With none (the app home)
 * there is no viewer to open it in, so it shows here read-only, read through
 * the app's own contained text route (controller ruling, Task 10).
 */
export function FilesTab({ app, chatId }: { app: App; chatId: string | null }): JSX.Element {
  const [shown, setShown] = useState<string | null>(null);
  const loadDir = useCallback<LoadDir>((path) => api.apps.files(app.id, path), [app.id]);
  // Another app's folder, or a chat appearing, starts again from the tree.
  useEffect(() => setShown(null), [app.id, chatId]);

  const open = (path: string): void => {
    if (chatId !== null) viewerActionsFor(chatId).openPath(path);
    else setShown(path);
  };

  if (shown !== null) return <ReadOnlyFile appId={app.id} path={shown} onBack={() => setShown(null)} />;
  return (
    <div data-testid="files-tab" className="-mx-2 min-w-0">
      <DirTree key={app.id} label={app.name} loadDir={loadDir} onOpen={open} describeError={listFailure} />
    </div>
  );
}

function ReadOnlyFile({ appId, path, onBack }: { appId: string; path: string; onBack: () => void }): JSX.Element {
  const [text, setText] = useState<ViewText | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    let cancelled = false;
    setText(null);
    setError(null);
    api.apps.text(appId, path).then(
      (r) => !cancelled && setText(r),
      (err: unknown) => !cancelled && setError(err)
    );
    return () => {
      cancelled = true;
    };
  }, [appId, path]);
  const name = path.split(/[\\/]/).pop() || path;
  return (
    <div data-testid="files-readonly" className="flex min-h-0 min-w-0 flex-col gap-2">
      <div className="flex items-center gap-2">
        <button type="button" onClick={onBack} aria-label="Back to files" className="shrink-0 text-xs text-[var(--text-muted)] hover:text-[var(--text)]">
          <span aria-hidden="true">← Files</span>
        </button>
        <span title={path} className="min-w-0 flex-1 truncate font-mono text-xs">
          {name}
        </span>
        <span className="shrink-0 text-xs text-[var(--text-faint)]">Read-only</span>
      </div>
      {error !== null ? (
        <CodeErrorLine error={error} fallback="Couldn't open this file." />
      ) : !text ? (
        <p className="text-sm text-[var(--text-faint)]">Loading…</p>
      ) : (
        <>
          {text.truncated && <p className="text-xs text-[var(--text-muted)]">Only the start of this file is shown.</p>}
          <div className="min-w-0 overflow-auto rounded-sm border border-[var(--border)]">
            <CodeView text={text.content} language={languageOf(name)} />
          </div>
        </>
      )}
    </div>
  );
}
