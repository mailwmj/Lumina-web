import { describe, expect, it } from 'vitest';

import {
  INITIAL_PROJECT_REVISION,
  nextProjectRevision,
  StaleProjectRevisionError,
} from './projectRevision';

describe('project revisions', () => {
  it('starts at zero and advances monotonically', () => {
    expect(nextProjectRevision()).toBe('r1');
    expect(nextProjectRevision(INITIAL_PROJECT_REVISION)).toBe('r1');
    expect(nextProjectRevision('r9')).toBe('r10');
    expect(nextProjectRevision('legacy-revision')).toMatch(/^r[0-9a-f-]+$/);
  });

  it('exposes a typed stale revision error', () => {
    const error = new StaleProjectRevisionError('project-1', 'r2', 'r1');
    expect(error.code).toBe('stale_revision');
    expect(error.projectId).toBe('project-1');
    expect(error.expectedRevision).toBe('r2');
    expect(error.actualRevision).toBe('r1');
  });
});
