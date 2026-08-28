interface PersistenceErrorPresentationInput {
  projectError: string | null;
  projectErrorCode: string | null;
  settingsError: string | null;
}

interface PersistenceErrorPresentation {
  titleKey: string;
  messageKey: string;
  actionKey: string;
}

export function persistenceErrorPresentation({
  projectError,
  projectErrorCode,
}: PersistenceErrorPresentationInput): PersistenceErrorPresentation {
  if (projectErrorCode === 'runtime_api_incompatible') {
    return {
      titleKey: 'project.runtimeUpdateRequiredTitle',
      messageKey: 'project.runtimeUpdateRequiredMessage',
      actionKey: 'project.runtimeUpdateReload',
    };
  }
  if (projectError) {
    return {
      titleKey: 'project.runtimePersistenceErrorTitle',
      messageKey: 'project.runtimePersistenceErrorMessage',
      actionKey: 'project.storageReload',
    };
  }
  return {
    titleKey: 'project.storageUnavailableTitle',
    messageKey: 'project.storageUnavailableMessage',
    actionKey: 'project.storageReload',
  };
}
