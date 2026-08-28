import { describe, expect, it } from 'vitest';

import { buildGenerationErrorReport } from './generationErrorReport';

describe('buildGenerationErrorReport', () => {
  it('retains the client session and Runtime error code for asset-persistence failures', () => {
    const report = buildGenerationErrorReport({
      errorMessage: 'The Runtime browser session is invalid or expired.',
      context: {
        sourceType: 'imageEdit',
        clientSessionId: 'runtime-client-42',
        errorCode: 'session_invalid',
      },
    });

    expect(report).toContain('- Client Session ID: runtime-client-42');
    expect(report).toContain('- Error Code: session_invalid');
  });
});
