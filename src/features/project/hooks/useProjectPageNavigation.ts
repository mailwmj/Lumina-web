import { useEffect, useRef, useState } from 'react';

interface ProjectPageNavigationOptions {
  isHydrated: boolean;
  isOpeningProject: boolean;
  projectId: string | null;
  openProject: (projectId: string) => void;
}

const PROJECT_QUERY_PARAMETER = 'project';

export function useProjectPageNavigation({
  isHydrated,
  isOpeningProject,
  projectId,
  openProject,
}: ProjectPageNavigationOptions): void {
  const initialProjectIdRef = useRef(readProjectIdFromLocation());
  const [isRestoringInitialProject, setIsRestoringInitialProject] = useState(
    () => initialProjectIdRef.current !== null,
  );
  const didRestoreInitialProjectRef = useRef(false);

  useEffect(() => {
    if (!isHydrated || didRestoreInitialProjectRef.current) {
      return;
    }

    didRestoreInitialProjectRef.current = true;
    const initialProjectId = initialProjectIdRef.current;
    if (initialProjectId) {
      openProject(initialProjectId);
    }
    setIsRestoringInitialProject(false);
  }, [isHydrated, openProject]);

  useEffect(() => {
    if (!isHydrated || isRestoringInitialProject || isOpeningProject) {
      return;
    }

    replaceProjectIdInLocation(projectId);
  }, [isHydrated, isOpeningProject, isRestoringInitialProject, projectId]);
}

function readProjectIdFromLocation(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const projectId = new URLSearchParams(window.location.search)
    .get(PROJECT_QUERY_PARAMETER)
    ?.trim();
  return projectId || null;
}

function replaceProjectIdInLocation(projectId: string | null): void {
  const url = new URL(window.location.href);
  if (projectId) {
    url.searchParams.set(PROJECT_QUERY_PARAMETER, projectId);
  } else {
    url.searchParams.delete(PROJECT_QUERY_PARAMETER);
  }

  const nextUrl = `${url.pathname}${url.search}${url.hash}`;
  const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (nextUrl !== currentUrl) {
    window.history.replaceState(null, '', nextUrl);
  }
}
