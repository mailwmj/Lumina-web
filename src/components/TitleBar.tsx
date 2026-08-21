import { type ButtonHTMLAttributes, type ReactNode, useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { ArrowLeft, Languages, Moon, Settings, Sun } from '@/components/ui/icons';
import { UiTooltip } from '@/components/ui';
import { useProjectStore } from '@/stores/projectStore';
import { useThemeStore } from '@/stores/themeStore';

interface TitleBarProps {
  onSettingsClick: () => void;
  showBackButton?: boolean;
  onBackClick?: () => void;
  contextTitle?: string;
}

interface TitleBarButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  children: ReactNode;
}

function TitleBarButton({
  label,
  className = '',
  children,
  type = 'button',
  ...props
}: TitleBarButtonProps) {
  return (
    <UiTooltip content={label}>
      <button
        type={type}
        aria-label={label}
        className={`flex h-8 w-8 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-[var(--ui-hover)] hover:text-text-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 ${className}`}
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
  const appTitle = t('app.title');
  const titleText = contextTitle
    ? `${contextTitle} - ${appTitle}`
    : currentProjectName
      ? `${currentProjectName} - ${appTitle}`
      : appTitle;

  const handleLanguageClick = useCallback(() => {
    void i18n.changeLanguage(i18n.language.startsWith('zh') ? 'en' : 'zh');
  }, [i18n]);

  return (
    <header className="relative z-50 flex h-10 items-center justify-between border-b border-[var(--ui-border-soft)] bg-[var(--ui-surface-panel)]">
      <div className="flex h-full min-w-0 flex-1 items-center px-4">
        {showBackButton && onBackClick ? (
          <TitleBarButton
            label={t('titleBar.back')}
            onClick={onBackClick}
            className="mr-2"
          >
            <ArrowLeft className="h-4 w-4" />
          </TitleBarButton>
        ) : null}
        <span className="truncate text-sm font-medium text-text-dark">{titleText}</span>
        {!i18n.language.startsWith('zh') && !currentProjectName && !contextTitle ? (
          <span className="ml-2 truncate text-xs text-text-muted">{t('app.subtitle')}</span>
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
          onClick={toggleTheme}
        >
          {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </TitleBarButton>
        <TitleBarButton label={t('settings.title')} onClick={onSettingsClick}>
          <Settings className="h-4 w-4" />
        </TitleBarButton>
      </div>
    </header>
  );
}
