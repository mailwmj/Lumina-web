import {
  Children,
  forwardRef,
  isValidElement,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ChangeEvent,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { createPortal } from 'react-dom';
import { Cancel01Icon, CheckmarkCircle02Icon, ChevronDownIcon } from '@hugeicons/core-free-icons';
import {
  UI_CONTENT_OVERLAY_INSET_CLASS,
  UI_DIALOG_TRANSITION_MS,
  UI_POPOVER_TRANSITION_MS,
} from './motion';
import { useDialogTransition } from './useDialogTransition';
import { UiIcon } from './Icon';
import { UiTooltip } from './Tooltip';
import {
  resolveSelectMenuHorizontalGeometry,
  resolveSelectMenuVerticalGeometry,
} from './selectMenuGeometry';

type ButtonVariant = 'primary' | 'muted' | 'ghost' | 'danger';

type ButtonSize = 'sm' | 'md';

interface UiButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

interface UiIconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean;
  label: string;
  tooltip?: string;
}

interface UiChipButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean;
}

interface UiCheckboxProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange'> {
  checked: boolean;
  onCheckedChange?: (checked: boolean) => void;
}

interface UiSelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  menuMinWidth?: number;
  compact?: boolean;
}

interface UiSelectOption {
  value: string;
  label: ReactNode;
  disabled: boolean;
  disabledReason?: ReactNode;
}

interface UiModalProps {
  isOpen: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  widthClassName?: string;
  containerClassName?: string;
  closeLabel?: string;
  closeOnBackdrop?: boolean;
}

function resolveButtonVariant(variant: ButtonVariant): string {
  if (variant === 'primary') {
    return 'bg-accent text-[var(--accent-foreground)] hover:bg-accent/85';
  }

  if (variant === 'ghost') {
    return 'bg-transparent text-text-dark hover:bg-[var(--ui-hover)]';
  }

  if (variant === 'danger') {
    return 'bg-red-500 text-white hover:bg-red-600';
  }

  return 'border border-[var(--ui-border-soft)] bg-[var(--ui-surface-field)] text-text-dark hover:bg-[var(--ui-hover)]';
}

function resolveButtonSize(size: ButtonSize): string {
  return size === 'sm' ? 'h-8 px-3 text-xs' : 'h-10 px-3.5 text-sm';
}

export function UiButton({
  className = '',
  variant = 'muted',
  size = 'md',
  ...props
}: UiButtonProps) {
  return (
    <button
      className={`inline-flex items-center justify-center rounded-lg font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 disabled:cursor-not-allowed disabled:opacity-50 ${resolveButtonVariant(variant)} ${resolveButtonSize(size)} ${className}`}
      {...props}
    />
  );
}

export function UiIconButton({
  className = '',
  active = false,
  label,
  tooltip = label,
  type = 'button',
  ...props
}: UiIconButtonProps) {
  return (
    <UiTooltip content={tooltip}>
      <button
        type={type}
        aria-label={label}
        className={`inline-flex h-10 w-10 items-center justify-center border ui-field transition-colors ${active ? 'border-accent/45 bg-accent/18 text-accent' : 'text-text-muted hover:bg-[var(--ui-hover)] hover:text-text-dark'} ${className}`}
        {...props}
      />
    </UiTooltip>
  );
}

export const UiChipButton = forwardRef<HTMLButtonElement, UiChipButtonProps>(
  ({ className = '', active = false, ...props }, ref) => (
    <button
      ref={ref}
      className={`inline-flex h-10 items-center gap-2 border ui-field px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 ${active ? 'border-accent/45 bg-accent/15 text-text-dark' : 'text-text-dark hover:bg-[var(--ui-hover)]'} ${className}`}
      {...props}
    />
  )
);

UiChipButton.displayName = 'UiChipButton';

export function UiPanel({ className = '', ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={`border ui-panel ${className}`}
      {...props}
    />
  );
}

