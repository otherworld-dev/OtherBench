import { describe, expect, it } from 'vitest';
import { isServerOnlyEnvVar, SERVER_ONLY_ENV_VARS, withoutServerSecrets } from '../src/domain/child-env.js';

describe('what no child process may inherit', () => {
  it("leaves out the server's API token in any letter case, and keeps everything else", () => {
    expect(SERVER_ONLY_ENV_VARS).toEqual(['OTHERBENCH_TOKEN']);
    for (const name of ['OTHERBENCH_TOKEN', 'otherbench_token', 'OtherBench_Token']) expect(isServerOnlyEnvVar(name), name).toBe(true);
    for (const name of ['OTHERBENCH_TOKENS', 'MY_OTHERBENCH_TOKEN', 'PATH', 'OTHERBENCH_DB']) expect(isServerOnlyEnvVar(name), name).toBe(false);
    expect(withoutServerSecrets({ PATH: '/bin', OTHERBENCH_TOKEN: 'secret', otherbench_token: 'secret', HOME: '/h', EMPTY: undefined })).toEqual({ PATH: '/bin', HOME: '/h' });
  });

  it('cannot have its list changed by whoever imports it', () => {
    expect(Object.isFrozen(SERVER_ONLY_ENV_VARS)).toBe(true);
  });
});
