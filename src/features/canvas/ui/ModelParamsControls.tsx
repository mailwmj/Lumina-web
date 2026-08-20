import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { SlidersHorizontal, Zap } from '@/components/ui/icons';
import { useTranslation } from 'react-i18next';

import {
  AUTO_REQUEST_ASPECT_RATIO,
  IMAGE_OUTPUT_COUNTS,
  type ImageOutputCount,
} from '@/features/canvas/domain/canvasNodes';
import {
  getModelProvider,
  type AspectRatioOption,
  type ImageModelDefinition,
  type ResolutionOption,
} from '@/features/canvas/models';
import {
  UiChipButton,
  UiPanel,
  UiInput,
  UiCheckbox,
  UiSelect,
} from '@/components/ui';

interface ModelParamsControlsProps {
  imageModels: ImageModelDefinition[];
  selectedModel: ImageModelDefinition;
  resolutionOptions: ResolutionOption[];
  selectedResolution: ResolutionOption;
  selectedAspectRatio: AspectRatioOption;
  aspectRatioOptions: AspectRatioOption[];
  onModelChange: (modelId: string) => void;
  onResolutionChange: (resolution: string) => void;
  onAspectRatioChange: (aspectRatio: string) => void;
  outputCount?: ImageOutputCount;
  onOutputCountChange?: (outputCount: ImageOutputCount) => void;
  extraParams?: Record<string, unknown>;
  onExtraParamChange?: (key: string, value: boolean | number | string) => void;
  showWebSearchToggle?: boolean;
  webSearchEnabled?: boolean;
  onWebSearchToggle?: (enabled: boolean) => void;
  webSearchLabel?: string;
  showProviderName?: boolean;
  triggerSize?: 'md' | 'sm';
  chipClassName?: string;
  modelChipClassName?: string;
  paramsChipClassName?: string;
  modelPanelAlign?: 'center' | 'start';
  paramsPanelAlign?: 'center' | 'start';
  modelPanelClassName?: string;
  paramsPanelClassName?: string;
  providerOptionClassName?: string;
  modelOptionClassName?: string;
}

interface PanelAnchor {
  left: number;
  top: number;
  bottom: number;
}

const OTHER_PARAMS_PANEL_CLASS_NAME = 'w-[280px] p-3';
const DEFAULT_MODEL_PANEL_CLASS_NAME = 'w-full p-2';
const DEFAULT_PROVIDER_OPTION_CLASS_NAME =
  'w-full min-w-0 px-3 text-center';
const DEFAULT_MODEL_OPTION_CLASS_NAME =
  'min-h-9 w-full min-w-0 max-w-full justify-center px-3 py-2 text-center';

function getRatioPreviewStyle(ratio: string): { width: number; height: number } {
  const [rawW, rawH] = ratio.split(':').map((value) => Number(value));
  const width = Number.isFinite(rawW) && rawW > 0 ? rawW : 1;
  const height = Number.isFinite(rawH) && rawH > 0 ? rawH : 1;

  const box = 20;
  if (width >= height) {
    return {
      width: box,
      height: Math.max(8, Math.round((box * height) / width)),
    };
  }

  return {
    width: Math.max(8, Math.round((box * width) / height)),
    height: box,
  };
}

function resolveTranslatedText(
  t: (key: string) => string,
  key: string | undefined,
  fallback: string | undefined
): string {
  if (!key) {
    return fallback ?? '';
  }

  const translated = t(key);
  return translated === key ? (fallback ?? key) : translated;
}

function resolveExtraParamValue(
  key: string,
  extraParams: Record<string, unknown> | undefined,
  defaultExtraParams: Record<string, unknown> | undefined,
  schemaDefault: boolean | number | string | undefined
): boolean | number | string | undefined {
  const currentValue = extraParams?.[key];
  if (typeof currentValue === 'boolean' || typeof currentValue === 'number' || typeof currentValue === 'string') {
    return currentValue;
  }

  const modelDefaultValue = defaultExtraParams?.[key];
  if (
    typeof modelDefaultValue === 'boolean' ||
    typeof modelDefaultValue === 'number' ||
    typeof modelDefaultValue === 'string'
  ) {
    return modelDefaultValue;
  }

  return schemaDefault;
}

