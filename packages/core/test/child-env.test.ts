import { describe, expect, it } from 'vitest';
import { isServerOnlyEnvVar, SERVER_ONLY_ENV_VARS, withoutServerSecrets } from '../src/domain/child-env.js';

describe('what no child process may inherit', () => {
  it("leaves out the server's API token in any letter case, and keeps everything else", () => {
    expect(SERVER_ONLY_ENV_VARS).toEqual(['GRUNT_TOKEN']);
    for (const name of ['GRUNT_TOKEN', 'grunt_token', 'Grunt_Token']) expect(isServerOnlyEnvVar(name), name).toBe(true);
    for (const name of ['GRUNT_TOKENS', 'MY_GRUNT_TOKEN', 'PATH', 'GRUNT_DB']) expect(isServerOnlyEnvVar(name), name).toBe(false);
    expect(withoutServerSecrets({ PATH: '/bin', GRUNT_TOKEN: 'secret', grunt_token: 'secret', HOME: '/h', EMPTY: undefined })).toEqual({ PATH: '/bin', HOME: '/h' });
  });

  it('cannot have its list changed by whoever imports it', () => {
    expect(Object.isFrozen(SERVER_ONLY_ENV_VARS)).toBe(true);
  });
});
