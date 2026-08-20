import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { SlidersHorizontal } from '@/components/ui/icons';
import { useTranslation } from 'react-i18next';

import { UiChipButton, UiPanel, UiCheckbox, UiInput } from '@/components/ui';

export interface VideoAdvancedOptionsValue {
  shotType?: string;
  shotSize?: string;
  angle?: string;
  cameraMovement?: string;
  cameraSpeed?: string;
  hasAudio?: boolean;
  camerafixed?: boolean;
  watermark?: boolean;
  draft?: boolean;
  enableWebSearch?: boolean;
  seed?: number;
}

export interface VideoAdvancedOptionsCapabilities {
  supportsGenerateAudio: boolean;
  supportsDraft: boolean;
  supportsWebSearch: boolean;
  isSD2: boolean;
}

interface VideoAdvancedOptionsPopoverProps {
  value: VideoAdvancedOptionsValue;
  capabilities: VideoAdvancedOptionsCapabilities;
  showShotPresets: boolean;
  onChange: (partial: Partial<VideoAdvancedOptionsValue>) => void;
  onAppendToPrompt?: (value: string) => void;
  chipClassName?: string;
  triggerClassName?: string;
}

interface PanelAnchor {
  left: number;
  top: number;
  bottom: number;
}

const PANEL_WIDTH = 280;
const PANEL_PREFERRED_HEIGHT = 360;
const ANIMATION_DURATION_MS = 200;

const SHOT_TYPE_OPTIONS = [
  { value: '', labelKey: 'node.videoGen.auto' },
  { value: '固定镜头：摄像机位置固定，主体在画面中保持稳定', labelKey: 'node.videoGen.camerafixed' },
  { value: '手持镜头：模拟手持摄像机的轻微晃动，增加现场感', labelKey: 'node.videoGen.shotTypeHandheld' },
  { value: '围绕主体运镜：摄像机围绕主体旋转移动', labelKey: 'node.videoGen.shotTypeOrbit' },
  { value: '镜头拉远：逐渐扩大视野，拉远与主体的距离', labelKey: 'node.videoGen.shotTypePullOut' },
  { value: '镜头推进：逐渐缩小视野，靠近主体', labelKey: 'node.videoGen.shotTypePushIn' },
  { value: '镜头跟随：摄像机跟随主体移动', labelKey: 'node.videoGen.shotTypeFollow' },
  { value: '镜头右摇：摄像机水平向右摇动', labelKey: 'node.videoGen.shotTypePanRight' },
  { value: '镜头左摇：摄像机水平向左摇动', labelKey: 'node.videoGen.shotTypePanLeft' },
  { value: '镜头上摇：摄像机向上摇动', labelKey: 'node.videoGen.shotTypeTiltUp' },
  { value: '镜头下摇：摄像机向下摇动', labelKey: 'node.videoGen.shotTypeTiltDown' },
  { value: '镜头环绕：摄像机环绕主体做圆周运动', labelKey: 'node.videoGen.shotTypeCircle' },
];

const SHOT_SIZE_OPTIONS = [
  { value: '', labelKey: 'node.videoGen.auto' },
  { value: '近景', labelKey: 'node.videoGen.shotSizeClose' },
  { value: '中景', labelKey: 'node.videoGen.shotSizeMedium' },
  { value: '远景', labelKey: 'node.videoGen.shotSizeWide' },
  { value: '特写', labelKey: 'node.videoGen.shotSizeMacro' },
];

const ANGLE_OPTIONS = [
  { value: '', labelKey: 'node.videoGen.auto' },
  { value: '平视', labelKey: 'node.videoGen.angleEye' },
  { value: '仰视', labelKey: 'node.videoGen.angleLow' },
  { value: '俯视', labelKey: 'node.videoGen.angleHigh' },
];

const CAMERA_SPEED_OPTIONS = [
  { value: '', labelKey: 'node.videoGen.auto' },
  { value: '慢速', labelKey: 'node.videoGen.speedSlow' },
  { value: '中速', labelKey: 'node.videoGen.speedMedium' },
  { value: '快速', labelKey: 'node.videoGen.speedFast' },
];

function getPanelAnchor(triggerElement: HTMLButtonElement | null): PanelAnchor | null {
  if (!triggerElement) {
    return null;
  }
  const rect = triggerElement.getBoundingClientRect();
  return {
    left: rect.left + rect.width / 2,
    top: rect.top - 8,
    bottom: rect.bottom + 8,
  };
}

