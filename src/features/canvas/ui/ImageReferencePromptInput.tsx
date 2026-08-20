import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useImperativeHandle,
  forwardRef,
  type ClipboardEvent,
  type CompositionEvent,
  type FocusEvent,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import { useTranslation } from 'react-i18next';

import {
  DEFAULT_IMAGE_REFERENCE_PICKER_INDEX,
  findImageReferencePromptTokens,
  insertImageReferencePromptToken,
  moveImageReferencePickerIndex,
  normalizeImageReferenceShortcuts,
  removeImageReferencePromptToken,
  type ImageReferencePromptInput as ImageReferencePromptValue,
} from '@/features/canvas/application/imageReferencePrompt';
import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import {
  resolveImageReferencePickerAnchor,
  shouldCloseImageReferencePickerOnPointerDown,
  type ImageReferencePickerAnchor,
} from '@/features/canvas/application/imageReferencePicker';

export interface ImageReferencePromptItem extends ImageReferencePromptValue {
  previewImageUrl?: string | null;
}

export interface ImageReferencePromptInputProps {
  value: string;
  imageInputs: ImageReferencePromptItem[];
  placeholder: string;
  ariaLabel?: string;
  disabled?: boolean;
  className?: string;
  onValueChange: (value: string, nativeIsComposing: boolean) => void;
  onCompositionStart?: () => void;
  onCompositionEnd?: (value: string) => void;
  onBlur?: (value: string) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
}

export interface ImageReferencePromptInputHandle {
  insertReference: (edgeId: string) => void;
}

const CARET_ANCHOR_CHARACTER = '\u200B';

function readEditorNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return (node.textContent ?? '').replace(/\u200B/g, '');
  }
  if (node.nodeType !== Node.ELEMENT_NODE) {
    return '';
  }

  const element = node as HTMLElement;
  const edgeId = element.dataset.imageReferenceEdgeId;
  if (edgeId) {
    return `{{image-ref:${edgeId}}}`;
  }
  if (element.tagName === 'BR') {
    return '\n';
  }

  const text = Array.from(element.childNodes).map(readEditorNode).join('');
  return (element.tagName === 'DIV' || element.tagName === 'P') && text && !text.endsWith('\n')
    ? `${text}\n`
    : text;
}

function readEditorValue(root: HTMLElement): string {
  return Array.from(root.childNodes).map(readEditorNode).join('');
}

function getSelectionOffset(root: HTMLElement): number | null {
  const selection = window.getSelection();
  if (!selection?.rangeCount || !selection.anchorNode || !root.contains(selection.anchorNode)) {
    return null;
  }
  const range = document.createRange();
  range.selectNodeContents(root);
  try {
    range.setEnd(selection.anchorNode, selection.anchorOffset);
  } catch {
    return null;
  }
  return Array.from(range.cloneContents().childNodes).map(readEditorNode).join('').length;
}

function getSelectionOffsets(root: HTMLElement): { start: number; end: number } | null {
  const selection = window.getSelection();
  if (!selection?.rangeCount || !selection.anchorNode || !selection.focusNode) {
    return null;
  }
  if (!root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) {
    return null;
  }

  const getOffset = (node: Node, offset: number): number | null => {
    const range = document.createRange();
    range.selectNodeContents(root);
    try {
      range.setEnd(node, offset);
    } catch {
      return null;
    }
    return Array.from(range.cloneContents().childNodes).map(readEditorNode).join('').length;
  };

  const anchor = getOffset(selection.anchorNode, selection.anchorOffset);
  const focus = getOffset(selection.focusNode, selection.focusOffset);
  if (anchor === null || focus === null) {
    return null;
  }
  return { start: Math.min(anchor, focus), end: Math.max(anchor, focus) };
}

type ReferenceCaretAffinity = 'before' | 'after';