export function UiTextArea({ className = '', ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={`w-full resize-none border ui-field px-3 py-2.5 text-sm text-text-dark outline-none transition-colors placeholder:text-text-muted/70 focus-visible:border-accent/60 ${className}`}
      {...props}
    />
  );
}

export const UiTextAreaField = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className = '', ...props }, ref) => (
    <textarea
      ref={ref}
      className={`w-full resize-none border ui-field px-3 py-2.5 text-sm text-text-dark outline-none transition-colors placeholder:text-text-muted/70 focus-visible:border-accent/60 ${className}`}
      {...props}
    />
  )
);

UiTextAreaField.displayName = 'UiTextAreaField';

export const UiInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className = '', ...props }, ref) => (
    <input
      ref={ref}
      className={`w-full border ui-field px-3 py-2 text-sm text-text-dark outline-none transition-colors placeholder:text-text-muted/70 focus-visible:border-accent/60 ${className}`}
      {...props}
    />
  )
);

UiInput.displayName = 'UiInput';

export const UiCheckbox = forwardRef<HTMLButtonElement, UiCheckboxProps>(
  ({ className = '', checked, onCheckedChange, onClick, ...props }, ref) => (
    <button
      ref={ref}
      type="button"
      role="checkbox"
      aria-checked={checked}
      className={`inline-flex h-5 w-5 items-center justify-center rounded border transition-colors ${
        checked
          ? 'border-accent/60 bg-accent/20 text-accent'
          : 'border-[var(--ui-border-strong)] bg-[var(--ui-surface-field)] text-transparent hover:border-accent/45'
      } ${className}`}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) {
          onCheckedChange?.(!checked);
        }
      }}
      {...props}
    >
      <UiIcon icon={CheckmarkCircle02Icon} className="h-3.5 w-3.5" />
    </button>
  )
);

UiCheckbox.displayName = 'UiCheckbox';

