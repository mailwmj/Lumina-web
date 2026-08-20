import {
  cloneElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

interface UiTooltipProps {
  content: ReactNode;
  children: ReactElement<{ 'aria-describedby'?: string }>;
  delay?: number;
}

interface TooltipPosition {
  left: number;
  top: number;
  placement: 'top' | 'bottom';
}

const TOOLTIP_MARGIN_PX = 8;
const TOOLTIP_GAP_PX = 8;

export function UiTooltip({ content, children, delay = 420 }: UiTooltipProps) {
  const id = useId();
  const triggerRef = useRef<HTMLSpanElement>(null);
  const openTimerRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [position, setPosition] = useState<TooltipPosition | null>(null);

  const clearOpenTimer = useCallback(() => {
    if (openTimerRef.current) {
      window.clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
  }, []);

  const updatePosition = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }
    const estimatedHalfWidth = 96;
    const left = Math.min(
      window.innerWidth - TOOLTIP_MARGIN_PX - estimatedHalfWidth,
      Math.max(TOOLTIP_MARGIN_PX + estimatedHalfWidth, rect.left + rect.width / 2)
    );
    const useBottom = rect.top < 48;
    setPosition({
      left,
      top: useBottom ? rect.bottom + TOOLTIP_GAP_PX : rect.top - TOOLTIP_GAP_PX,
      placement: useBottom ? 'bottom' : 'top',
    });
  }, []);

  const scheduleOpen = useCallback(() => {
    clearOpenTimer();
    openTimerRef.current = window.setTimeout(() => {
      updatePosition();
      setIsOpen(true);
    }, delay);
  }, [clearOpenTimer, delay, updatePosition]);

  const close = useCallback(() => {
    clearOpenTimer();
    setIsOpen(false);
  }, [clearOpenTimer]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [isOpen, updatePosition]);

  useEffect(() => clearOpenTimer, [clearOpenTimer]);

  const describedBy = [children.props['aria-describedby'], isOpen ? id : null]
    .filter(Boolean)
    .join(' ') || undefined;

  return (
    <>
      <span
        ref={triggerRef}
        className="inline-flex"
        onMouseEnter={scheduleOpen}
        onMouseLeave={close}
        onFocusCapture={scheduleOpen}
        onBlurCapture={close}
      >
        {cloneElement(children, { 'aria-describedby': describedBy })}
      </span>
      {isOpen && position && typeof document !== 'undefined'
        ? createPortal(
            <div
              id={id}
              role="tooltip"
              className="pointer-events-none fixed z-[220] max-w-48 whitespace-normal rounded-md border border-[var(--ui-border-soft)] bg-[var(--ui-surface-elevated)] px-2 py-1 text-center text-[11px] leading-4 text-text-dark shadow-[var(--ui-shadow-tooltip)]"
              style={{
                left: position.left,
                top: position.top,
                transform: position.placement === 'top'
                  ? 'translate(-50%, -100%)'
                  : 'translate(-50%, 0)',
              }}
            >
              {content}
            </div>,
            document.body
          )
        : null}
    </>
  );
}
