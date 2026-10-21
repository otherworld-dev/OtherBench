// First: moves Grunt's saved preferences to their new keys before anything reads one.
import './lib/legacyStorage.js';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Root } from './Root.js';
import { desktopBootstrap, isIndicatorView } from './desktop/bridge.js';
import { configureTransport } from './state/transport.js';
import { keepOtherBenchTitle } from './lib/otherBenchTitle.js';
import { initSidebarWidth } from './state/sidebarWidth.js';
import { codePanelWidth } from './state/panelWidth.js';
import { initTextSize } from './state/textSize.js';
import './index.css';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root element missing from index.html');

// Computer use refuses any window whose title carries OtherBench's marker, so a
// browser showing this page can't be used to answer OtherBench's own cards.
keepOtherBenchTitle();

// Apply the saved text size, sidebar width and Code panel width before first paint.
initTextSize();
initSidebarWidth();
codePanelWidth.init();

const root = createRoot(rootEl);

// In the desktop app the API lives on the sidecar's port, not this page's
// origin, so the transport must be configured before the first request.
// In a browser this resolves to null straight away. The computer-use
// indicator bar needs no server and may not ask for one (it has no
// `allow-bootstrap`): it only shows what the shell tells it, and is never
// put behind the sign-in gate.
try {
  const indicator = isIndicatorView();
  const desktop = indicator ? null : await desktopBootstrap();
  if (desktop) configureTransport(desktop);
  root.render(
    <StrictMode>
      <Root desktop={indicator || desktop !== null} />
    </StrictMode>
  );
} catch (err) {
  // The shell couldn't start its server: show why instead of a blank window.
  root.render(<StartupError message={String(err)} />);
}

function StartupError({ message }: { message: string }) {
  return (
    <div className="p-6 font-sans text-sm">
      <h1 className="mb-2 text-base font-semibold">OtherBench couldn't start its server</h1>
      <pre className="whitespace-pre-wrap rounded border border-[var(--border)] bg-[var(--bg-sunken)] p-3">{message}</pre>
    </div>
  );
}
