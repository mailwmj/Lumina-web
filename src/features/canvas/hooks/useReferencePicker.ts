import { useState, useCallback, useEffect, useRef, type RefObject } from 'react';
import {
  insertReferenceToken,
  resolveReferenceAwareDeleteRange,
  removeTextRange,
} from '@/features/canvas/application/referenceTokenEditing';

export interface PickerAnchor {
  left: number;
  top: number;
}

export const PICKER_FALLBACK_ANCHOR: PickerAnchor = { left: 8, top: 8 };
const PICKER_Y_OFFSET_PX = 20;

export interface ReferenceItem {
  type: 'image' | 'video' | 'audio';
  index: number;
  label: string;
  previewUrl?: string;
}

export interface UseReferencePickerOptions {
  rootRef: RefObject<HTMLDivElement | null>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  items: ReferenceItem[];
  prompt: string;
  onPromptChange: (newPrompt: string) => void;
  syncScroll?: () => void;
  maxImageCount?: number;
  maxVideoCount?: number;
  maxAudioCount?: number;
}

function getTextareaCaretOffset(
  textarea: HTMLTextAreaElement,
  caretIndex: number
): PickerAnchor {
  const mirror = document.createElement('div');
  const computed = window.getComputedStyle(textarea);
  const mirrorStyle = mirror.style;

  mirrorStyle.position = 'absolute';
  mirrorStyle.visibility = 'hidden';
  mirrorStyle.pointerEvents = 'none';
  mirrorStyle.whiteSpace = 'pre-wrap';
  mirrorStyle.overflowWrap = 'break-word';
  mirrorStyle.wordBreak = 'break-word';
  mirrorStyle.boxSizing = computed.boxSizing;
  mirrorStyle.width = `${textarea.clientWidth}px`;
  mirrorStyle.font = computed.font;
  mirrorStyle.lineHeight = computed.lineHeight;
  mirrorStyle.letterSpacing = computed.letterSpacing;
  mirrorStyle.padding = computed.padding;
  mirrorStyle.border = computed.border;
  mirrorStyle.textTransform = computed.textTransform;
  mirrorStyle.textIndent = computed.textIndent;

  mirror.textContent = textarea.value.slice(0, caretIndex);

  const marker = document.createElement('span');
  marker.textContent = textarea.value.slice(caretIndex, caretIndex + 1) || ' ';
  mirror.appendChild(marker);

  document.body.appendChild(mirror);

  const left = marker.offsetLeft - textarea.scrollLeft;
  const top = marker.offsetTop - textarea.scrollTop;

  document.body.removeChild(mirror);

  return {
    left: Math.max(0, left),
    top: Math.max(0, top),
  };
}

function resolvePickerAnchorImpl(
  container: HTMLDivElement | null,
  textarea: HTMLTextAreaElement,
  caretIndex: number
): PickerAnchor {
  if (!container) {
    return PICKER_FALLBACK_ANCHOR;
  }

  const containerRect = container.getBoundingClientRect();
  const textareaRect = textarea.getBoundingClientRect();
  const caretOffset = getTextareaCaretOffset(textarea, caretIndex);

  return {
    left: Math.max(0, textareaRect.left - containerRect.left + caretOffset.left),
    top: Math.max(0, textareaRect.top - containerRect.top + caretOffset.top + PICKER_Y_OFFSET_PX),
  };
}

