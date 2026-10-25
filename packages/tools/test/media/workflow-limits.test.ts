import { describe, it, expect } from 'vitest';
import { workflowLimits } from '@otherbench/core/domain/media-workflows.js';
import { SDXL_TXT2IMG } from '../../src/media/workflows/sdxl-txt2img.js';
import { WAN22_5B_T2V } from '../../src/media/workflows/wan22-5b-t2v.js';

describe('workflowLimits of the builtins', () => {
  it('reads the SDXL builtin', () => {
    expect(workflowLimits(SDXL_TXT2IMG)).toEqual({ size: { width: 1024, height: 1024 }, maxFrames: null, fps: 24 });
  });

  it('reads the Wan builtin', () => {
    expect(workflowLimits(WAN22_5B_T2V)).toEqual({ size: { width: 1280, height: 704 }, maxFrames: 121, fps: 24 });
  });
});
