import {
  memo,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent,
  type WheelEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { AlertTriangle, AtSign, Unlink2, X } from '@/components/ui/icons';
import type {
  ResolvedImageInput,
  ResolvedTextInput,
} from '@/features/canvas/application/textGenerationInputs';
import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';

type InputKind = 'text' | 'image';

interface DraggedInput {
  kind: InputKind;
  sourceId: string;
}

interface TextGenerationUpstreamContextProps {
  textInputs: ResolvedTextInput[];
  imageInputs: ResolvedImageInput[];
  textContextHeight: number;
  referenceImagesHeight: number;
  onLocate: (nodeId: string) => void;
  onDisconnect: (edgeId: string) => void;
  onInsertReference: (edgeId: string) => void;
  onReorder: (
    kind: InputKind,
    draggedSourceId: string,
    targetSourceId: string
  ) => void;
}

export const TextGenerationUpstreamContext = memo(({
  textInputs,
  imageInputs,
  textContextHeight,
  referenceImagesHeight,
  onLocate,
  onDisconnect,
  onInsertReference,
  onReorder,
}: TextGenerationUpstreamContextProps) => {
  const { t } = useTranslation();
  const draggedInputRef = useRef<DraggedInput | null>(null);
  const referenceImagesRef = useRef<HTMLDivElement | null>(null);
  const [referenceScroll, setReferenceScroll] = useState({
    hasOverflow: false,
    maxScrollLeft: 0,
    scrollLeft: 0,
    thumbWidthPercent: 100,
  });

  const updateReferenceScroll = useCallback(() => {
    const element = referenceImagesRef.current;
    if (!element) {
      return;
    }
    const maxScrollLeft = Math.max(0, element.scrollWidth - element.clientWidth);
    const hasOverflow = maxScrollLeft > 1;
    const thumbWidthPercent = hasOverflow
      ? Math.max(14, (element.clientWidth / element.scrollWidth) * 100)
      : 100;
    setReferenceScroll((previous) => {
      const next = {
        hasOverflow,
        maxScrollLeft,
        scrollLeft: Math.min(maxScrollLeft, element.scrollLeft),
        thumbWidthPercent,
      };
      return previous.hasOverflow === next.hasOverflow
        && previous.maxScrollLeft === next.maxScrollLeft
        && previous.scrollLeft === next.scrollLeft
        && previous.thumbWidthPercent === next.thumbWidthPercent
        ? previous
        : next;
    });
  }, []);

  useLayoutEffect(() => {
    const element = referenceImagesRef.current;
    if (!element) {
      return;
    }
    updateReferenceScroll();
    const observer = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(updateReferenceScroll);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, [imageInputs.length, updateReferenceScroll]);

  if (textInputs.length === 0 && imageInputs.length === 0) {
    return null;
  }

  const startDrag = (
    event: DragEvent<HTMLElement>,
    kind: InputKind,
    sourceId: string
  ) => {
    draggedInputRef.current = { kind, sourceId };
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', `${kind}:${sourceId}`);
  };

  const dropOn = (
    event: DragEvent<HTMLElement>,
    kind: InputKind,
    targetSourceId: string
  ) => {
    event.preventDefault();
    const dragged = draggedInputRef.current;
    draggedInputRef.current = null;
    if (dragged?.kind === kind && dragged.sourceId !== targetSourceId) {
      onReorder(kind, dragged.sourceId, targetSourceId);
    }
  };

  const handleReferenceImageWheel = (event: WheelEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    if (element.scrollWidth <= element.clientWidth) {
      return;
    }
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY)
      ? event.deltaX
      : event.deltaY;
    if (delta === 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    element.scrollLeft += delta;
  };

  const singleTextInput = textInputs.length === 1 ? textInputs[0] ?? null : null;

  return (
    <>
      {textInputs.length > 0 && (
        <section className="min-w-0 shrink-0" aria-label={t('node.textGeneration.upstreamText')}>
          <div className="mb-1 text-[10px] font-medium text-text-muted">
            {t('node.textGeneration.upstreamText')}
          </div>
          <div
            className={`nodrag nowheel rounded-lg border border-[var(--ui-border-soft)] bg-[var(--ui-surface-field)]/70 ${
              singleTextInput ? 'overflow-hidden' : 'ui-scrollbar-y space-y-1 overflow-x-hidden overflow-y-auto p-1.5'
            }`}
            style={{ height: textContextHeight }}
          >
            {singleTextInput ? (
              <article
                onClick={(event) => {
                  event.stopPropagation();
                  onLocate(singleTextInput.nodeId);
                }}
                className="nodrag nowheel group/input relative h-full min-h-0 cursor-pointer text-left"
              >
                <div
                  className="ui-scrollbar-y h-full overflow-x-hidden overflow-y-auto break-words px-2.5 py-2 pr-7 text-[11px] leading-4 text-text-dark"
                >
                  {singleTextInput.text}
                </div>
                <button
                  type="button"
                  aria-label={t('node.textGeneration.disconnectInput')}
                  className="nodrag nowheel absolute right-1.5 top-1.5 rounded p-0.5 text-text-muted opacity-0 hover:bg-[var(--ui-hover)] hover:text-text-dark group-hover/input:opacity-100 focus-visible:opacity-100"
                  onClick={(event) => {
                    event.stopPropagation();
                    onDisconnect(singleTextInput.edgeId);
                  }}
                >
                  <Unlink2 className="h-3 w-3" />
                </button>
              </article>
            ) : textInputs.map((input) => (
              <article
                key={input.edgeId}
                draggable
                onDragStart={(event) => startDrag(event, 'text', input.nodeId)}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => dropOn(event, 'text', input.nodeId)}
                onClick={(event) => {
                  event.stopPropagation();
                  onLocate(input.nodeId);
                }}
                className="nodrag nowheel group/input relative cursor-grab rounded-md border border-[var(--ui-border-soft)] bg-surface-dark/65 px-2 py-1.5 text-left active:cursor-grabbing hover:border-[var(--ui-border-strong)]"
              >
                <div
                  className="overflow-hidden break-words pr-4 text-[11px] leading-4 text-text-dark"
                  style={{ display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 3 }}
                >
                  {input.text}
                </div>
                <button
                  type="button"
                  aria-label={t('node.textGeneration.disconnectInput')}
                  className="nodrag nowheel absolute right-1 top-1 rounded p-0.5 text-text-muted opacity-0 hover:bg-[var(--ui-hover)] hover:text-text-dark group-hover/input:opacity-100 focus-visible:opacity-100"
                  onClick={(event) => {
                    event.stopPropagation();
                    onDisconnect(input.edgeId);
                  }}
                >
                  <Unlink2 className="h-3 w-3" />
                </button>
              </article>
            ))}
          </div>
        </section>
      )}

      {imageInputs.length > 0 && (
        <section className="min-w-0 shrink-0" aria-label={t('node.textGeneration.upstreamImages')}>
          <div className="mb-1 text-[10px] font-medium text-text-muted">
            {t('node.textGeneration.upstreamImages')}
          </div>
          <div className="relative">
            <div
              ref={referenceImagesRef}
              className="no-scrollbar nowheel flex min-w-0 gap-1.5 overflow-x-auto overflow-y-hidden rounded-lg border border-[var(--ui-border-soft)] bg-[var(--ui-surface-field)]/70 p-2 pb-3"
              style={{ height: referenceImagesHeight }}
              onScroll={updateReferenceScroll}
              onWheel={handleReferenceImageWheel}
            >
              {imageInputs.map((input, index) => (
                <ReferenceImageCard
                  key={input.edgeId}
                  input={input}
                  index={index}
                  referenceLabel={t('node.imageReference.label', { index: index + 1 })}
                  disconnectLabel={t('node.textGeneration.removeReference')}
                  insertLabel={t('node.textGeneration.insertReference')}
                  onDragStart={startDrag}
                  onDrop={dropOn}
                  onDisconnect={onDisconnect}
                  onInsertReference={onInsertReference}
                  onLocate={onLocate}
                />
              ))}
            </div>
            {referenceScroll.hasOverflow && (
              <div
                aria-hidden="true"
                className="pointer-events-none absolute bottom-1.5 left-2 right-2 h-1 rounded-full bg-[var(--ui-border-soft)]"
              >
                <div
                  className="h-full rounded-full bg-text-muted/80"
                  style={{
                    width: `${referenceScroll.thumbWidthPercent}%`,
                    marginLeft: `${(100 - referenceScroll.thumbWidthPercent) * (
                      referenceScroll.scrollLeft / referenceScroll.maxScrollLeft
                    )}%`,
                  }}
                />
              </div>
            )}
          </div>
        </section>
      )}
    </>
  );
});

interface ReferenceImageCardProps {
  input: ResolvedImageInput;
  index: number;
  referenceLabel: string;
  disconnectLabel: string;
  insertLabel: string;
  onDragStart: (event: DragEvent<HTMLElement>, kind: InputKind, sourceId: string) => void;
  onDrop: (event: DragEvent<HTMLElement>, kind: InputKind, targetSourceId: string) => void;
  onDisconnect: (edgeId: string) => void;
  onInsertReference: (edgeId: string) => void;
  onLocate: (nodeId: string) => void;
}

const ReferenceImageCard = memo(({
  input,
  index,
  referenceLabel,
  disconnectLabel,
  insertLabel,
  onDragStart,
  onDrop,
  onDisconnect,
  onInsertReference,
  onLocate,
}: ReferenceImageCardProps) => {
  const [isHovered, setIsHovered] = useState(false);
  const [previewLayout, setPreviewLayout] = useState({
    left: 0,
    top: 0,
    width: 320,
    height: 240,
  });
  const cardRef = useRef<HTMLElement | null>(null);
  const preview = input.previewImageUrl || input.imageUrl;

  const updatePreviewPosition = useCallback(() => {
    const card = cardRef.current;
    if (!card) {
      return;
    }
    const rect = card.getBoundingClientRect();
    const width = Math.min(320, window.innerWidth - 16);
    const height = Math.min(240, window.innerHeight - 16);
    const preferredTop = rect.top >= height + 16 ? rect.top - height - 8 : rect.bottom + 8;
    setPreviewLayout({
      left: Math.max(8, Math.min(window.innerWidth - width - 8, rect.left + rect.width / 2 - width / 2)),
      top: Math.max(8, Math.min(window.innerHeight - height - 8, preferredTop)),
      width,
      height,
    });
  }, []);

  useLayoutEffect(() => {
    if (!isHovered) {
      return;
    }
    updatePreviewPosition();
    window.addEventListener('resize', updatePreviewPosition);
    window.addEventListener('scroll', updatePreviewPosition, true);
    return () => {
      window.removeEventListener('resize', updatePreviewPosition);
      window.removeEventListener('scroll', updatePreviewPosition, true);
    };
  }, [isHovered, updatePreviewPosition]);

  return (
    <article
      ref={cardRef}
      draggable
      title={referenceLabel}
      onMouseEnter={() => {
        updatePreviewPosition();
        setIsHovered(true);
      }}
      onMouseLeave={() => setIsHovered(false)}
      onClick={(event) => event.stopPropagation()}
      onDragStart={(event) => onDragStart(event, 'image', input.nodeId)}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => onDrop(event, 'image', input.nodeId)}
      onDoubleClick={(event) => {
        event.stopPropagation();
        onLocate(input.nodeId);
      }}
      className="nodrag nowheel group/input relative h-16 w-16 shrink-0 cursor-grab rounded-md border border-[var(--ui-border-soft)] bg-bg-dark active:cursor-grabbing hover:border-[var(--ui-border-strong)]"
    >
      {preview ? (
        <img
          src={resolveImageDisplayUrl(preview)}
          alt={referenceLabel}
          className="h-full w-full rounded-[inherit] object-cover"
          draggable={false}
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center rounded-[inherit] text-red-300">
          <AlertTriangle className="h-4 w-4" />
        </div>
      )}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute bottom-0.5 right-0.5 z-10 flex h-5 min-w-5 items-center justify-center rounded-full border border-white/25 bg-black/70 px-1 text-[10px] font-semibold leading-none text-white shadow-md backdrop-blur-sm transition-opacity group-hover/input:opacity-0"
      >
        {index + 1}
      </span>
      <button
        type="button"
        aria-label={disconnectLabel}
        title={disconnectLabel}
        className="nodrag nowheel absolute right-0.5 top-0.5 z-20 rounded bg-black/60 p-0.5 text-white opacity-0 transition-opacity hover:bg-black/80 group-hover/input:opacity-100 focus-visible:opacity-100"
        onClick={(event) => {
          event.stopPropagation();
          onDisconnect(input.edgeId);
        }}
        onDoubleClick={(event) => event.stopPropagation()}
      >
        <X className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        aria-label={insertLabel}
        title={insertLabel}
        className="nodrag nowheel absolute left-1/2 top-1/2 z-20 flex h-7 w-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-white/60 bg-black/65 text-white opacity-0 shadow-md transition-opacity hover:bg-accent hover:text-accent-foreground group-hover/input:opacity-100 focus-visible:opacity-100"
        onClick={(event) => {
          event.stopPropagation();
          onInsertReference(input.edgeId);
        }}
        onDoubleClick={(event) => event.stopPropagation()}
      >
        <AtSign className="h-4 w-4" />
      </button>
      {isHovered && preview && createPortal(
        <div
          aria-hidden="true"
          className="pointer-events-none fixed z-[100] flex items-center justify-center overflow-hidden rounded-lg border border-[var(--ui-border-strong)] bg-[var(--ui-surface-elevated)] p-1 shadow-[var(--ui-shadow-panel)]"
          style={{
            left: previewLayout.left,
            top: previewLayout.top,
            width: previewLayout.width,
            height: previewLayout.height,
          }}
        >
          <img
            src={resolveImageDisplayUrl(preview)}
            alt=""
            className="max-h-full max-w-full rounded-md object-contain"
            draggable={false}
          />
        </div>,
        document.body
      )}
    </article>
  );
});

ReferenceImageCard.displayName = 'ReferenceImageCard';

TextGenerationUpstreamContext.displayName = 'TextGenerationUpstreamContext';
