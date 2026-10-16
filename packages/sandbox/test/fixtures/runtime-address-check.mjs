// Run inside the otherbench-sandbox distro by live.test.ts, on the distro's own Node,
// against the agent setup installed and the real sandbox runtime beside it.
// live.test.ts sends this file down stdin with one line in front of it:
//   const INPUT = { denied, hosts, addresses };
//     denied     DENIED_RESOLVED_ADDRESSES of the checkout under test
//     hosts      the default allowlist
//     addresses  [text, isPublic][], isPublic by core's isPublicAddress, worked out on Windows
// It prints one line of JSON: what the runtime's own checks make of those.
/* global INPUT */
import { lookup } from 'node:dns/promises';
import { DENIED_RESOLVED_ADDRESSES, isPrivateAddress } from '/opt/otherbench-sandbox/agent-core.mjs';
import { createResolvedAddressGuard } from '/opt/otherbench-sandbox/node_modules/@anthropic-ai/sandbox-runtime/dist/sandbox/resolved-address-guard.js';
import { NetworkConfigSchema } from '/opt/otherbench-sandbox/node_modules/@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-config.js';

const NAME = 'name.example';
const PORT = 443;

// The network config the agent starts the runtime with, through the runtime's own schema.
const parsed = NetworkConfigSchema.safeParse({ allowedDomains: INPUT.hosts, deniedDomains: [], allowLocalBinding: false, deniedResolvedAddresses: DENIED_RESOLVED_ADDRESSES });

// The runtime's guard for a name's resolved addresses, with OtherBench's ranges and without them. Neither knows this
// VM's own addresses here (the runtime refuses those too, whatever they are): the question is the ranges.
const withRanges = createResolvedAddressGuard({ deniedResolvedAddresses: DENIED_RESOLVED_ADDRESSES, localAddresses: () => [] });
const runtimeAlone = createResolvedAddressGuard({ localAddresses: () => [] });

const out = {
  installedIsThisCheckout: JSON.stringify(DENIED_RESOLVED_ADDRESSES) === JSON.stringify(INPUT.denied),
  ranges: DENIED_RESOLVED_ADDRESSES.length,
  schema: parsed.success ? [] : parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
  addresses: INPUT.addresses.length,
  /** The installed agent and core disagree. */
  agentDiffers: [],
  /** Not public, yet the runtime would dial it. */
  letThrough: [],
  /** Public, and refused because of OtherBench's ranges (the runtime alone would dial it). */
  refusedByRanges: [],
  /** Public, and refused by the runtime whatever OtherBench says (its cloud metadata addresses). */
  refusedByRuntimeAnyway: [],
  /** Not public: how many the runtime refuses by itself, and how many only because of OtherBench's ranges. */
  privateRefusedByRuntimeAlone: 0,
  privateRefusedByRanges: 0,
  hosts: {},
};

for (const [text, isPublic] of INPUT.addresses) {
  if (isPrivateAddress(text) === isPublic) out.agentDiffers.push(text);
  const permitted = withRanges.permits(NAME, text, PORT);
  const alone = runtimeAlone.permits(NAME, text, PORT);
  if (isPublic) {
    if (!permitted) (alone ? out.refusedByRanges : out.refusedByRuntimeAnyway).push(text);
  } else if (permitted) out.letThrough.push(text);
  else if (alone) out.privateRefusedByRanges += 1;
  else out.privateRefusedByRuntimeAlone += 1;
}

// The default allowlist, resolved here and now: every address must pass the agent's check and the runtime's
// guard as the agent configures it (this VM's own addresses included, as in a real run).
const asConfigured = createResolvedAddressGuard({ deniedResolvedAddresses: DENIED_RESOLVED_ADDRESSES });
for (const host of INPUT.hosts) {
  try {
    const found = await lookup(host, { all: true });
    out.hosts[host] = found.map(({ address }) => ({ address, private: isPrivateAddress(address), permitted: asConfigured.permits(host, address, PORT) }));
  } catch (err) {
    out.hosts[host] = { error: String(err) };
  }
}

process.stdout.write(`${JSON.stringify(out)}\n`);
