import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { desktopBootstrap } from './desktop/bridge.js';
import { configureTransport } from './state/transport.js';
import './index.css';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root element missing from index.html');

// In the desktop app the API lives on the sidecar's port, not this page's
// origin, so the transport must be configured before the first request.
// In a browser this resolves to null straight away.
const desktop = await desktopBootstrap();
if (desktop) configureTransport(desktop);

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>
);