export function UiSelect({ className = '', children, menuMinWidth, compact = false, ...props }: UiSelectProps) {
  const {
    value,
    defaultValue,
    onChange,
    onBlur,
    onFocus,
    disabled,
    name,
    'aria-label': ariaLabel,
    ...selectProps
  } = props;
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const hiddenSelectRef = useRef<HTMLSelectElement | null>(null);
  const listboxIdRef = useRef(`ui-select-${Math.random().toString(36).slice(2, 10)}`);
  const [isOpen, setIsOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState<{
    left: number;
    top: number;
    width: number;
    maxHeight: number;
  }>({
    left: 0,
    top: 0,
    width: 0,
    maxHeight: 0,
  });
  const { shouldRender: shouldRenderMenu, isVisible: isMenuVisible } = useDialogTransition(
    isOpen,
    UI_POPOVER_TRANSITION_MS
  );
  const parsedOptions = useMemo<UiSelectOption[]>(() => {
    return Children.toArray(children).flatMap((child) => {
      if (!isValidElement(child) || child.type !== 'option') {
        return [];
      }

      const optionValue = child.props.value ?? child.props.children;
      return [
        {
          value: String(optionValue ?? ''),
          label: child.props.children,
          disabled: Boolean(child.props.disabled),
          disabledReason: child.props['data-disabled-reason'],
        },
      ];
    });
  }, [children]);
  const initialValue = useMemo(() => {
    if (value != null) {
      return String(value);
    }

    if (defaultValue != null) {
      return String(defaultValue);
    }

    return parsedOptions.find((option) => !option.disabled)?.value ?? '';
  }, [defaultValue, parsedOptions, value]);
  const [uncontrolledValue, setUncontrolledValue] = useState(initialValue);
  const isControlled = value != null;
  const selectedValue = isControlled ? String(value) : uncontrolledValue;
  const selectedOption =
    parsedOptions.find((option) => option.value === selectedValue) ??
    parsedOptions.find((option) => !option.disabled) ??
    null;

  useEffect(() => {
    if (!isControlled) {
      setUncontrolledValue(initialValue);
    }
  }, [initialValue, isControlled]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const updatePosition = () => {
      const trigger = triggerRef.current;
      if (!trigger) {
        return;
      }

      const rect = trigger.getBoundingClientRect();
      const horizontalGeometry = resolveSelectMenuHorizontalGeometry(
        rect.left,
        rect.width,
        window.innerWidth,
        menuMinWidth
      );
      const verticalGeometry = resolveSelectMenuVerticalGeometry(
        rect.top,
        rect.bottom,
        parsedOptions.length,
        window.innerHeight
      );
      setMenuStyle({
        left: horizontalGeometry.left,
        top: verticalGeometry.top,
        width: horizontalGeometry.width,
        maxHeight: verticalGeometry.maxHeight,
      });
    };

    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [isOpen, menuMinWidth, parsedOptions.length]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (triggerRef.current?.contains(target ?? null)) {
        return;
      }

      const menuElement = document.getElementById(listboxIdRef.current);
      if (menuElement?.contains(target ?? null)) {
        return;
      }

      setIsOpen(false);
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
        triggerRef.current?.focus();
      }
    };

    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [isOpen]);

  const commitValue = (nextValue: string) => {
    if (!isControlled) {
      setUncontrolledValue(nextValue);
    }

    if (hiddenSelectRef.current) {
      hiddenSelectRef.current.value = nextValue;
    }

    onChange?.({
      target: { value: nextValue, name },
      currentTarget: { value: nextValue, name },
    } as ChangeEvent<HTMLSelectElement>);
  };

  const handleTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (disabled || parsedOptions.length === 0) {
      return;
    }

    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setIsOpen((current) => !current);
      return;
    }

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const enabledOptions = parsedOptions.filter((option) => !option.disabled);
      if (enabledOptions.length === 0) {
        return;
      }

      const currentIndex = enabledOptions.findIndex((option) => option.value === selectedValue);
      const fallbackIndex = event.key === 'ArrowDown' ? 0 : enabledOptions.length - 1;
      const nextIndex =
        currentIndex === -1
          ? fallbackIndex
          : (currentIndex + (event.key === 'ArrowDown' ? 1 : -1) + enabledOptions.length) %
            enabledOptions.length;
      commitValue(enabledOptions[nextIndex].value);
      setIsOpen(false);
    }
  };

  return (
    <div className="relative">
      <select
        ref={hiddenSelectRef}
        tabIndex={-1}
        aria-hidden="true"
        value={selectedValue}
        name={name}
        disabled={disabled}
        className="pointer-events-none absolute inset-0 opacity-0"
        onChange={() => undefined}
        {...selectProps}
      >
        {children}
      </select>
      <button
        ref={triggerRef}
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={listboxIdRef.current}
        disabled={disabled}
        className={`group inline-flex h-8 w-full items-center justify-between rounded-[6px] border border-[color:var(--ui-border-soft)] bg-[var(--ui-surface-field)] px-3 text-left text-xs font-medium text-text-dark outline-none transition-[border-color,background-color,box-shadow,color] hover:border-[color:var(--ui-border-strong)] focus-visible:border-accent focus-visible:shadow-[0_0_0_2px_rgba(var(--accent-rgb),0.12)] disabled:cursor-not-allowed disabled:opacity-55 ${className}`}
        onClick={() => {
          if (!disabled && parsedOptions.length > 0) {
            setIsOpen((current) => !current);
          }
        }}
        onKeyDown={handleTriggerKeyDown}
        onBlur={(event) => onBlur?.(event as never)}
        onFocus={(event) => onFocus?.(event as never)}
      >
        <span className={`min-w-0 truncate ${compact ? 'pr-0' : 'pr-3'}`}>
          {selectedOption?.label ?? ''}
        </span>
        <span className="flex h-4 w-4 shrink-0 items-center justify-center text-text-muted transition-colors group-hover:text-text-dark group-focus-visible:text-accent">
          <UiIcon
            icon={ChevronDownIcon}
            className={`h-3.5 w-3.5 transition-transform ${isOpen ? 'rotate-180' : ''}`}
            style={{ transitionDuration: `${UI_POPOVER_TRANSITION_MS}ms` }}
          />
        </span>
      </button>
      {shouldRenderMenu && typeof document !== 'undefined'
        ? createPortal(
            <div
              id={listboxIdRef.current}
              role="listbox"
              aria-label={ariaLabel}
              className={`fixed z-[140] overflow-hidden rounded-[6px] border border-[color:var(--ui-border-soft)] bg-[var(--ui-surface-panel)] p-1 shadow-[var(--ui-shadow-panel)] transition-[opacity,transform] ease-out ${
                isMenuVisible ? 'opacity-100 translate-y-0' : 'pointer-events-none opacity-0 -translate-y-1'
              }`}
              style={{
                left: menuStyle.left,
                top: menuStyle.top,
                width: menuStyle.width,
                maxHeight: menuStyle.maxHeight,
                transitionDuration: `${UI_POPOVER_TRANSITION_MS}ms`,
              }}
            >
              <div
                className="ui-scrollbar overflow-x-hidden overflow-y-auto"
                style={{ maxHeight: Math.max(0, menuStyle.maxHeight - 10) }}
              >
                {parsedOptions.map((option) => {
                  const isSelected = option.value === selectedValue;
                  const optionButton = (
                    <button
                      key={option.value}
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      aria-disabled={option.disabled || undefined}
                      tabIndex={option.disabled ? -1 : undefined}
                      className={`flex w-full items-center justify-between rounded-[4px] px-3 py-2 text-sm transition-colors ${
                        option.disabled
                          ? 'cursor-not-allowed opacity-40'
                          : isSelected
                            ? 'bg-accent text-[var(--accent-foreground)]'
                            : 'text-text-dark hover:bg-[var(--ui-hover)]'
                      }`}
                      onClick={() => {
                        if (option.disabled) {
                          return;
                        }
                        commitValue(option.value);
                        setIsOpen(false);
                        triggerRef.current?.focus();
                      }}
                    >
                      <span className="truncate">{option.label}</span>
                      {isSelected ? <UiIcon icon={CheckmarkCircle02Icon} className="ml-3 h-3.5 w-3.5 shrink-0" /> : null}
                    </button>
                  );
                  return option.disabled && option.disabledReason ? (
                    <UiTooltip key={option.value} content={option.disabledReason}>
                      {optionButton}
                    </UiTooltip>
                  ) : optionButton;
                })}
              </div>
            </div>,
            document.body
          )
        : null}
    </div>
  );
}

