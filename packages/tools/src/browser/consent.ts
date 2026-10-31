import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { BrowserContext, Frame } from 'playwright-core';

/** Refuse where a site offers it; where it only offers OK, take that. Either way the box goes without a card. */
const CONFIG = {
  enabled: true,
  autoAction: 'optOut',
  enablePrehide: true,
  enableCosmeticRules: true,
  enableGeneratedRules: true,
  enableHeuristicDetection: true,
  heuristicMode: 'tier2',
  logs: { lifecycle: false, rulesteps: false, detectionsteps: false, evals: false, errors: false, messages: false, waits: false },
};

interface Consent {
  /** The script every document starts with. */
  script: string;
  /** The `initResp` message, ready to run in a frame: it is about 500 KB, so it is built once. */
  init: string;
}

let loaded: Promise<Consent | null> | null = null;

/** The package's own files, read once. It keeps them outside its `exports`, so the script is found from the rules that are in them. */
function loadConsent(): Promise<Consent | null> {
  loaded ??= (async () => {
    try {
      const rulesPath = createRequire(import.meta.url).resolve('@duckduckgo/autoconsent/rules/compact-rules.json');
      const [script, compact] = await Promise.all([
        readFile(join(dirname(rulesPath), '..', 'dist', 'autoconsent.playwright.js'), 'utf8'),
        readFile(rulesPath, 'utf8'),
      ]);
      const message = `{"type":"initResp","config":${JSON.stringify(CONFIG)},"rules":{"autoconsent":[],"compact":${compact}}}`;
      return { script, init: `autoconsentReceiveMessage(${message})` };
    } catch (err) {
      console.warn('[browser] the cookie box rules could not be read, so the model will have to answer cookie boxes itself:', err);
      return null;
    }
  })();
  return loaded;
}

export interface ConsentEvents {
  /** A cookie box is on the page and is being answered. */
  found(): void;
  /** That has finished; `cleared` says whether the box went. */
  finished(cleared: boolean): void;
}

/**
 * Answers cookie boxes as pages load, using DuckDuckGo's Autoconsent rules
 * (a Playwright build it maintains for this). Everything it asks for comes
 * from the page's own world, so a message may be the page's rather than the
 * script's. That is safe because all it can do is run code in the frame that
 * asked, which that frame could do itself, and fire a fixed note. Not a tool
 * call, so no broker: it acts only inside a page already open, on a box the
 * person would otherwise have to dismiss.
 */
export async function answerCookieBoxes(context: BrowserContext, events: ConsentEvents): Promise<void> {
  const consent = await loadConsent();
  if (!consent) return;
  const reply = (frame: Frame, code: string): Promise<unknown> => frame.evaluate(code).catch(() => undefined);
  await context.exposeBinding('autoconsentSendMessage', async ({ frame }: { frame: Frame }, raw: unknown) => {
    const message = (typeof raw === 'object' && raw !== null ? raw : {}) as { type?: unknown; id?: unknown; code?: unknown; result?: unknown };
    switch (message.type) {
      case 'init':
        await reply(frame, consent.init);
        break;
      case 'eval': {
        const result = typeof message.code === 'string' ? await frame.evaluate(message.code).catch(() => false) : false;
        await reply(frame, `autoconsentReceiveMessage(${JSON.stringify({ type: 'evalResp', id: message.id, result })})`);
        break;
      }
      case 'popupFound':
        events.found();
        break;
      case 'optOutResult':
        if (message.result !== true) events.finished(false);
        break;
      case 'autoconsentDone':
        events.finished(true);
        break;
      case 'autoconsentError':
        events.finished(false);
        break;
      default:
        break;
    }
  });
  await context.addInitScript({ content: consent.script });
}
