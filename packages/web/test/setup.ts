import '@testing-library/jest-dom/vitest';
import { configure } from '@testing-library/react';

// findBy* and waitFor give up after 1 s by default, which a full parallel run on a busy machine can take just to
// render a panel. A passing wait returns as soon as it matches, so the longer limit only slows a test that fails.
configure({ asyncUtilTimeout: 5000 });
