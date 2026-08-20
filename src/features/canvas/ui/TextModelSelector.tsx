import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { UiButton, UiSelect } from '@/components/ui';
import {
  listConfiguredTextModels,
  resolveTextModelSelection,
} from '@/features/canvas/application/textModelSelection';
import { NODE_CONTROL_CHIP_CLASS } from '@/features/canvas/ui/nodeControlStyles';
import {
  TEXT_REASONING_EFFORTS,
  type TextReasoningEffort,
} from '@/features/canvas/models/types';
import { openSettingsDialog } from '@/features/settings/settingsEvents';
import type { TextApiConfig } from '@/stores/settingsStore';

interface TextModelSelectorProps {
  textApis: TextApiConfig[];
  textApiId?: string;
  textModelId?: string;
  onChange: (selection: { textApiId: string; textModelId: string }) => void;
  reasoningEffort?: TextReasoningEffort;
  onReasoningEffortChange: (effort: TextReasoningEffort | undefined) => void;
  className?: string;
}

function optionValue(apiId: string, modelId: string): string {
  return JSON.stringify([apiId, modelId]);
}

export function TextModelSelector({
  textApis,
  textApiId,
  textModelId,
  onChange,
  reasoningEffort,
  onReasoningEffortChange,
  className = '',
}: TextModelSelectorProps) {
  const { t } = useTranslation();
  const options = useMemo(() => listConfiguredTextModels(textApis), [textApis]);
  const resolved = useMemo(
    () => resolveTextModelSelection(textApis, textApiId, textModelId),
    [textApiId, textApis, textModelId]
  );
  const hasExplicitSelection = Boolean(textApiId || textModelId);
  const requestedValue = hasExplicitSelection && textApiId && textModelId
    ? optionValue(textApiId, textModelId)
    : '';
  const resolvedValue = resolved ? optionValue(resolved.apiId, resolved.modelId) : '';
  const value = hasExplicitSelection ? requestedValue : resolvedValue;
  const hasUnavailableSelection = hasExplicitSelection && !resolved;

  if (options.length === 0 && !hasUnavailableSelection) {
    return (
      <UiButton
        variant="muted"
        size="sm"
        className={`nodrag nowheel shrink-0 ${NODE_CONTROL_CHIP_CLASS} ${className}`}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          openSettingsDialog({ category: 'textApis' });
        }}
      >
        {t('node.textModel.configure')}
      </UiButton>
    );
  }

  const selectedLabel = resolved
    ? `${resolved.apiName} / ${resolved.modelId}`
    : t('node.textModel.unavailable', {
      apiId: textApiId || '—',
      modelId: textModelId || '—',
    });

  return (
    <div className={`flex min-w-0 shrink-0 items-center gap-1 ${className}`}>
      <div
        title={selectedLabel}
        onMouseDown={(event) => event.stopPropagation()}
        className="nodrag nowheel w-[208px] shrink-0"
      >
        <UiSelect
          aria-label={t('node.textModel.select')}
          value={value}
          onChange={(event) => {
            const option = options.find((candidate) =>
              optionValue(candidate.apiId, candidate.modelId) === event.target.value
            );
            if (option) {
              onChange({ textApiId: option.apiId, textModelId: option.modelId });
            }
          }}
          className={`nodrag nowheel !w-full font-mono text-text-dark ${NODE_CONTROL_CHIP_CLASS}`}
        >
          {hasUnavailableSelection && (
            <option value={requestedValue} disabled>
              {selectedLabel}
            </option>
          )}
          {options.map((option) => (
            <option key={optionValue(option.apiId, option.modelId)} value={optionValue(option.apiId, option.modelId)}>
              {`${option.apiName} / ${option.modelId}`}
            </option>
          ))}
        </UiSelect>
      </div>
      <div
        title={t('node.textModel.reasoningEffort')}
        onMouseDown={(event) => event.stopPropagation()}
        className="nodrag nowheel w-[76px] shrink-0"
      >
        <UiSelect
          aria-label={t('node.textModel.reasoningEffort')}
          value={reasoningEffort ?? ''}
          onChange={(event) => onReasoningEffortChange(
            event.target.value ? event.target.value as TextReasoningEffort : undefined
          )}
          className={`nodrag nowheel !w-full font-mono text-text-dark ${NODE_CONTROL_CHIP_CLASS}`}
        >
          <option value="">{t('node.textModel.reasoningDefault')}</option>
          {TEXT_REASONING_EFFORTS.map((effort) => (
            <option key={effort} value={effort}>
              {t(`node.textModel.reasoning.${effort}`)}
            </option>
          ))}
        </UiSelect>
      </div>
    </div>
  );
}
