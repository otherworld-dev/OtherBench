// Placeholder: a later task replaces this with the real Deck tab.
import type { JSX } from 'react';
import type { App } from '@otherbench/core/ports/store.js';

export function DeckTab({ app: _app, owner: _owner }: { app: App; owner: string }): JSX.Element {
  return <div data-testid="deck-tab" />;
}