export const ModelParamsControls = memo(({
  imageModels,
  selectedModel,
  resolutionOptions,
  selectedResolution,
  selectedAspectRatio,
  aspectRatioOptions,
  onModelChange,
  onResolutionChange,
  onAspectRatioChange,
  outputCount,
  onOutputCountChange,
  extraParams,
  onExtraParamChange,
  showWebSearchToggle = false,
  webSearchEnabled = false,
  onWebSearchToggle,
  webSearchLabel,
  showProviderName = true,
  triggerSize = 'md',
  chipClassName = '',
  modelChipClassName = 'w-auto justify-start',
  paramsChipClassName = 'w-auto justify-start',
  modelPanelAlign = 'center',
  paramsPanelAlign = 'center',
  modelPanelClassName = DEFAULT_MODEL_PANEL_CLASS_NAME,
  paramsPanelClassName = 'w-[420px] p-3',
  providerOptionClassName = DEFAULT_PROVIDER_OPTION_CLASS_NAME,
  modelOptionClassName = DEFAULT_MODEL_OPTION_CLASS_NAME,
}: ModelParamsControlsProps) => {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const modelTriggerRef = useRef<HTMLDivElement>(null);
  const paramsTriggerRef = useRef<HTMLDivElement>(null);
  const otherParamsTriggerRef = useRef<HTMLDivElement>(null);
  const modelPanelRef = useRef<HTMLDivElement>(null);
  const paramsPanelRef = useRef<HTMLDivElement>(null);
  const otherParamsPanelRef = useRef<HTMLDivElement>(null);
  const [openPanel, setOpenPanel] = useState<'model' | 'params' | 'otherParams' | null>(null);
  const [renderPanel, setRenderPanel] = useState<'model' | 'params' | 'otherParams' | null>(null);
  const [isPanelVisible, setIsPanelVisible] = useState(false);
  const [modelPanelAnchor, setModelPanelAnchor] = useState<PanelAnchor | null>(null);
  const [paramsPanelAnchor, setParamsPanelAnchor] = useState<PanelAnchor | null>(null);
  const [otherParamsPanelAnchor, setOtherParamsPanelAnchor] = useState<PanelAnchor | null>(null);
  const [modelAnchorBaseWidth, setModelAnchorBaseWidth] = useState<number | null>(null);
  const [paramsAnchorBaseWidth, setParamsAnchorBaseWidth] = useState<number | null>(null);
  const [otherParamsAnchorBaseWidth, setOtherParamsAnchorBaseWidth] = useState<number | null>(null);
  const [panelProviderId, setPanelProviderId] = useState(selectedModel.providerId);

  const selectedProvider = useMemo(
    () => getModelProvider(selectedModel.providerId, selectedModel.providerName),
    [selectedModel.providerId, selectedModel.providerName]
  );
  const selectedModelName = useMemo(
    () => selectedModel.displayName.replace(/\s*\([^)]*\)\s*$/u, '').trim() || selectedModel.displayName,
    [selectedModel.displayName]
  );
  const selectedProviderName = selectedProvider.label || selectedProvider.name;
  const providerOptions = useMemo(() => {
    const providerOrder = ['kie', 'ppio', 'fal', 'grsai', 'bltcy'];
    const providerIndex = new Map(providerOrder.map((id, index) => [id, index]));
    const uniqueProviderIds = Array.from(new Set(imageModels.map((model) => model.providerId)));
    return uniqueProviderIds
      .map((providerId) => {
        const providerModel = imageModels.find((model) => model.providerId === providerId);
        return getModelProvider(providerId, providerModel?.providerName);
      })
      .sort((left, right) => {
        const leftIndex = providerIndex.get(left.id) ?? Number.MAX_SAFE_INTEGER;
        const rightIndex = providerIndex.get(right.id) ?? Number.MAX_SAFE_INTEGER;
        return leftIndex - rightIndex;
      });
  }, [imageModels]);
  const providerModels = useMemo(
    () => imageModels.filter((model) => model.providerId === panelProviderId),
    [imageModels, panelProviderId]
  );
  const modelGroups = useMemo(() => {
    const grouped = new Map<string, ImageModelDefinition[]>();
    providerModels.forEach((model) => {
      const normalizedName = model.displayName.replace(/\s*\([^)]*\)\s*$/u, '').trim();
      const key = normalizedName.length > 0 ? normalizedName : model.displayName;
      const current = grouped.get(key) ?? [];
      current.push(model);
      grouped.set(key, current);
    });
    return Array.from(grouped.entries())
      .map(([name, models]) => ({ name, models }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [providerModels]);
  const isCompactTrigger = triggerSize === 'sm';
  const paramsIconClassName = isCompactTrigger ? 'h-2.5 w-2.5 shrink-0' : 'h-4 w-4 shrink-0';
  const modelTextClassName = isCompactTrigger
    ? 'min-w-0 truncate font-mono text-[10px] font-medium leading-none'
    : 'min-w-0 truncate font-mono font-medium';
  const providerTextClassName = isCompactTrigger
    ? 'shrink-0 font-mono text-[10px] leading-none text-text-muted/80'
    : 'shrink-0 font-mono text-text-muted/80';
  const paramsPrimaryTextClassName = isCompactTrigger
    ? 'truncate text-[10px] leading-none'
    : 'truncate';
  const paramsSecondaryTextClassName = isCompactTrigger
    ? 'text-[10px] leading-none text-text-muted/80'
    : 'text-text-muted/80';
  const extraParamSchema = selectedModel.extraParamsSchema ?? [];
  const inlineExtraParamSchema = useMemo(
    () =>
      extraParamSchema.filter(
        (definition) => definition.key === 'thinking_level' && definition.type === 'enum'
      ),
    [extraParamSchema]
  );
  const panelExtraParamSchema = useMemo(
    () => extraParamSchema.filter((definition) => definition.key !== 'thinking_level'),
    [extraParamSchema]
  );
  const hasOtherParamsPanel = showWebSearchToggle || inlineExtraParamSchema.length > 0;

  useEffect(() => {
    const animationDurationMs = 200;
    let enterRaf1: number | null = null;
    let enterRaf2: number | null = null;
    let switchTimer: ReturnType<typeof setTimeout> | null = null;

    const startEnterAnimation = () => {
      enterRaf1 = requestAnimationFrame(() => {
        enterRaf2 = requestAnimationFrame(() => {
          setIsPanelVisible(true);
        });
      });
    };

    if (!openPanel) {
      setIsPanelVisible(false);
      switchTimer = setTimeout(() => setRenderPanel(null), animationDurationMs);
      return () => {
        if (switchTimer) {
          clearTimeout(switchTimer);
        }
        if (enterRaf1) {
          cancelAnimationFrame(enterRaf1);
        }
        if (enterRaf2) {
          cancelAnimationFrame(enterRaf2);
        }
      };
    }

    if (renderPanel && renderPanel !== openPanel) {
      setIsPanelVisible(false);
      switchTimer = setTimeout(() => {
        setRenderPanel(openPanel);
        startEnterAnimation();
      }, animationDurationMs);
      return () => {
        if (switchTimer) {
          clearTimeout(switchTimer);
        }
        if (enterRaf1) {
          cancelAnimationFrame(enterRaf1);
        }
        if (enterRaf2) {
          cancelAnimationFrame(enterRaf2);
        }
      };
    }

    if (!renderPanel) {
      setRenderPanel(openPanel);
    }
    startEnterAnimation();

    return () => {
      if (switchTimer) {
        clearTimeout(switchTimer);
      }
      if (enterRaf1) {
        cancelAnimationFrame(enterRaf1);
      }
      if (enterRaf2) {
        cancelAnimationFrame(enterRaf2);
      }
    };
  }, [openPanel, renderPanel]);

  useEffect(() => {
    const handleOutside = (event: MouseEvent) => {
      const target = event.target as globalThis.Node;
      if (containerRef.current?.contains(target)) {
        return;
      }
      if (modelPanelRef.current?.contains(target)) {
        return;
      }
      if (paramsPanelRef.current?.contains(target)) {
        return;
      }
      if (otherParamsPanelRef.current?.contains(target)) {
        return;
      }
      setOpenPanel(null);
    };

    document.addEventListener('mousedown', handleOutside, true);
    return () => {
      document.removeEventListener('mousedown', handleOutside, true);
    };
  }, []);

  const getPanelAnchor = (
    triggerElement: HTMLDivElement | null,
    align: 'center' | 'start',
    baseWidth?: number | null
  ): PanelAnchor | null => {
    if (!triggerElement) {
      return null;
    }
    const rect = triggerElement.getBoundingClientRect();
    const anchorWidth = typeof baseWidth === 'number' && baseWidth > 0 ? baseWidth : rect.width;
    return {
      left: align === 'center' ? rect.left + anchorWidth / 2 : rect.left,
      top: rect.top - 8,
      bottom: rect.bottom + 8,
    };
  };

  const buildPanelStyle = (
    anchor: PanelAnchor | null,
    align: 'center' | 'start',
    preferredWidth: number,
    preferredHeight: number
  ): React.CSSProperties | undefined => {
    if (!anchor) {
      return undefined;
    }

    const viewportWidth = Math.max(0, window.innerWidth);
    const viewportHeight = Math.max(0, window.innerHeight);
    const panelWidth = Math.min(preferredWidth, Math.max(0, viewportWidth - 24));
    const idealLeft = align === 'center' ? anchor.left - panelWidth / 2 : anchor.left;
    const maxLeft = Math.max(12, viewportWidth - panelWidth - 12);
    const left = Math.min(Math.max(idealLeft, 12), maxLeft);
    const availableAbove = anchor.top - 12;
    const availableBelow = viewportHeight - anchor.bottom - 12;
    const showBelow =
      availableAbove < Math.min(preferredHeight, 220) && availableBelow > availableAbove;

    return {
      left,
      top: showBelow ? anchor.bottom : anchor.top,
      width: panelWidth,
      transform: showBelow ? undefined : 'translateY(-100%)',
    };
  };

  return (
    <div ref={containerRef} className="nodrag nowheel flex items-center gap-1">
      <div ref={modelTriggerRef} className="relative flex">
        <UiChipButton
          active={openPanel === 'model'}
          className={`${chipClassName} ${modelChipClassName}`}
          onClick={(event) => {
            event.stopPropagation();
            if (openPanel === 'model') {
              setOpenPanel(null);
              return;
            }
            setPanelProviderId(selectedModel.providerId);
            const triggerWidth = modelTriggerRef.current?.getBoundingClientRect().width ?? null;
            const nextBaseWidth = modelAnchorBaseWidth ?? triggerWidth;
            if (modelAnchorBaseWidth == null && triggerWidth) {
              setModelAnchorBaseWidth(triggerWidth);
            }
            setModelPanelAnchor(getPanelAnchor(modelTriggerRef.current, modelPanelAlign, nextBaseWidth));
            setOpenPanel('model');
          }}
        >
          <span className={modelTextClassName}>{selectedModelName}</span>
          {showProviderName && (
            <span className={providerTextClassName}>{selectedProviderName}</span>
          )}
        </UiChipButton>
      </div>

      <div ref={paramsTriggerRef} className="relative flex">
        <UiChipButton
          active={openPanel === 'params'}
          className={`${chipClassName} ${paramsChipClassName}`}
          onClick={(event) => {
            event.stopPropagation();
            if (openPanel === 'params') {
              setOpenPanel(null);
              return;
            }
            const triggerWidth = paramsTriggerRef.current?.getBoundingClientRect().width ?? null;
            const nextBaseWidth = paramsAnchorBaseWidth ?? triggerWidth;
            if (paramsAnchorBaseWidth == null && triggerWidth) {
              setParamsAnchorBaseWidth(triggerWidth);
            }
            setParamsPanelAnchor(getPanelAnchor(paramsTriggerRef.current, paramsPanelAlign, nextBaseWidth));
            setOpenPanel('params');
          }}
        >
          <SlidersHorizontal className={paramsIconClassName} />
          <span className={`${paramsPrimaryTextClassName} font-mono`}>{selectedAspectRatio.label}</span>
          <span className={paramsSecondaryTextClassName}>· {selectedResolution.label}</span>
        </UiChipButton>
      </div>

      {hasOtherParamsPanel && (
        <div ref={otherParamsTriggerRef} className="relative flex">
          <UiChipButton
            active={openPanel === 'otherParams'}
            className={`${chipClassName} w-auto shrink-0 justify-center`}
            onClick={(event) => {
              event.stopPropagation();
              if (openPanel === 'otherParams') {
                setOpenPanel(null);
                return;
              }
              const triggerWidth = otherParamsTriggerRef.current?.getBoundingClientRect().width ?? null;
              const nextBaseWidth = otherParamsAnchorBaseWidth ?? triggerWidth;
              if (otherParamsAnchorBaseWidth == null && triggerWidth) {
                setOtherParamsAnchorBaseWidth(triggerWidth);
              }
              setOtherParamsPanelAnchor(
                getPanelAnchor(otherParamsTriggerRef.current, 'center', nextBaseWidth)
              );
              setOpenPanel('otherParams');
            }}
          >
            <SlidersHorizontal className={paramsIconClassName} />
            <span className={paramsPrimaryTextClassName}>{t('modelParams.otherParams')}</span>
          </UiChipButton>
        </div>
      )}

      {typeof document !== 'undefined' && renderPanel === 'model' && createPortal(
        <div
          ref={modelPanelRef}
          className={`fixed z-[80] transition-opacity duration-200 ease-out ${isPanelVisible ? 'opacity-100' : 'pointer-events-none opacity-0'
            }`}
          style={buildPanelStyle(modelPanelAnchor, modelPanelAlign, 760, 400)}
        >
          <UiPanel
            className={modelPanelClassName}
            style={{ width: '100%', minWidth: 0, maxWidth: '100%' }}
          >
            <div className="ui-scrollbar max-h-[min(420px,calc(100vh-24px))] space-y-4 overflow-x-hidden overflow-y-auto p-1">
              <section>
                <div className="mb-2 text-xs font-medium text-text-muted">
                  {t('modelParams.provider')}
                </div>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
                  {providerOptions.map((provider) => {
                    const active = provider.id === panelProviderId;
                    return (
                      <button
                        key={provider.id}
                        className={`h-8 rounded-lg border text-xs transition-colors ${providerOptionClassName} ${active
                          ? 'border-accent/50 bg-accent/15 text-text-dark'
                          : 'border-[var(--ui-border-soft)] bg-[var(--ui-surface-field)] text-text-muted hover:border-[var(--ui-border-strong)]'
                        }`}
                        onClick={(event) => {
                          event.stopPropagation();
                          if (provider.id !== panelProviderId) {
                            const firstModel = imageModels.find((model) => model.providerId === provider.id);
                            if (firstModel) {
                              onModelChange(firstModel.id);
                            }
                          }
                          setPanelProviderId(provider.id);
                        }}
                      >
                        {provider.label || provider.name}
                      </button>
                    );
                  })}
                </div>
              </section>

              <section>
                <div className="mb-2 text-xs font-medium text-text-muted">
                  {t('modelParams.model')}
                </div>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
                  {modelGroups.map((group) => {
                    const active = group.models.some((model) => model.id === selectedModel.id);
                    const targetModel = group.models.find((model) => model.id === selectedModel.id)
                      ?? group.models[0];
                    return (
                      <button
                        key={group.name}
                        className={`inline-flex w-full min-w-0 max-w-full items-center rounded-lg border text-xs leading-4 transition-colors ${modelOptionClassName} ${active
                          ? 'border-accent/50 bg-accent/15 text-text-dark'
                          : 'border-[var(--ui-border-soft)] bg-[var(--ui-surface-field)] text-text-muted hover:border-[var(--ui-border-strong)] hover:bg-[var(--ui-hover)]'
                          }`}
                        style={{ width: '100%', minWidth: 0, maxWidth: '100%' }}
                        onClick={(event) => {
                          event.stopPropagation();
                          onModelChange(targetModel.id);
                          setOpenPanel(null);
                        }}
                      >
                        <span className="min-w-0 max-w-full break-words text-center font-mono">{group.name}</span>
                      </button>
                    );
                  })}
                </div>
              </section>
            </div>
          </UiPanel>
        </div>,
        document.body
      )}

      {typeof document !== 'undefined' && renderPanel === 'params' && createPortal(
        <div
          ref={paramsPanelRef}
          className={`fixed z-[80] transition-opacity duration-200 ease-out ${isPanelVisible ? 'opacity-100' : 'pointer-events-none opacity-0'
            }`}
          style={buildPanelStyle(paramsPanelAnchor, paramsPanelAlign, 420, 460)}
        >
          <UiPanel
            className={paramsPanelClassName}
            style={{ width: '100%', minWidth: 0, maxWidth: '100%' }}
          >
            <div>
              <div className="mb-2 text-xs text-text-muted">{t('modelParams.quality')}</div>
              <div className="grid grid-cols-3 gap-1 rounded-[10px] border border-[var(--ui-border-soft)] bg-[var(--ui-surface-field)] p-1">
                {resolutionOptions.map((item) => {
                  const active = item.value === selectedResolution.value;
                  return (
                    <button
                      key={item.value}
                      className={`h-8 rounded-lg text-sm transition-colors ${active
                        ? 'bg-accent text-[var(--accent-foreground)]'
                        : 'text-text-muted hover:bg-[var(--ui-hover)]'
                        }`}
                      onClick={(event) => {
                        event.stopPropagation();
                        onResolutionChange(item.value);
                      }}
                    >
                      <span className="font-mono">{item.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="mt-3">
              <div className="mb-2 text-xs text-text-muted">{t('modelParams.aspectRatio')}</div>
              <div className="grid grid-cols-5 gap-1 rounded-[10px] border border-[var(--ui-border-soft)] bg-[var(--ui-surface-field)] p-1">
                {aspectRatioOptions.map((item) => {
                  const active = item.value === selectedAspectRatio.value;
                  const previewStyle = getRatioPreviewStyle(
                    item.value === AUTO_REQUEST_ASPECT_RATIO ? '1:1' : item.value
                  );

                  return (
                    <button
                      key={item.value}
                      className={`rounded-lg px-1 py-1.5 transition-colors ${active
                        ? 'bg-accent text-[var(--accent-foreground)]'
                        : 'text-text-muted hover:bg-[var(--ui-hover)]'
                        }`}
                      onClick={(event) => {
                        event.stopPropagation();
                        onAspectRatioChange(item.value);
                      }}
                    >
                      <div className="mb-1 flex h-6 items-center justify-center">
                        {item.value === AUTO_REQUEST_ASPECT_RATIO ? (
                          <Zap className="h-3 w-3" strokeWidth={2.4} />
                        ) : (
                          <span
                            className="inline-block rounded-[3px] border border-current/60"
                            style={previewStyle}
                          />
                        )}
                      </div>
                      <div className="font-mono text-[10px]">{item.label}</div>
                    </button>
                  );
                })}
              </div>
            </div>

            {outputCount !== undefined && onOutputCountChange && (
              <div className="mt-3">
                <div className="mb-2 text-xs text-text-muted">{t('modelParams.outputCount')}</div>
                <div className="grid grid-cols-3 gap-1 rounded-[10px] border border-[var(--ui-border-soft)] bg-[var(--ui-surface-field)] p-1">
                  {IMAGE_OUTPUT_COUNTS.map((count) => {
                    const active = count === outputCount;
                    return (
                      <button
                        key={count}
                        className={`h-8 rounded-lg text-sm transition-colors ${active
                          ? 'bg-accent text-[var(--accent-foreground)]'
                          : 'text-text-muted hover:bg-[var(--ui-hover)]'
                          }`}
                        onClick={(event) => {
                          event.stopPropagation();
                          onOutputCountChange(count);
                        }}
                      >
                        {t('modelParams.outputCountOption', { count })}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {panelExtraParamSchema.length > 0 && (
              <div className="mt-3">
                <div className="mb-2 text-xs text-text-muted">{t('modelParams.extraOptions')}</div>
                <div className="space-y-2 rounded-[10px] border border-[var(--ui-border-soft)] bg-[var(--ui-surface-field)] p-3">
                  {panelExtraParamSchema.map((definition) => {
                    const translatedLabel = resolveTranslatedText(
                      t,
                      definition.labelKey,
                      definition.label
                    );
                    const translatedDescription = definition.description || definition.descriptionKey
                      ? resolveTranslatedText(
                        t,
                        definition.descriptionKey,
                        definition.description
                      )
                      : '';
                    const resolvedValue = resolveExtraParamValue(
                      definition.key,
                      extraParams,
                      selectedModel.defaultExtraParams,
                      definition.defaultValue
                    );

                    return (
                      <div key={definition.key} className="space-y-2 border-t border-[var(--ui-border-soft)] pt-2 first:border-t-0 first:pt-0">
                        <div>
                          <div className="text-xs font-medium text-text-dark">{translatedLabel}</div>
                          {translatedDescription && (
                            <div className="mt-0.5 text-[11px] leading-4 text-text-muted">
                              {translatedDescription}
                            </div>
                          )}
                        </div>

                        {definition.type === 'enum' && definition.options && (
                          <UiSelect
                            value={String(resolvedValue ?? '')}
                            onChange={(event) =>
                              onExtraParamChange?.(definition.key, event.target.value)
                            }
                            className="h-9 text-sm"
                          >
                            {definition.options.map((option) => (
                              <option key={option.value} value={option.value}>
                                {resolveTranslatedText(t, option.labelKey, option.label)}
                              </option>
                            ))}
                          </UiSelect>
                        )}

                        {definition.type === 'boolean' && (
                          <label className="flex cursor-pointer items-center gap-2 text-sm text-text-dark">
                            <UiCheckbox
                              aria-label={translatedLabel}
                              checked={Boolean(resolvedValue)}
                              onCheckedChange={(checked) =>
                                onExtraParamChange?.(definition.key, checked)
                              }
                            />
                            <span>{translatedLabel}</span>
                          </label>
                        )}

                        {definition.type === 'number' && (
                          <UiInput
                            type="number"
                            min={definition.min}
                            max={definition.max}
                            step={definition.step}
                            value={typeof resolvedValue === 'number' ? String(resolvedValue) : ''}
                            onChange={(event) =>
                              onExtraParamChange?.(definition.key, Number(event.target.value))
                            }
                            className="h-9 text-sm"
                          />
                        )}

                        {definition.type === 'string' && (
                          <UiInput
                            value={typeof resolvedValue === 'string' ? resolvedValue : ''}
                            onChange={(event) =>
                              onExtraParamChange?.(definition.key, event.target.value)
                            }
                            className="h-9 text-sm"
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </UiPanel>
        </div>,
        document.body
      )}

      {typeof document !== 'undefined' && renderPanel === 'otherParams' && createPortal(
        <div
          ref={otherParamsPanelRef}
          className={`fixed z-[80] transition-opacity duration-200 ease-out ${isPanelVisible ? 'opacity-100' : 'pointer-events-none opacity-0'
            }`}
          style={buildPanelStyle(otherParamsPanelAnchor, 'center', 280, 260)}
        >
          <UiPanel
            className={OTHER_PARAMS_PANEL_CLASS_NAME}
            style={{ width: '100%', minWidth: 0, maxWidth: '100%' }}
          >
            <div className="space-y-3">
              {showWebSearchToggle && (
                <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-[var(--ui-border-soft)] bg-[var(--ui-surface-field)] px-3 py-2">
                  <UiCheckbox
                    aria-label={webSearchLabel ?? t('modelParams.enableWebSearch')}
                    checked={webSearchEnabled}
                    onCheckedChange={(checked) => onWebSearchToggle?.(checked)}
                    className="mt-0.5"
                  />
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-text-dark">
                      {webSearchLabel ?? t('modelParams.enableWebSearch')}
                    </div>
                  </div>
                </label>
              )}

              {inlineExtraParamSchema.map((definition) => {
                const translatedLabel = resolveTranslatedText(t, definition.labelKey, definition.label);
                const translatedDescription = definition.description || definition.descriptionKey
                  ? resolveTranslatedText(
                    t,
                    definition.descriptionKey,
                    definition.description
                  )
                  : '';
                const resolvedValue = resolveExtraParamValue(
                  definition.key,
                  extraParams,
                  selectedModel.defaultExtraParams,
                  definition.defaultValue
                );

                return (
                  <div
                    key={definition.key}
                    className="space-y-2 rounded-lg border border-[var(--ui-border-soft)] bg-[var(--ui-surface-field)] p-3"
                  >
                    <div>
                      <div className="text-xs font-medium text-text-dark">{translatedLabel}</div>
                      {translatedDescription && (
                        <div className="mt-0.5 text-[11px] leading-4 text-text-muted">
                          {translatedDescription}
                        </div>
                      )}
                    </div>
                    <UiSelect
                      value={String(resolvedValue ?? '')}
                      onChange={(event) => onExtraParamChange?.(definition.key, event.target.value)}
                      className="h-9 text-sm"
                    >
                      {(definition.options ?? []).map((option) => (
                        <option key={option.value} value={option.value}>
                          {resolveTranslatedText(t, option.labelKey, option.label)}
                        </option>
                      ))}
                    </UiSelect>
                  </div>
                );
              })}
            </div>
          </UiPanel>
        </div>,
        document.body
      )}

    </div>
  );
});

ModelParamsControls.displayName = 'ModelParamsControls';
