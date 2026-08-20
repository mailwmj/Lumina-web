/**
 * Keep the connection target forgiving without making adjacent input handles
 * ambiguous. XYFlow measures this radius in canvas coordinates, so it must be
 * scaled inversely to the viewport zoom to remain a 36px screen-space target.
 */
export const CANVAS_CONNECTION_SNAP_SCREEN_RADIUS = 36;

export function resolveCanvasConnectionRadius(viewportZoom: number): number {
  const safeZoom = Number.isFinite(viewportZoom) && viewportZoom > 0
    ? viewportZoom
    : 1;
  return CANVAS_CONNECTION_SNAP_SCREEN_RADIUS / safeZoom;
}