export function useReferencePicker({
  rootRef,
  textareaRef,
  items,
  prompt,
  onPromptChange,
  syncScroll,
  maxImageCount = 9,
  maxVideoCount = 9,
  maxAudioCount = 9,
}: UseReferencePickerOptions) {
  const [showPicker, setShowPicker] = useState(false);
  const [pickerCursor, setPickerCursor] = useState<number | null>(null);
  const [pickerAnchor, setPickerAnchor] = useState<PickerAnchor>(PICKER_FALLBACK_ANCHOR);
  const [pickerActiveIndex, setPickerActiveIndex] = useState(0);
  const promptRef = useRef(prompt);

  // Keep promptRef in sync with prompt
  useEffect(() => {
    promptRef.current = prompt;
  }, [prompt]);

  const maxCount = Math.max(maxImageCount, maxVideoCount, maxAudioCount);

  // Insert reference at current cursor position
  const insertReference = useCallback((refType: 'image' | 'video' | 'audio', refIndex: number) => {
    const markers = { image: '图', video: '视频', audio: '音频' };
    const marker = `@${markers[refType]}${refIndex}`;
    const currentPrompt = promptRef.current;
    const cursor = pickerCursor ?? currentPrompt.length;
    const { nextText: nextPrompt, nextCursor } = insertReferenceToken(currentPrompt, cursor, marker);

    // Update prompt
    onPromptChange(nextPrompt);

    // Close picker
    setShowPicker(false);
    setPickerCursor(null);
    setPickerActiveIndex(0);

    // Focus and set cursor position
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(nextCursor, nextCursor);
      syncScroll?.();
    });
  }, [pickerCursor, onPromptChange, textareaRef, syncScroll]);

  // Handle keyboard events for @ picker
  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const currentPrompt = promptRef.current;
    const selectionStart = event.currentTarget.selectionStart ?? currentPrompt.length;
    const selectionEnd = event.currentTarget.selectionEnd ?? selectionStart;

    // Handle backspace/delete with reference awareness
    if (event.key === 'Backspace' || event.key === 'Delete') {
      const deletionDirection = event.key === 'Backspace' ? 'backward' : 'forward';
      const deleteRange = resolveReferenceAwareDeleteRange(
        currentPrompt,
        selectionStart,
        selectionEnd,
        deletionDirection,
        maxCount
      );
      if (deleteRange) {
        event.preventDefault();
        const { nextText, nextCursor } = removeTextRange(currentPrompt, deleteRange);
        onPromptChange(nextText);
        requestAnimationFrame(() => {
          textareaRef.current?.focus();
          textareaRef.current?.setSelectionRange(nextCursor, nextCursor);
          syncScroll?.();
        });
        return;
      }
    }

    // Keyboard navigation in picker
    if (showPicker && items.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setPickerActiveIndex((previous) => (previous + 1) % items.length);
        return;
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setPickerActiveIndex((previous) =>
          previous === 0 ? items.length - 1 : previous - 1
        );
        return;
      }

      if (event.key === 'Enter') {
        event.preventDefault();
        const item = items[pickerActiveIndex];
        if (item) {
          insertReference(item.type, item.index);
        }
        return;
      }
    }

    // Show picker on @ key
    if (event.key === '@' && items.length > 0) {
      event.preventDefault();
      const cursor = event.currentTarget.selectionStart ?? promptRef.current.length;
      setPickerAnchor(resolvePickerAnchorImpl(rootRef.current, event.currentTarget, cursor));
      setPickerCursor(cursor);
      setShowPicker(true);
      setPickerActiveIndex(0);
      return;
    }

    // Close picker on Escape
    if (event.key === 'Escape' && showPicker) {
      event.preventDefault();
      setShowPicker(false);
      setPickerCursor(null);
      setPickerActiveIndex(0);
      return;
    }
  }, [showPicker, items, pickerActiveIndex, insertReference, rootRef, maxCount, textareaRef, syncScroll]);

  // Close picker when clicking outside
  useEffect(() => {
    const handleOutside = (event: MouseEvent) => {
      if (rootRef.current?.contains(event.target as globalThis.Node)) {
        return;
      }
      setShowPicker(false);
      setPickerCursor(null);
    };
    document.addEventListener('mousedown', handleOutside, true);
    return () => {
      document.removeEventListener('mousedown', handleOutside, true);
    };
  }, [rootRef]);

  return {
    showPicker,
    pickerAnchor,
    pickerActiveIndex,
    pickerActiveIndexSetter: setPickerActiveIndex,
    handleKeyDown,
    insertReference,
  };
}
