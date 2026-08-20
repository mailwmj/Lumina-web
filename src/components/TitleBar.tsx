import { useCallback, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Minus, X, Maximize2, Settings, ArrowLeft } from '@/components/ui/icons';
import { useTranslation } from 'react-i18next';
import { Moon, Sun, Languages } from '@/components/ui/icons';
import { useThemeStore } from '@/stores/themeStore';
import { useProjectStore } from '@/stores/projectStore';
import { UiTooltip } from '@/components/ui';
import closeNormalIcon from '@/assets/macos-traffic-lights/1-close-1-normal.svg';
import closeHoverIcon from '@/assets/macos-traffic-lights/2-close-2-hover.svg';
import minimizeNormalIcon from '@/assets/macos-traffic-lights/2-minimize-1-normal.svg';
import minimizeHoverIcon from '@/assets/macos-traffic-lights/2-minimize-2-hover.svg';
import maximizeNormalIcon from '@/assets/macos-traffic-lights/3-maximize-1-normal.svg';
import maximizeHoverIcon from '@/assets/macos-traffic-lights/3-maximize-2-hover.svg';

interface TitleBarProps {
  onSettingsClick: () => void;
  showBackButton?: boolean;
  onBackClick?: () => void;
  contextTitle?: string;
}

interface TitleBarButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  danger?: boolean;
  children: ReactNode;
}

function TitleBarButton({
  label,
  danger = false,
  className = '',
  children,
  type = 'button',
  ...props
}: TitleBarButtonProps) {
  return (
    <UiTooltip content={label}>
      <button
        type={type}
        data-no-drag="true"
        aria-label={label}
        className={`flex h-8 w-8 items-center justify-center rounded-md text-text-muted transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 ${
          danger
            ? 'hover:bg-red-500 hover:text-white'
            : 'hover:bg-[var(--ui-hover)] hover:text-text-dark'
        } ${className}`}
        {...props}
      >
        {children}
      </button>
    </UiTooltip>
  );
}