function setSelectionOffset(
  root: HTMLElement,
  requestedOffset: number,
  affinity?: ReferenceCaretAffinity
): void {
  const offset = Math.max(0, Math.min(requestedOffset, readEditorValue(root).length));
  const range = document.createRange();

  if (affinity) {
    let referenceOffset = 0;
    for (const child of Array.from(root.childNodes)) {
      const childLength = readEditorNode(child).length;
      const isReference = child.nodeType === Node.ELEMENT_NODE
        && Boolean((child as HTMLElement).dataset.imageReferenceEdgeId);
      const matchesAffinity = isReference && (
        affinity === 'before'
          ? referenceOffset === offset
          : referenceOffset + childLength === offset
      );
      if (matchesAffinity) {
        const anchorText = affinity === 'before' ? child.previousSibling : child.nextSibling;
        if (anchorText?.nodeType === Node.TEXT_NODE) {
          const text = anchorText.textContent ?? '';
          const anchorCharacterOffset = text.indexOf(CARET_ANCHOR_CHARACTER);
          range.setStart(
            anchorText,
            affinity === 'before'
              ? text.length
              : anchorCharacterOffset === -1
                ? 0
                : anchorCharacterOffset + CARET_ANCHOR_CHARACTER.length
          );
          range.collapse(true);
          const selection = window.getSelection();
          selection?.removeAllRanges();
          selection?.addRange(range);
          return;
        }
      }
      referenceOffset += childLength;
    }
  }

  let remaining = offset;

  for (const child of Array.from(root.childNodes)) {
    const length = readEditorNode(child).length;
    if (remaining > length) {
      remaining -= length;
      continue;
    }

    if (child.nodeType === Node.TEXT_NODE) {
      range.setStart(child, Math.min(remaining, child.textContent?.length ?? 0));
    } else if ((child as HTMLElement).dataset.imageReferenceEdgeId) {
      if (remaining === 0) {
        range.setStartBefore(child);
      } else {
        range.setStartAfter(child);
      }
    } else {
      range.setStart(root, Array.from(root.childNodes).indexOf(child));
    }
    range.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    return;
  }

  range.selectNodeContents(root);
  range.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function findDeletionRange(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  direction: 'backward' | 'forward'
): { start: number; end: number } | null {
  const tokens = findImageReferencePromptTokens(value);
  if (selectionStart !== selectionEnd) {
    const touched = tokens.filter((token) => token.end > selectionStart && token.start < selectionEnd);
    if (touched.length === 0) {
      return null;
    }
    return {
      start: Math.min(selectionStart, ...touched.map((token) => token.start)),
      end: Math.max(selectionEnd, ...touched.map((token) => token.end)),
    };
  }

  const point = direction === 'backward'
    ? Math.max(0, selectionStart - 1)
    : selectionStart;
  const token = tokens.find((item) => point >= item.start && point < item.end);
  return token ? { start: token.start, end: token.end } : null;
}

function isCompositionKeyboardEvent(event: KeyboardEvent<HTMLDivElement>): boolean {
  return event.nativeEvent.isComposing === true || event.nativeEvent.keyCode === 229;
}

function isImageReferenceTrigger(event: KeyboardEvent<HTMLDivElement>): boolean {
  return event.key === '@'
    || (event.key === '2' && event.shiftKey && event.code === 'Digit2');
}

export function resolveImageReferenceCursorMove(
  value: string,
  selection: { start: number; end: number },
  direction: 'backward' | 'forward'
): number | null {
  const tokens = findImageReferencePromptTokens(value);
  if (tokens.length === 0) {
    return null;
  }

  if (selection.start !== selection.end) {
    const touchesTag = tokens.some(
      (token) => token.end > selection.start && token.start < selection.end
    );
    if (touchesTag) {
      return direction === 'backward' ? selection.start : selection.end;
    }
    return null;
  }

  const cursor = selection.start;
  const adjacentTag = direction === 'backward'
    ? tokens.find((token) => token.end === cursor)
    : tokens.find((token) => token.start === cursor);
  return adjacentTag
    ? direction === 'backward' ? adjacentTag.start : adjacentTag.end
    : null;
}

export const ImageReferencePromptInput = forwardRef<ImageReferencePromptInputHandle, ImageReferencePromptInputProps>(function ImageReferencePromptInput({
  value,
  imageInputs,
  placeholder,
  ariaLabel,
  disabled = false,
  className = '',
  onValueChange,
  onCompositionStart,
  onCompositionEnd,
  onBlur,
  onKeyDown,
}: ImageReferencePromptInputProps, ref) {
  const { t } = useTranslation();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const pickerRef = useRef<HTMLDivElement | null>(null);
  const renderedImageInputsKeyRef = useRef<string | null>(null);
  const pendingSelectionOffsetRef = useRef<number | null>(null);
  const pendingSelectionAffinityRef = useRef<ReferenceCaretAffinity | null>(null);
  const isComposingRef = useRef(false);
  const pickerOpenRef = useRef(false);
  const pickerActiveIndexRef = useRef(DEFAULT_IMAGE_REFERENCE_PICKER_INDEX);
  const [showPicker, setShowPicker] = useState(false);
  const [pickerActiveIndex, setPickerActiveIndex] = useState(
    DEFAULT_IMAGE_REFERENCE_PICKER_INDEX
  );
  const [pickerAnchor, setPickerAnchor] = useState<ImageReferencePickerAnchor>({ left: 8, top: 24 });
  const [pickerSelection, setPickerSelection] = useState<{ start: number; end: number } | null>(null);
  const [isVisuallyEmpty, setIsVisuallyEmpty] = useState(value.length === 0);

  const setActivePickerIndex = useCallback((index: number) => {
    pickerActiveIndexRef.current = index;
    setPickerActiveIndex(index);
  }, []);

  const imageInputsKey = useMemo(
    () => imageInputs.map((input, index) => [
      input.edgeId,
      input.previewImageUrl ?? '',
      input.imageUrl ?? '',
      index,
    ].join(':')).join('|'),
    [imageInputs]
  );
  const itemsByEdgeId = useMemo(
    () => new Map(imageInputs.map((item, index) => [item.edgeId, { item, index }])),
    [imageInputs]
  );

  const renderEditor = useCallback((root: HTMLDivElement, nextValue: string) => {
    const fragment = document.createDocumentFragment();
    const tokens = findImageReferencePromptTokens(nextValue);
    let lastIndex = 0;
    // This must remain a text node. A fixed-width editable element receives
    // keystrokes itself, which makes the typed characters wrap one per line.
    const createCaretAnchor = () => document.createTextNode(CARET_ANCHOR_CHARACTER);

    for (const token of tokens) {
      if (token.start > lastIndex) {
        fragment.append(document.createTextNode(nextValue.slice(lastIndex, token.start)));
      }

      const reference = itemsByEdgeId.get(token.edgeId);
      if (reference) {
        const label = t('node.imageReference.label', { index: reference.index + 1 });
        const chip = document.createElement('span');
        chip.contentEditable = 'false';
        chip.dataset.imageReferenceEdgeId = token.edgeId;
        chip.className = 'mx-0.5 inline-flex h-5 max-w-full select-none items-center gap-1 rounded border border-[var(--ui-border-strong)] bg-[var(--ui-surface-elevated)] pl-0.5 pr-1.5 align-middle text-sm font-medium leading-none text-text-dark shadow-sm';

        const previewSource = reference.item.previewImageUrl || reference.item.imageUrl;
        if (previewSource) {
          const image = document.createElement('img');
          image.src = resolveImageDisplayUrl(previewSource);
          image.alt = label;
          image.draggable = false;
          image.className = 'h-4 w-4 shrink-0 rounded-[3px] object-cover';
          chip.append(image);
        } else {
          const fallback = document.createElement('span');
          fallback.className = 'flex h-4 w-4 shrink-0 items-center justify-center rounded-[3px] bg-red-500/20 text-[9px] text-red-300';
          fallback.textContent = '!';
          chip.append(fallback);
        }

        const text = document.createElement('span');
        text.className = 'truncate';
        text.textContent = label;
        chip.append(text);
        fragment.append(createCaretAnchor());
        fragment.append(chip);
        fragment.append(createCaretAnchor());
      }
      lastIndex = token.end;
    }

    if (lastIndex < nextValue.length) {
      fragment.append(document.createTextNode(nextValue.slice(lastIndex)));
    }
    if (fragment.childNodes.length === 0) {
      fragment.append(document.createTextNode(''));
    }

    root.replaceChildren(fragment);
  }, [itemsByEdgeId, t]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) {
      return;
    }
    const currentValue = readEditorValue(root);
    const needsRender = currentValue !== value || renderedImageInputsKeyRef.current !== imageInputsKey;
    if (!needsRender) {
      return;
    }

    const preservedOffset = pendingSelectionOffsetRef.current ?? getSelectionOffset(root);
    const preservedAffinity = pendingSelectionAffinityRef.current ?? undefined;
    renderEditor(root, value);
    renderedImageInputsKeyRef.current = imageInputsKey;
    pendingSelectionOffsetRef.current = null;
    pendingSelectionAffinityRef.current = null;
    setIsVisuallyEmpty(value.length === 0);
    if (document.activeElement === root && preservedOffset !== null) {
      setSelectionOffset(root, preservedOffset, preservedAffinity);
    }
  }, [imageInputsKey, renderEditor, value]);

  useLayoutEffect(() => {
    setActivePickerIndex(
      Math.min(pickerActiveIndexRef.current, Math.max(0, imageInputs.length - 1))
    );
    if (imageInputs.length === 0) {
      pickerOpenRef.current = false;
      setShowPicker(false);
      setPickerSelection(null);
    }
  }, [imageInputs.length, setActivePickerIndex]);

  const emitValue = useCallback((nextValue: string, nativeIsComposing: boolean) => {
    setIsVisuallyEmpty(nextValue.length === 0);
    onValueChange(nextValue, nativeIsComposing);
  }, [onValueChange]);

  const normalizeReferenceShortcuts = useCallback((
    root: HTMLDivElement,
    nextValue: string,
    selectionOffset: number | null,
    restoreFocus = true
  ): string | null => {
    const normalized = normalizeImageReferenceShortcuts(
      nextValue,
      imageInputs,
      selectionOffset ?? nextValue.length
    );
    if (normalized.nextText === nextValue) {
      return null;
    }

    pendingSelectionOffsetRef.current = normalized.selectionOffset;
    pendingSelectionAffinityRef.current = 'after';
    emitValue(normalized.nextText, false);
    if (restoreFocus) {
      requestAnimationFrame(() => {
        root.focus();
        setSelectionOffset(root, normalized.selectionOffset, 'after');
      });
    }
    return normalized.nextText;
  }, [emitValue, imageInputs]);

  const closePicker = useCallback(() => {
    pickerOpenRef.current = false;
    setShowPicker(false);
    setPickerSelection(null);
    setActivePickerIndex(DEFAULT_IMAGE_REFERENCE_PICKER_INDEX);
  }, [setActivePickerIndex]);

  useEffect(() => {
    if (!showPicker) {
      return;
    }

    const handleDocumentPointerDown = (event: PointerEvent) => {
      const target = event.target;
      const isPointerInsidePicker = target instanceof Node
        && pickerRef.current?.contains(target) === true;
      if (shouldCloseImageReferencePickerOnPointerDown(isPointerInsidePicker)) {
        closePicker();
      }
    };

    document.addEventListener('pointerdown', handleDocumentPointerDown, true);
    return () => document.removeEventListener('pointerdown', handleDocumentPointerDown, true);
  }, [closePicker, showPicker]);

  const insertReference = useCallback((index: number) => {
    const root = rootRef.current;
    const item = imageInputs[index];
    if (!root || !item || isComposingRef.current) {
      return;
    }
    const selection = pickerSelection ?? (
      document.activeElement === root ? getSelectionOffsets(root) : null
    ) ?? {
      start: value.length,
      end: value.length,
    };
    const valueWithoutSelection = `${value.slice(0, selection.start)}${value.slice(selection.end)}`;
    const result = insertImageReferencePromptToken(valueWithoutSelection, selection.start, item.edgeId);
    pendingSelectionOffsetRef.current = result.nextOffset;
    pendingSelectionAffinityRef.current = 'after';
    emitValue(result.nextText, false);
    closePicker();
    requestAnimationFrame(() => {
      root.focus();
      setSelectionOffset(root, result.nextOffset, 'after');
    });
  }, [closePicker, emitValue, imageInputs, pickerSelection, value]);

  useImperativeHandle(ref, () => ({
    insertReference: (edgeId: string) => {
      const index = imageInputs.findIndex((item) => item.edgeId === edgeId);
      if (index >= 0) {
        insertReference(index);
      }
    },
  }), [imageInputs, insertReference]);

  const openPicker = useCallback((requestedOffset?: number) => {
    const root = rootRef.current;
    if (!root || imageInputs.length === 0 || isComposingRef.current || pickerOpenRef.current) {
      return;
    }
    const selectionOffsets = getSelectionOffsets(root);
    const cursor = requestedOffset ?? selectionOffsets?.start ?? value.length;
    const selection = window.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    const rootRect = root.getBoundingClientRect();
    const rangeRect = range?.getBoundingClientRect();
    pickerOpenRef.current = true;
    setPickerAnchor(resolveImageReferencePickerAnchor(rootRect, rangeRect ?? null));
    setPickerSelection({
      start: cursor,
      end: requestedOffset === undefined ? selectionOffsets?.end ?? cursor : cursor,
    });
    setActivePickerIndex(DEFAULT_IMAGE_REFERENCE_PICKER_INDEX);
    setShowPicker(true);
    requestAnimationFrame(() => {
      if (pickerOpenRef.current) {
        root.focus();
      }
    });
  }, [imageInputs.length, setActivePickerIndex, value.length]);

  const handleBeforeInput = useCallback((event: FormEvent<HTMLDivElement>) => {
    const nativeEvent = event.nativeEvent as InputEvent;
    if (
      nativeEvent.data !== '@'
      || nativeEvent.isComposing === true
      || isComposingRef.current
      || imageInputs.length === 0
    ) {
      return;
    }
    event.preventDefault();
    openPicker();
  }, [imageInputs.length, openPicker]);

  const handleInput = useCallback((event: FormEvent<HTMLDivElement>) => {
    const root = event.currentTarget;
    const nextValue = readEditorValue(root);
    const nativeIsComposing = (event.nativeEvent as InputEvent).isComposing === true;
    const cursor = getSelectionOffset(root);

    // `beforeinput` is not consistently emitted by every keyboard/input-method
    // combination. If a literal @ reached the editor, turn it into the picker
    // here instead of leaving an inert character behind.
    if (
      !nativeIsComposing
      && !isComposingRef.current
      && imageInputs.length > 0
      && cursor !== null
      && cursor > 0
      && nextValue[cursor - 1] === '@'
    ) {
      const triggerOffset = cursor - 1;
      const valueWithoutTrigger = `${nextValue.slice(0, triggerOffset)}${nextValue.slice(cursor)}`;
      pendingSelectionOffsetRef.current = triggerOffset;
      emitValue(valueWithoutTrigger, false);
      requestAnimationFrame(() => {
        root.focus();
        setSelectionOffset(root, triggerOffset);
        openPicker(triggerOffset);
      });
      return;
    }

    if (!nativeIsComposing && !isComposingRef.current) {
      const normalizedValue = normalizeReferenceShortcuts(root, nextValue, cursor);
      if (normalizedValue !== null) {
        return;
      }
    }

    emitValue(nextValue, nativeIsComposing);
  }, [emitValue, imageInputs.length, normalizeReferenceShortcuts, openPicker]);

  const handleCompositionStart = useCallback(() => {
    isComposingRef.current = true;
    closePicker();
    onCompositionStart?.();
  }, [closePicker, onCompositionStart]);

  const handleCompositionEnd = useCallback((event: CompositionEvent<HTMLDivElement>) => {
    isComposingRef.current = false;
    const nextValue = readEditorValue(event.currentTarget);
    const normalizedValue = normalizeReferenceShortcuts(
      event.currentTarget,
      nextValue,
      getSelectionOffset(event.currentTarget)
    );
    const emittedValue = normalizedValue ?? nextValue;
    if (normalizedValue === null) {
      emitValue(emittedValue, false);
    }
    onCompositionEnd?.(emittedValue);
  }, [emitValue, normalizeReferenceShortcuts, onCompositionEnd]);

  const handleBlur = useCallback((event: FocusEvent<HTMLDivElement>) => {
    closePicker();
    const nextValue = readEditorValue(event.currentTarget);
    const normalizedValue = isComposingRef.current
      ? null
      : normalizeReferenceShortcuts(
        event.currentTarget,
        nextValue,
        getSelectionOffset(event.currentTarget),
        false
      );
    onBlur?.(normalizedValue ?? nextValue);
  }, [closePicker, normalizeReferenceShortcuts, onBlur]);

  const handlePaste = useCallback((event: ClipboardEvent<HTMLDivElement>) => {
    const text = event.clipboardData.getData('text/plain');
    if (!text) {
      return;
    }
    event.preventDefault();
    document.execCommand('insertText', false, text);
  }, []);

  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    // Some IMEs report keyCode 229 for punctuation even when they emit a real
    // `@` character. Handle the trigger before the composition-key fallback.
    if (
      isImageReferenceTrigger(event)
      && event.nativeEvent.isComposing !== true
      && imageInputs.length > 0
    ) {
      event.preventDefault();
      openPicker();
      return;
    }

    if (isCompositionKeyboardEvent(event)) {
      return;
    }

    const root = rootRef.current;
    if (!root) {
      return;
    }

    if (event.key === 'Backspace' || event.key === 'Delete') {
      const selection = getSelectionOffsets(root);
      if (selection) {
        const range = findDeletionRange(
          value,
          selection.start,
          selection.end,
          event.key === 'Backspace' ? 'backward' : 'forward'
        );
        if (range) {
          event.preventDefault();
          const result = removeImageReferencePromptToken(value, range.start, range.end);
          pendingSelectionOffsetRef.current = result.nextOffset;
          emitValue(result.nextText, false);
          requestAnimationFrame(() => {
            root.focus();
            setSelectionOffset(root, result.nextOffset);
          });
          return;
        }
      }
    }

    const pickerIsOpen = pickerOpenRef.current;
    if (pickerIsOpen) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActivePickerIndex(
          moveImageReferencePickerIndex(
            pickerActiveIndexRef.current,
            imageInputs.length,
            'next'
          )
        );
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActivePickerIndex(
          moveImageReferencePickerIndex(
            pickerActiveIndexRef.current,
            imageInputs.length,
            'previous'
          )
        );
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        insertReference(pickerActiveIndexRef.current);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        closePicker();
        return;
      }
    }

    if (
      !pickerIsOpen
      && !event.shiftKey
      && !event.altKey
      && !event.ctrlKey
      && !event.metaKey
      && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')
    ) {
      const selection = getSelectionOffsets(root);
      const nextOffset = selection
        ? resolveImageReferenceCursorMove(
          value,
          selection,
          event.key === 'ArrowLeft' ? 'backward' : 'forward'
        )
        : null;
      if (nextOffset !== null) {
        event.preventDefault();
        setSelectionOffset(
          root,
          nextOffset,
          event.key === 'ArrowLeft' ? 'before' : 'after'
        );
        return;
      }
    }

    onKeyDown?.(event);
  }, [closePicker, emitValue, imageInputs.length, insertReference, onKeyDown, openPicker, setActivePickerIndex, value]);

  const stopPropagation = useCallback((event: MouseEvent<HTMLDivElement>) => {
    event.stopPropagation();
  }, []);

  return (
    <div className="relative h-full min-h-0">
      <div
        ref={rootRef}
        contentEditable={!disabled}
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label={ariaLabel}
        aria-disabled={disabled || undefined}
        data-placeholder={isVisuallyEmpty ? placeholder : undefined}
        onBeforeInput={handleBeforeInput}
        onInput={handleInput}
        onKeyDown={handleKeyDown}
        onCompositionStart={handleCompositionStart}
        onCompositionEnd={handleCompositionEnd}
        onBlur={handleBlur}
        onPaste={handlePaste}
        onMouseDown={stopPropagation}
        className={`ui-scrollbar nodrag nowheel h-full min-h-0 w-full overflow-y-auto overflow-x-hidden whitespace-pre-wrap break-words border-0 bg-transparent px-3 py-2 text-sm leading-6 text-text-dark outline-none empty:before:text-text-muted/65 before:pointer-events-none before:content-[attr(data-placeholder)] ${disabled ? 'cursor-default opacity-70' : ''} ${className}`}
      />

      {showPicker && imageInputs.length > 0 && (
        <div
          ref={pickerRef}
          className="nowheel absolute z-30 w-[172px] overflow-hidden rounded-[10px] border border-[var(--ui-border-soft)] bg-[var(--ui-surface-elevated)] shadow-[var(--ui-shadow-panel)]"
          style={{ left: pickerAnchor.left, top: pickerAnchor.top }}
          onMouseDown={(event) => event.preventDefault()}
          onWheelCapture={(event) => event.stopPropagation()}
        >
          <div className="ui-scrollbar nowheel max-h-[180px] overflow-y-auto">
            {imageInputs.map((item, index) => {
              const label = t('node.imageReference.label', { index: index + 1 });
              const previewSource = item.previewImageUrl || item.imageUrl;
              return (
                <button
                  key={item.edgeId}
                  type="button"
                  onClick={() => insertReference(index)}
                  onMouseEnter={() => setActivePickerIndex(index)}
                  data-active={pickerActiveIndex === index || undefined}
                  className={`relative flex w-full items-center gap-2 border-0 border-b border-[var(--ui-border-soft)] px-2 py-2 text-left text-sm text-text-dark transition-colors last:border-b-0 before:absolute before:bottom-2 before:left-0 before:top-2 before:w-0.5 before:rounded-full before:bg-accent before:opacity-0 before:transition-opacity ${pickerActiveIndex === index
                    ? 'bg-[var(--ui-hover)] before:opacity-100'
                    : 'bg-transparent hover:bg-[var(--ui-hover)]'
                  }`}
                >
                  {previewSource ? (
                    <img
                      src={resolveImageDisplayUrl(previewSource)}
                      alt={label}
                      className="h-8 w-8 shrink-0 rounded object-cover"
                      draggable={false}
                    />
                  ) : (
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-red-500/15 text-red-300">!</span>
                  )}
                  <span>{label}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
});

ImageReferencePromptInput.displayName = 'ImageReferencePromptInput';
