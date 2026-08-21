import { useTranslation } from 'react-i18next';

import { UiButton, UiModal } from '@/components/ui';
import type { CanvasEdge, CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { useCodexWebCanvasBridge } from '@/features/canvas-agent/hooks/useCodexWebCanvasBridge';
import type { Viewport } from '@xyflow/react';

interface CodexWebCanvasBridgeProps {
  projectId: string;
  projectName: string;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  selectedNodeIds: string[];
  viewport: Viewport;
}

export function CodexWebCanvasBridge(props: CodexWebCanvasBridgeProps) {
  const { t } = useTranslation();
  const bridge = useCodexWebCanvasBridge(props);

  return (
    <>
      <UiModal
        isOpen={bridge.isWriteAuthorizationPending}
        title={t('canvas.codexBridge.writeTitle')}
        closeLabel={t('common.close')}
        onClose={bridge.keepProjectReadOnly}
        closeOnBackdrop={false}
        widthClassName="w-[440px] max-w-[calc(100vw-24px)]"
        footer={(
          <>
            <UiButton onClick={bridge.keepProjectReadOnly}>{t('canvas.codexBridge.keepReadOnly')}</UiButton>
            <UiButton variant="primary" onClick={bridge.grantWriteAccess}>
              {t('canvas.codexBridge.allowWrite')}
            </UiButton>
          </>
        )}
      >
        <p className="text-sm leading-6 text-text-muted">
          {t('canvas.codexBridge.writeMessage', { name: props.projectName })}
        </p>
      </UiModal>

      <UiModal
        isOpen={bridge.pendingRunAuthorization !== null}
        title={t('canvas.codexBridge.runTitle')}
        closeLabel={t('common.close')}
        onClose={bridge.denyRunAuthorization}
        closeOnBackdrop={false}
        widthClassName="w-[440px] max-w-[calc(100vw-24px)]"
        footer={(
          <>
            <UiButton onClick={bridge.denyRunAuthorization}>{t('common.cancel')}</UiButton>
            <UiButton variant="primary" onClick={bridge.grantRunAuthorization}>
              {t('canvas.codexBridge.allowRun')}
            </UiButton>
          </>
        )}
      >
        <p className="text-sm leading-6 text-text-muted">
          {t('canvas.codexBridge.runMessage', {
            count: bridge.pendingRunAuthorization?.nodeIds.length ?? 0,
          })}
        </p>
      </UiModal>
    </>
  );
}
