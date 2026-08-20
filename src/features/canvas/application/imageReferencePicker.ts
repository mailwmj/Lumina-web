export interface ImageReferencePickerAnchor {
  left: number;
  top: number;
}

interface ImageReferencePickerRootRect {
  left: number;
  top: number;
}

interface ImageReferencePickerCaretRect {
  left: number;
  bottom: number;
}

/**
 * Converts the caret rectangle captured when `@` is entered into coordinates
 * relative to the prompt container. It deliberately has no live selection
 * dependency: a picker session must remain at its original trigger point.
 */
export function resolveImageReferencePickerAnchor(
  rootRect: ImageReferencePickerRootRect,
  caretRect: ImageReferencePickerCaretRect | null
): ImageReferencePickerAnchor {
  return {
    left: Math.max(0, (caretRect?.left ?? rootRect.left) - rootRect.left),
    top: Math.max(0, (caretRect?.bottom ?? rootRect.top + 20) - rootRect.top + 4),
  };
}

/**
 * Pointer presses anywhere other than the current picker dismiss it. Keeping
 * this decision pure makes the document-level listener easy to regression-test.
 */
export function shouldCloseImageReferencePickerOnPointerDown(
  isPointerInsidePicker: boolean
): boolean {
  return !isPointerInsidePicker;
}