function buildPanelStyle(anchor: PanelAnchor | null): React.CSSProperties | undefined {
  if (!anchor) {
    return undefined;
  }
  const viewportWidth = Math.max(0, window.innerWidth);
  const viewportHeight = Math.max(0, window.innerHeight);
  const panelWidth = Math.min(PANEL_WIDTH, Math.max(0, viewportWidth - 24));
  const idealLeft = anchor.left - panelWidth / 2;
  const maxLeft = Math.max(12, viewportWidth - panelWidth - 12);
  const left = Math.min(Math.max(idealLeft, 12), maxLeft);
  const availableAbove = anchor.top - 12;
  const availableBelow = viewportHeight - anchor.bottom - 12;
  const showBelow =
    availableAbove < Math.min(PANEL_PREFERRED_HEIGHT, 220) && availableBelow > availableAbove;

  return {
    left,
    top: showBelow ? anchor.bottom : anchor.top,
    width: panelWidth,
    transform: showBelow ? undefined : 'translateY(-100%)',
  };
}

function PresetRow({
  label,
  options,
  currentValue,
  onSelect,
  t,
}: {
  label: string;
  options: { value: string; labelKey: string }[];
  currentValue: string | undefined;
  onSelect: (value: string) => void;
  t: (key: string) => string;
}) {
  return (
    <div>
      <div className="mb-1.5 text-[11px] font-medium text-text-muted">{label}</div>
      <div className="flex flex-wrap gap-1">
        {options.map((opt) => {
          const active = (currentValue ?? '') === opt.value;
          return (
            <button
              key={opt.labelKey}
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onSelect(opt.value);
              }}
              className={`rounded-md border px-2 py-0.5 text-[11px] transition-colors ${
                active
                  ? 'border-accent bg-accent text-[var(--accent-foreground)]'
                  : 'border-[var(--ui-border-soft)] bg-[var(--ui-surface-field)] text-text-dark hover:border-[var(--ui-border-strong)] hover:bg-[var(--ui-hover)]'
              }`}
            >
              {t(opt.labelKey)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ToggleRow({
  checked,
  disabled,
  label,
  tooltip,
  onCheckedChange,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  tooltip?: string;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <label
      className={`flex cursor-pointer items-center gap-2 text-xs text-text-dark ${disabled ? 'cursor-default opacity-50' : ''}`}
      title={disabled && tooltip ? tooltip : undefined}
    >
      <UiCheckbox
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
        aria-label={label}
      />
      <span>{label}</span>
    </label>
  );
}

export const VideoAdvancedOptionsPopover = memo(
  ({
    value,
    capabilities,
    showShotPresets,
    onChange,
    onAppendToPrompt,
    chipClassName = '',
    triggerClassName = '',
  }: VideoAdvancedOptionsPopoverProps) => {
    const { t } = useTranslation();
    const containerRef = useRef<HTMLDivElement>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const [open, setOpen] = useState(false);
    const [renderPanel, setRenderPanel] = useState(false);
    const [visible, setVisible] = useState(false);
    const [anchor, setAnchor] = useState<PanelAnchor | null>(null);

    useEffect(() => {
      let enterRaf1: number | null = null;
      let enterRaf2: number | null = null;
      let switchTimer: ReturnType<typeof setTimeout> | null = null;

      const startEnter = () => {
        enterRaf1 = requestAnimationFrame(() => {
          enterRaf2 = requestAnimationFrame(() => setVisible(true));
        });
      };

      if (!open) {
        setVisible(false);
        switchTimer = setTimeout(() => setRenderPanel(false), ANIMATION_DURATION_MS);
        return () => {
          if (switchTimer) clearTimeout(switchTimer);
          if (enterRaf1) cancelAnimationFrame(enterRaf1);
          if (enterRaf2) cancelAnimationFrame(enterRaf2);
        };
      }

      if (renderPanel) {
        startEnter();
        return () => {
          if (switchTimer) clearTimeout(switchTimer);
          if (enterRaf1) cancelAnimationFrame(enterRaf1);
          if (enterRaf2) cancelAnimationFrame(enterRaf2);
        };
      }

      setRenderPanel(true);
      startEnter();
      return () => {
        if (switchTimer) clearTimeout(switchTimer);
        if (enterRaf1) cancelAnimationFrame(enterRaf1);
        if (enterRaf2) cancelAnimationFrame(enterRaf2);
      };
    }, [open, renderPanel]);

    useEffect(() => {
      const handleOutside = (event: MouseEvent) => {
        const target = event.target as globalThis.Node;
        if (containerRef.current?.contains(target)) return;
        if (panelRef.current?.contains(target)) return;
        setOpen(false);
      };
      document.addEventListener('mousedown', handleOutside, true);
      return () => document.removeEventListener('mousedown', handleOutside, true);
    }, []);

    const handleTriggerClick = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      if (open) {
        setOpen(false);
        return;
      }
      setAnchor(getPanelAnchor(triggerRef.current));
      setRenderPanel(true);
      setOpen(true);
    }, [open]);

    const handlePresetSelect = useCallback(
      (field: keyof VideoAdvancedOptionsValue, optionValue: string, fallbackAppend?: string) => {
        const current = (value[field] ?? '') as string;
        const next = current === optionValue ? '' : optionValue;
        onChange({ [field]: next } as Partial<VideoAdvancedOptionsValue>);
        if (next && fallbackAppend && onAppendToPrompt) {
          onAppendToPrompt(fallbackAppend);
        }
      },
      [onChange, value, onAppendToPrompt],
    );

    const handleSeedChange = useCallback(
      (event: React.ChangeEvent<HTMLInputElement>) => {
        const seedValue = event.target.value;
        if (seedValue === '') {
          onChange({ seed: undefined });
        } else {
          const numValue = parseInt(seedValue, 10);
          if (!Number.isNaN(numValue)) {
            onChange({ seed: numValue });
          }
        }
      },
      [onChange],
    );

    const panelContent: ReactNode = (
      <UiPanel className="w-full p-3" style={{ width: '100%', minWidth: 0, maxWidth: '100%' }}>
        <div className="ui-scrollbar max-h-[min(440px,calc(100vh-24px))] space-y-3 overflow-y-auto p-1">
          {showShotPresets && (
            <>
              <PresetRow
                label={t('node.videoGen.shotType')}
                options={SHOT_TYPE_OPTIONS}
                currentValue={value.shotType}
                onSelect={(v) => handlePresetSelect('shotType', v, v)}
                t={t}
              />
              <PresetRow
                label={t('node.videoGen.shotSize')}
                options={SHOT_SIZE_OPTIONS}
                currentValue={value.shotSize}
                onSelect={(v) => handlePresetSelect('shotSize', v, v)}
                t={t}
              />
              <PresetRow
                label={t('node.videoGen.angle')}
                options={ANGLE_OPTIONS}
                currentValue={value.angle}
                onSelect={(v) => handlePresetSelect('angle', v, v)}
                t={t}
              />
              <PresetRow
                label={t('node.videoGen.cameraSpeed')}
                options={CAMERA_SPEED_OPTIONS}
                currentValue={value.cameraSpeed}
                onSelect={(v) => handlePresetSelect('cameraSpeed', v, v)}
                t={t}
              />
            </>
          )}

          <div className="space-y-2 border-t border-[var(--ui-border-soft)] pt-3">
            <ToggleRow
              checked={value.hasAudio ?? true}
              disabled={!capabilities.supportsGenerateAudio}
              label={t('node.videoGen.hasAudio')}
              tooltip={t('node.videoGen.modelNotSupported')}
              onCheckedChange={(checked) => onChange({ hasAudio: checked })}
            />
            <ToggleRow
              checked={value.camerafixed ?? false}
              disabled={capabilities.isSD2}
              label={t('node.videoGen.camerafixed')}
              tooltip={t('node.videoGen.camerafixedNotSupported')}
              onCheckedChange={(checked) => onChange({ camerafixed: checked })}
            />
            <ToggleRow
              checked={value.watermark ?? false}
              label={t('node.videoGen.watermark')}
              onCheckedChange={(checked) => onChange({ watermark: checked })}
            />
            {capabilities.supportsDraft && (
              <ToggleRow
                checked={value.draft ?? false}
                label={t('node.videoGen.draft')}
                onCheckedChange={(checked) => onChange({ draft: checked })}
              />
            )}
            {capabilities.supportsWebSearch && (
              <ToggleRow
                checked={value.enableWebSearch ?? false}
                label={t('node.videoGen.enableWebSearch')}
                onCheckedChange={(checked) => onChange({ enableWebSearch: checked })}
              />
            )}
          </div>

          <div className="border-t border-[var(--ui-border-soft)] pt-3">
            <div className="mb-1.5 text-[11px] font-medium text-text-muted">
              {t('node.videoGen.seed')}
            </div>
            <UiInput
              type="number"
              value={value.seed ?? ''}
              onChange={handleSeedChange}
              placeholder={t('node.videoGen.seedAuto')}
              className="h-8 text-xs [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            />
          </div>
        </div>
      </UiPanel>
    );

    return (
      <div ref={containerRef} className="nodrag nowheel relative flex">
        <UiChipButton
          ref={triggerRef}
          active={open}
          className={`${chipClassName} ${triggerClassName}`}
          onClick={handleTriggerClick}
        >
          <SlidersHorizontal className="h-2.5 w-2.5 shrink-0" />
          <span className="truncate text-[10px] leading-none">{t('node.videoGen.advancedOptions')}</span>
        </UiChipButton>

        {typeof document !== 'undefined' && renderPanel && createPortal(
          <div
            ref={panelRef}
            className={`fixed z-[80] transition-opacity duration-200 ease-out ${
              visible ? 'opacity-100' : 'pointer-events-none opacity-0'
            }`}
            style={buildPanelStyle(anchor)}
          >
            {panelContent}
          </div>,
          document.body,
        )}
      </div>
    );
  },
);

VideoAdvancedOptionsPopover.displayName = 'VideoAdvancedOptionsPopover';
