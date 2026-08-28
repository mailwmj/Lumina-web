interface TitleTextOptions {
  appTitle: string;
  currentProjectName?: string;
  contextTitle?: string;
}

export function resolveTitleText({
  appTitle,
  currentProjectName,
  contextTitle,
}: TitleTextOptions): string {
  if (contextTitle) {
    return `${contextTitle} - ${appTitle}`;
  }

  return currentProjectName || appTitle;
}
