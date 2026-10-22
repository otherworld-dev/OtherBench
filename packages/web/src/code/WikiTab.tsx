// Placeholder: a later task replaces this with the real Wiki tab.
import type { JSX } from 'react';
import type { App } from '@otherbench/core/ports/store.js';

export function WikiTab({ app: _app, owner: _owner }: { app: App; owner: string }): JSX.Element {
  return <div data-testid="wiki-tab" />;
}
