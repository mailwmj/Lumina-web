import { memo, useState } from 'react';
import { MiniMap } from '@xyflow/react';
import { useTranslation } from 'react-i18next';

import { Map } from '@/components/ui/icons';
import { UiTooltip } from '@/components/ui';

export const CanvasMinimapControl = memo(() => {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const label = t(isOpen ? 'canvas.minimap.hide' : 'canvas.minimap.show');

  return (
    <>
      {isOpen && (
        <MiniMap
          ariaLabel={t('canvas.minimap.label')}
          position="bottom-left"
          className="canvas-minimap nopan nowheel !bg-surface-dark"
          style={{ bottom: 52, pointerEvents: 'all', zIndex: 100 }}
          nodeColor="rgb(var(--text-muted-rgb) / 0.72)"
          maskColor="rgb(var(--bg-rgb) / 0.72)"
          pannable
          zoomable
        />
      )}

      <div className="nopan nowheel pointer-events-auto absolute bottom-3 left-3 z-[100]">
        <UiTooltip content={label}>
          <button
            type="button"
            aria-label={label}
            aria-expanded={isOpen}
            aria-pressed={isOpen}
            onClick={() => setIsOpen((current) => !current)}
            className={`flex h-8 w-8 items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 ${
              isOpen
                ? 'bg-accent/18 text-accent'
                : 'text-text-muted hover:bg-[var(--ui-hover)] hover:text-text-dark'
            }`}
          >
            <Map className="h-4 w-4" />
          </button>
        </UiTooltip>
      </div>
    </>
  );
});

CanvasMinimapControl.displayName = 'CanvasMinimapControl';
