import { describe, expect, it } from 'vitest';

import { persistenceErrorPresentation } from './persistenceErrorPresentation';

describe('persistence error presentation', () => {
  it('shows Runtime guidance for project persistence failures', () => {
    expect(persistenceErrorPresentation({
      projectError: 'The Runtime project request is invalid.',
      projectErrorCode: 'invalid_request',
      settingsError: null,
    })).toEqual({
      titleKey: 'project.runtimePersistenceErrorTitle',
      messageKey: 'project.runtimePersistenceErrorMessage',
      actionKey: 'project.storageReload',
    });
  });

  it('keeps update and browser settings failures on their own messages', () => {
    expect(persistenceErrorPresentation({
      projectError: 'Runtime API mismatch',
      projectErrorCode: 'runtime_api_incompatible',
      settingsError: null,
    })).toEqual({
      titleKey: 'project.runtimeUpdateRequiredTitle',
      messageKey: 'project.runtimeUpdateRequiredMessage',
      actionKey: 'project.runtimeUpdateReload',
    });
    expect(persistenceErrorPresentation({
      projectError: null,
      projectErrorCode: null,
      settingsError: 'IndexedDB blocked',
    })).toEqual({
      titleKey: 'project.storageUnavailableTitle',
      messageKey: 'project.storageUnavailableMessage',
      actionKey: 'project.storageReload',
    });
  });
});