export function TitleBar({ onSettingsClick, showBackButton, onBackClick, contextTitle }: TitleBarProps) {
  const { t, i18n } = useTranslation();
  const { theme, toggleTheme } = useThemeStore();
  const currentProjectName = useProjectStore((state) => state.currentProject?.name);

  const appWindow = isTauri() ? getCurrentWindow() : null;
  const isZh = i18n.language.startsWith('zh');
  const isMac =
    typeof navigator !== 'undefined'
    && /(Mac|iPhone|iPad|iPod)/i.test(`${navigator.platform} ${navigator.userAgent}`);
  const appTitle = t('app.title');
  const titleText = contextTitle
    ? `${contextTitle} - ${appTitle}`
    : currentProjectName
      ? `${currentProjectName} - ${appTitle}`
      : appTitle;

  const handleMinimize = useCallback(async () => {
    if (!appWindow) return;
    await appWindow.minimize();
  }, [appWindow]);

  const handleMaximize = useCallback(async () => {
    if (!appWindow) return;
    const isMaximized = await appWindow.isMaximized();
    if (isMaximized) {
      await appWindow.unmaximize();
    } else {
      await appWindow.maximize();
    }
  }, [appWindow]);

  const handleClose = useCallback(async () => {
    if (!appWindow) return;
    await appWindow.close();
  }, [appWindow]);

  const handleDragStart = useCallback(async (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest('button') || target?.closest('[data-no-drag="true"]')) {
      return;
    }
    if (!appWindow) return;
    await appWindow.startDragging();
  }, [appWindow]);

  const handleLanguageClick = useCallback(() => {
    const newLang = i18n.language.startsWith('zh') ? 'en' : 'zh';
    i18n.changeLanguage(newLang);
  }, [i18n]);

  const handleThemeClick = useCallback(() => {
    toggleTheme();
  }, [toggleTheme]);

  return (
    <div className="relative z-50 flex h-10 select-none items-center justify-between border-b border-[var(--ui-border-soft)] bg-[var(--ui-surface-panel)]">
      {isMac && appWindow ? (
        <div className="flex h-full items-center gap-2 pl-3 pr-2" data-no-drag="true">
          <UiTooltip content={t('titleBar.close')}>
            <button
              type="button"
              onMouseDown={(event) => event.stopPropagation()}
              onClick={handleClose}
              className="group/light relative flex h-3 w-3 items-center justify-center"
              aria-label={t('titleBar.close')}
            >
              <img src={closeNormalIcon} alt="" className="pointer-events-none h-3 w-3 opacity-100 transition-opacity group-hover/light:opacity-0" />
              <img src={closeHoverIcon} alt="" className="pointer-events-none absolute h-3 w-3 opacity-0 transition-opacity group-hover/light:opacity-100" />
            </button>
          </UiTooltip>
          <UiTooltip content={t('titleBar.minimize')}>
            <button
              type="button"
              onMouseDown={(event) => event.stopPropagation()}
              onClick={handleMinimize}
              className="group/light relative flex h-3 w-3 items-center justify-center"
              aria-label={t('titleBar.minimize')}
            >
              <img src={minimizeNormalIcon} alt="" className="pointer-events-none h-3 w-3 opacity-100 transition-opacity group-hover/light:opacity-0" />
              <img src={minimizeHoverIcon} alt="" className="pointer-events-none absolute h-3 w-3 opacity-0 transition-opacity group-hover/light:opacity-100" />
            </button>
          </UiTooltip>
          <UiTooltip content={t('titleBar.maximize')}>
            <button
              type="button"
              onMouseDown={(event) => event.stopPropagation()}
              onClick={handleMaximize}
              className="group/light relative flex h-3 w-3 items-center justify-center"
              aria-label={t('titleBar.maximize')}
            >
              <img src={maximizeNormalIcon} alt="" className="pointer-events-none h-3 w-3 opacity-100 transition-opacity group-hover/light:opacity-0" />
              <img src={maximizeHoverIcon} alt="" className="pointer-events-none absolute h-3 w-3 opacity-0 transition-opacity group-hover/light:opacity-100" />
            </button>
          </UiTooltip>
        </div>
      ) : null}

      <div
        className="flex-1 h-full flex items-center px-4 cursor-move"
        onMouseDown={handleDragStart}
      >
        {showBackButton && onBackClick && (
          <TitleBarButton
            label={t('titleBar.back')}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onBackClick();
            }}
            className="mr-2"
          >
            <ArrowLeft className="h-4 w-4" />
          </TitleBarButton>
        )}
        <span className="text-sm font-medium text-text-dark">
          {titleText}
        </span>
        {!isZh && !currentProjectName && !contextTitle ? (
          <span className="text-xs text-text-muted ml-2">{t('app.subtitle')}</span>
        ) : null}
      </div>

      <div className="flex h-full items-center gap-0.5 px-1">
        <TitleBarButton
          label={i18n.language.startsWith('zh') ? t('titleBar.switchToEnglish') : t('titleBar.switchToChinese')}
          onClick={handleLanguageClick}
        >
          <Languages className="h-4 w-4" />
        </TitleBarButton>

        <TitleBarButton
          label={theme === 'dark' ? t('theme.light') : t('theme.dark')}
          onClick={handleThemeClick}
        >
          {theme === 'dark' ? (
            <Sun className="h-4 w-4" />
          ) : (
            <Moon className="h-4 w-4" />
          )}
        </TitleBarButton>

        <TitleBarButton
          label={t('settings.title')}
          onClick={onSettingsClick}
        >
          <Settings className="h-4 w-4" />
        </TitleBarButton>

        {!isMac ? (
          <>
            <div className="mx-1 h-4 w-px bg-[var(--ui-border-soft)]" />

            <TitleBarButton
              label={t('titleBar.minimize')}
              onClick={handleMinimize}
            >
              <Minus className="h-4 w-4" />
            </TitleBarButton>

            <TitleBarButton
              label={t('titleBar.maximize')}
              onClick={handleMaximize}
            >
              <Maximize2 className="h-4 w-4" />
            </TitleBarButton>

            <TitleBarButton
              label={t('titleBar.close')}
              onClick={handleClose}
              danger
            >
              <X className="h-4 w-4" />
            </TitleBarButton>
          </>
        ) : null}
      </div>
    </div>
  );
}
