interface ClickGesture {
  detail: number;
  clientX: number;
  clientY: number;
}

interface PendingProjectOpenClick {
  clientX: number;
  clientY: number;
  recordedAt: number;
}

const PROJECT_OPEN_CLICK_WINDOW_MS = 1_000;
const POINTER_POSITION_TOLERANCE_PX = 4;

let pendingProjectOpenClick: PendingProjectOpenClick | null = null;

function now(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}

function isSamePointerPosition(
  first: Pick<ClickGesture, 'clientX' | 'clientY'>,
  second: Pick<ClickGesture, 'clientX' | 'clientY'>
): boolean {
  return Math.abs(first.clientX - second.clientX) <= POINTER_POSITION_TOLERANCE_PX
    && Math.abs(first.clientY - second.clientY) <= POINTER_POSITION_TOLERANCE_PX;
}

/**
 * Remembers the click that starts an asynchronous project transition. If that
 * click is the first half of a double-click, its second click can otherwise
 * land on the canvas after the project card has unmounted.
 */
export function recordProjectOpenClick(event: ClickGesture): void {
  if (event.detail !== 1) {
    pendingProjectOpenClick = null;
    return;
  }

  pendingProjectOpenClick = {
    clientX: event.clientX,
    clientY: event.clientY,
    recordedAt: now(),
  };
}

/**
 * Consumes only the continuation of the click sequence that opened a project.
 * A distinct single click clears the guard so regular canvas double-clicking
 * remains available immediately after entering a project.
 */
export function shouldSuppressPaneClickAfterProjectOpen(event: ClickGesture): boolean {
  const pendingClick = pendingProjectOpenClick;
  if (!pendingClick) {
    return false;
  }

  if (now() - pendingClick.recordedAt > PROJECT_OPEN_CLICK_WINDOW_MS) {
    pendingProjectOpenClick = null;
    return false;
  }

  if (event.detail === 1) {
    pendingProjectOpenClick = null;
    return false;
  }

  return event.detail >= 2 && isSamePointerPosition(pendingClick, event);
}

export function resetProjectOpenPaneClickGuard(): void {
  pendingProjectOpenClick = null;
}
