import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { desktopBootstrap } from './desktop/bridge.js';
import { configureTransport } from './state/transport.js';
import { initTextSize } from './state/textSize.js';
import './index.css';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root element missing from index.html');

// Apply the saved text size before first paint.
initTextSize();

const root = createRoot(rootEl);

// In the desktop app the API lives on the sidecar's port, not this page's
// origin, so the transport must be configured before the first request.
// In a browser this resolves to null straight away.
try {
  const desktop = await desktopBootstrap();
  if (desktop) configureTransport(desktop);
  root.render(
    <StrictMode>
      <App />
    </StrictMode>
  );
} catch (err) {
  // The shell couldn't start its server: show why instead of a blank window.
  root.render(<StartupError message={String(err)} />);
}

function StartupError({ message }: { message: string }) {
  return (
    <div className="p-6 font-sans text-sm">
      <h1 className="mb-2 text-base font-semibold">Grunt couldn't start its server</h1>
      <pre className="whitespace-pre-wrap rounded border border-[var(--border)] bg-[var(--bg-sunken)] p-3">{message}</pre>
    </div>
  );
}
