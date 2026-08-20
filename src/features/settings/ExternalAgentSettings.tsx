import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  getCanvasAgentHealth,
  getCanvasAgentRuntime,
  isCanvasAgentManagedByLumina,
  type CanvasAgentHealthInfo,
  type CanvasAgentRuntimeInfo,
} from '@/commands/canvasAgent';
import { Check, Copy } from '@/components/ui/icons';
import { UiIconButton, UiInput } from '@/components/ui';
import { SettingsCheckboxCard } from '@/features/settings/SettingsCheckboxCard';
import type { ExternalAgentConnectionConfig } from '@/stores/settingsStore';

interface ExternalAgentSettingsProps {
  value: ExternalAgentConnectionConfig;
  onChange: (value: ExternalAgentConnectionConfig) => void;
}

export function ExternalAgentSettings({
  value,
  onChange,
}: ExternalAgentSettingsProps) {
  const { t } = useTranslation();
  const managedByLumina = isCanvasAgentManagedByLumina();
  const [runtime, setRuntime] = useState<CanvasAgentRuntimeInfo | null>(null);
  const [health, setHealth] = useState<CanvasAgentHealthInfo | null>(null);
  const [runtimeError, setRuntimeError] = useState('');
  const [commandCopied, setCommandCopied] = useState(false);

  useEffect(() => {
    if (!managedByLumina) {
      return;
    }
    let cancelled = false;
    const refresh = async () => {
      let nextRuntime: CanvasAgentRuntimeInfo | null;
      try {
        nextRuntime = await getCanvasAgentRuntime();
      } catch (error) {
        if (!cancelled) {
          setRuntime(null);
          setHealth(null);
          setRuntimeError(error instanceof Error ? error.message : String(error));
        }
        return;
      }
      if (cancelled) {
        return;
      }
      setRuntime(nextRuntime);
      if (!nextRuntime?.running || !nextRuntime.url || !nextRuntime.token) {
        setHealth(null);
        setRuntimeError('');
        return;
      }
      try {
        const nextHealth = await getCanvasAgentHealth(nextRuntime.url, nextRuntime.token);
        if (!cancelled) {
          setHealth(nextHealth);
          setRuntimeError('');
        }
      } catch (error) {
        if (!cancelled) {
          setHealth(null);
          setRuntimeError(error instanceof Error ? error.message : String(error));
        }
      }
    };
    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, 3_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [managedByLumina]);

  const copyRegistrationCommand = async () => {
    if (!runtime?.registrationCommand) {
      return;
    }
    await navigator.clipboard.writeText(runtime.registrationCommand);
    setCommandCopied(true);
    window.setTimeout(() => setCommandCopied(false), 1_500);
  };

  const readiness = resolveReadiness(value.enabled, runtime, health, runtimeError);

  return (
    <div className="space-y-5 py-5">
      <SettingsCheckboxCard
        checked={value.enabled}
        onCheckedChange={(enabled) => onChange({ ...value, enabled })}
        title={t('settings.externalAgentEnabled')}
        description={t('settings.externalAgentEnabledDesc')}
      />

      {managedByLumina ? (
        <section className="border-t border-[var(--ui-border-soft)] pt-5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h3 className="text-sm font-medium text-text-dark">
                {t('settings.externalAgentManagedService')}
              </h3>
              <p className="mt-1 text-xs leading-5 text-text-muted">
                {t('settings.externalAgentManagedServiceDesc')}
              </p>
            </div>
            <span className={`mt-0.5 inline-flex shrink-0 items-center gap-2 text-xs ${
              readiness.tone === 'ready'
                ? 'text-emerald-500'
                : readiness.tone === 'attention'
                  ? 'text-amber-500'
                  : 'text-text-muted'
            }`}>
              <span className={`h-2 w-2 rounded-full ${
                readiness.tone === 'ready'
                  ? 'bg-emerald-500'
                  : readiness.tone === 'attention'
                    ? 'bg-amber-500'
                    : 'bg-text-muted/45'
              }`} />
              {t(readiness.labelKey)}
            </span>
          </div>

          {value.enabled && health?.readiness === 'ready' && health.activeProject && (
            <p className="mt-3 text-xs leading-5 text-text-muted">
              {t('settings.externalAgentActiveProject', { name: health.activeProject.name })}
            </p>
          )}

          {(runtime?.error || runtimeError) && (
            <p className="mt-3 break-words text-xs leading-5 text-red-500">
              {runtime?.error || runtimeError}
            </p>
          )}

          {runtime?.registrationCommand && (
            <div className="mt-5">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-medium text-text-dark">
                    {t('settings.externalAgentCodexCommand')}
                  </h3>
                  <p className="mt-1 text-xs leading-5 text-text-muted">
                    {t('settings.externalAgentCodexCommandDesc')}
                  </p>
                </div>
                <UiIconButton
                  type="button"
                  className="h-8 w-8 shrink-0"
                  label={commandCopied
                    ? t('settings.externalAgentCommandCopied')
                    : t('settings.externalAgentCopyCommand')}
                  onClick={() => void copyRegistrationCommand()}
                >
                  {commandCopied
                    ? <Check className="h-3.5 w-3.5" />
                    : <Copy className="h-3.5 w-3.5" />}
                </UiIconButton>
              </div>
              <pre className="mt-3 max-h-36 overflow-auto whitespace-pre-wrap break-all border border-[var(--ui-border-soft)] bg-[var(--ui-surface-field)] px-3 py-2.5 font-mono text-[11px] leading-5 text-text-dark">
                {runtime.registrationCommand}
              </pre>
            </div>
          )}
        </section>
      ) : (
        <>
          <p className="text-xs leading-5 text-text-muted">
            {t('settings.externalAgentBrowserDevelopment')}
          </p>
          <section>
            <label className="block text-sm font-medium text-text-dark" htmlFor="external-agent-url">
              {t('settings.externalAgentUrl')}
            </label>
            <p className="mt-1 text-xs text-text-muted">
              {t('settings.externalAgentUrlDesc')}
            </p>
            <UiInput
              id="external-agent-url"
              value={value.url}
              spellCheck={false}
              className="mt-3 h-9 font-mono text-xs"
              placeholder="http://127.0.0.1:17372"
              onChange={(event) => onChange({ ...value, url: event.target.value })}
            />
          </section>

          <section>
            <label className="block text-sm font-medium text-text-dark" htmlFor="external-agent-token">
              {t('settings.externalAgentToken')}
            </label>
            <p className="mt-1 text-xs text-text-muted">
              {t('settings.externalAgentTokenDesc')}
            </p>
            <UiInput
              id="external-agent-token"
              type="password"
              value={value.token}
              autoComplete="off"
              spellCheck={false}
              className="mt-3 h-9 font-mono text-xs"
              placeholder={t('settings.externalAgentTokenPlaceholder')}
              onChange={(event) => onChange({ ...value, token: event.target.value })}
            />
          </section>
        </>
      )}
    </div>
  );
}

interface ReadinessView {
  tone: 'ready' | 'attention' | 'neutral';
  labelKey:
    | 'settings.externalAgentCanvasReady'
    | 'settings.externalAgentPermissionRequired'
    | 'settings.externalAgentCanvasWaiting'
    | 'settings.externalAgentServiceUnavailable'
    | 'settings.externalAgentServiceStarting';
}

function resolveReadiness(
  enabled: boolean,
  runtime: CanvasAgentRuntimeInfo | null,
  health: CanvasAgentHealthInfo | null,
  runtimeError: string
): ReadinessView {
  if (!runtime && !runtimeError) {
    return { tone: 'neutral', labelKey: 'settings.externalAgentServiceStarting' };
  }
  if (!runtime?.running || runtimeError) {
    return { tone: 'neutral', labelKey: 'settings.externalAgentServiceUnavailable' };
  }
  if (!enabled) {
    return { tone: 'attention', labelKey: 'settings.externalAgentPermissionRequired' };
  }
  if (health?.readiness === 'ready') {
    return { tone: 'ready', labelKey: 'settings.externalAgentCanvasReady' };
  }
  return { tone: 'attention', labelKey: 'settings.externalAgentCanvasWaiting' };
}
