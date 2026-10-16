// Live probe for plan usage (Deck #825). NOT part of CI.
// Usage: node packages/engine-claude-code/scripts/probe-usage.mjs
// Uses the Claude login but sends no prompt: it starts an idle Claude Code
// process, asks for the /usage data (plan rate limits only, no transcript
// scan), then for the account, and prints both. Times each call.
import { query } from '@anthropic-ai/claude-agent-sdk';

// Same scrubbing as OtherBench's buildChildEnv for the Claude backend.
const env = {};
for (const [k, v] of Object.entries(process.env)) {
  if (v === undefined) continue;
  if (/^ANTHROPIC_(API_KEY|AUTH_TOKEN|BASE_URL)$/i.test(k)) continue;
  if (/^(CLAUDECODE|CLAUDE_CODE_ENTRYPOINT|CLAUDE_CODE_SSE_PORT|CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD)$/i.test(k)) continue;
  env[k] = v;
}

const ac = new AbortController();
const idle = (async function* () { await new Promise(() => {}); })();
const q = query({ prompt: idle, options: { env, settingSources: [], persistSession: false, abortController: ac } });

async function timed(label, fn) {
  const t0 = Date.now();
  try {
    const value = await fn();
    return { label, ms: Date.now() - t0, value };
  } catch (err) {
    return { label, ms: Date.now() - t0, error: err instanceof Error ? err.message : String(err) };
  }
}

const usage = await timed('usage', () => q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }));
const again = await timed('usage again (same process)', () => q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }));
const account = await timed('accountInfo', () => q.accountInfo());
ac.abort();

const pick = (r) => (r.error ? { error: r.error } : { subscription_type: r.value.subscription_type, rate_limits_available: r.value.rate_limits_available, rate_limits: r.value.rate_limits, behaviors: r.value.behaviors === null ? null : 'present' });
console.log(JSON.stringify({ usage: { ms: usage.ms, ...pick(usage) }, again: { ms: again.ms, ...pick(again) }, account: { ms: account.ms, subscriptionType: account.value?.subscriptionType ?? null, error: account.error ?? null } }, null, 2));
process.exit(0);
