const SELECT_MENU_MIN_WIDTH = 160;
const SELECT_MENU_VIEWPORT_INSET = 8;
const SELECT_MENU_MAX_HEIGHT = 320;
const SELECT_MENU_MIN_HEIGHT = 60;
const SELECT_MENU_OPTION_HEIGHT = 36;
const SELECT_MENU_VERTICAL_CHROME = 10;

interface SelectMenuHorizontalGeometry {
  left: number;
  width: number;
}

export function resolveSelectMenuHorizontalGeometry(
  triggerLeft: number,
  triggerWidth: number,
  viewportWidth: number,
  menuMinWidth = SELECT_MENU_MIN_WIDTH
): SelectMenuHorizontalGeometry {
  const availableWidth = Math.max(0, viewportWidth - SELECT_MENU_VIEWPORT_INSET * 2);
  const width = Math.min(Math.max(triggerWidth, menuMinWidth), availableWidth);
  const maximumLeft = Math.max(
    SELECT_MENU_VIEWPORT_INSET,
    viewportWidth - SELECT_MENU_VIEWPORT_INSET - width
  );

  return {
    left: Math.min(Math.max(triggerLeft, SELECT_MENU_VIEWPORT_INSET), maximumLeft),
    width,
  };
}

interface SelectMenuVerticalGeometry {
  top: number;
  maxHeight: number;
}

export function resolveSelectMenuVerticalGeometry(
  triggerTop: number,
  triggerBottom: number,
  optionCount: number,
  viewportHeight: number
): SelectMenuVerticalGeometry {
  const naturalHeight = Math.min(
    Math.max(
      optionCount * SELECT_MENU_OPTION_HEIGHT + SELECT_MENU_VERTICAL_CHROME,
      SELECT_MENU_MIN_HEIGHT
    ),
    SELECT_MENU_MAX_HEIGHT
  );
  const spaceAbove = Math.max(0, triggerTop - SELECT_MENU_VIEWPORT_INSET);
  const spaceBelow = Math.max(0, viewportHeight - triggerBottom - SELECT_MENU_VIEWPORT_INSET);
  const openAbove = spaceBelow < naturalHeight && spaceAbove > spaceBelow;
  const maxHeight = Math.min(naturalHeight, openAbove ? spaceAbove : spaceBelow);

  return {
    top: openAbove
      ? Math.max(SELECT_MENU_VIEWPORT_INSET, triggerTop - maxHeight - SELECT_MENU_VIEWPORT_INSET)
      : triggerBottom + SELECT_MENU_VIEWPORT_INSET,
    maxHeight,
  };
}
