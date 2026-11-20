/**
 * Git on this machine pointed at a folder a job could write
 * (docs/features/jobs.md). A job's sandboxed commands can change its
 * folder's `.git`, and git reads its hooks and its config's commands
 * (`core.fsmonitor`, `core.hooksPath`, filter and diff drivers, an editor or
 * pager) from there. Config given on git's command line, or through
 * `GIT_CONFIG_COUNT`, outranks the repository's own, so these settings hold
 * whatever the folder's config says.
 *
 * Filter and diff drivers are only ever defined in config, and a job can't
 * write its folder's config (the sandbox write-denies `.git/config` and puts
 * it back after every command, and the job rules refuse it to every file
 * tool); OtherBench's own git calls on a job folder are also only ones that
 * never read the working tree (no status, no checkout), so no clean or smudge
 * filter runs, and diffs are read with `--no-ext-diff --no-textconv`.
 */

/**
 * The settings, as `key=value` pairs, that keep git from running anything
 * from a job's folder. `noHooksDir` must be an empty folder only OtherBench
 * can write.
 */
export function hardenedGitConfig(noHooksDir: string): [string, string][] {
  return [
    // No hook from the folder runs: they are looked for in an empty folder.
    ['core.hooksPath', noHooksDir],
    // No file-system monitor command.
    ['core.fsmonitor', 'false'],
    ['core.untrackedCache', 'false'],
    // No credential helper (an empty value clears the list).
    ['credential.helper', ''],
    // Submodules are never touched by itself.
    ['submodule.recurse', 'false'],
    // Only the file and https protocols, never ext:: (which runs a command).
    ['protocol.ext.allow', 'never'],
    // No automatic maintenance or gc started in the background.
    ['gc.auto', '0'],
    ['maintenance.auto', 'false'],
    // Never read the folder itself as a bare repository (a planted HEAD, config and objects at its top level).
    ['safe.bareRepository', 'explicit'],
  ];
}

/**
 * For git on the app's OWN repository (the base branch's fetch): the same, but
 * keeping the user's credential helper, since the fetch uses their own
 * credentials for their own remote. Nothing a job wrote is read here.
 */
export function appRepoGitArgs(noHooksDir: string): string[] {
  return hardenedGitConfig(noHooksDir)
    .filter(([k]) => k !== 'credential.helper')
    .flatMap(([k, v]) => ['-c', `${k}=${v}`]);
}

/** `hardenedGitConfig` as `-c key=value` arguments, for git's command line. */
export function hardenedGitArgs(noHooksDir: string): string[] {
  return hardenedGitConfig(noHooksDir).flatMap(([k, v]) => ['-c', `${k}=${v}`]);
}

/**
 * The same settings as environment variables, which every git a process
 * starts reads with command-line precedence (`GIT_CONFIG_COUNT`), plus no
 * prompts and no pager. For Claude Code's own process in a job chat: it runs
 * git on this machine in the job folder (its startup git status, for one).
 */
export function hardenedGitEnv(noHooksDir: string): Record<string, string> {
  const pairs = hardenedGitConfig(noHooksDir);
  const env: Record<string, string> = {
    GIT_CONFIG_COUNT: String(pairs.length),
    GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat',
    GIT_OPTIONAL_LOCKS: '0',
  };
  pairs.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  return env;
}

/** Environment variables that would steer a git call elsewhere or run something; never passed on to one on a job folder. */
export const UNSAFE_GIT_ENV = /^(GIT_DIR|GIT_WORK_TREE|GIT_INDEX_FILE|GIT_OBJECT_DIRECTORY|GIT_ALTERNATE_OBJECT_DIRECTORIES|GIT_COMMON_DIR|GIT_NAMESPACE|GIT_CEILING_DIRECTORIES|GIT_DISCOVERY_ACROSS_FILESYSTEM|GIT_EXTERNAL_DIFF|GIT_DIFF_OPTS|GIT_SSH|GIT_SSH_COMMAND|GIT_ASKPASS|SSH_ASKPASS|GIT_EDITOR|GIT_SEQUENCE_EDITOR|GIT_PAGER|PAGER|EDITOR|VISUAL|GIT_CONFIG|GIT_CONFIG_COUNT|GIT_CONFIG_KEY_\d+|GIT_CONFIG_VALUE_\d+|GIT_CONFIG_PARAMETERS|GIT_PROXY_COMMAND|GIT_TRACE.*|GIT_EXEC_PATH|GIT_TEMPLATE_DIR)$/i;