export function UiModal({
  isOpen,
  title,
  onClose,
  children,
  footer,
  widthClassName = 'w-[460px]',
  containerClassName = '',
  closeLabel = 'Close',
  closeOnBackdrop = true,
}: UiModalProps) {
  const { shouldRender, isVisible } = useDialogTransition(isOpen, UI_DIALOG_TRANSITION_MS);

  if (!shouldRender) {
    return null;
  }

  return (
    <div className={`fixed ${UI_CONTENT_OVERLAY_INSET_CLASS} z-50 flex items-center justify-center ${containerClassName}`}>
      <div
        data-testid="ui-modal-backdrop"
        className={`absolute inset-0 bg-black/55 transition-opacity duration-200 ${isVisible ? 'opacity-100' : 'opacity-0'}`}
        onClick={closeOnBackdrop ? onClose : undefined}
      />
      <UiPanel
        className={`relative transition-opacity duration-200 ${isVisible ? 'opacity-100' : 'opacity-0'} ${widthClassName}`}
      >
        <div className="flex items-center justify-between border-b border-[var(--ui-border-soft)] px-4 py-3">
          <h2 className="text-sm font-medium text-text-dark">{title}</h2>
          <UiIconButton label={closeLabel} className="h-8 w-8" onClick={onClose}>
            <UiIcon icon={Cancel01Icon} className="h-4 w-4" />
          </UiIconButton>
        </div>

        <div className="px-4 py-4">{children}</div>

        {footer && (
          <div className="flex justify-end gap-2 border-t border-[var(--ui-border-soft)] px-4 py-3">
            {footer}
          </div>
        )}
      </UiPanel>
    </div>
  );
}
