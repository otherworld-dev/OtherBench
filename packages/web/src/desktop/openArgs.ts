/** What `--open-folder <path>` and `--send <file>...` ask for (v2 plan, Task 39). */
export interface OpenArgs {
  /** Start a chat working in this folder. */
  openFolder: string | null;
  /** Start a chat with these files attached. */
  send: string[];
}

/**
 * Reads Grunt's launch arguments. `argv[0]` (the executable) and flags it
 * doesn't know (`--minimized`) are skipped. `--open-folder` takes the next
 * argument; `--send` takes every argument after it up to the next flag.
 */
export function parseOpenArgs(argv: string[]): OpenArgs {
  const result: OpenArgs = { openFolder: null, send: [] };
  const args = argv.slice(1);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--open-folder') {
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        result.openFolder = next;
        i++;
      }
    } else if (arg === '--send') {
      while (args[i + 1] !== undefined && !args[i + 1]!.startsWith('--')) {
        result.send.push(args[i + 1]!);
        i++;
      }
    }
  }
  return result;
}
