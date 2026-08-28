import { useTranslation } from 'react-i18next';

import { UiButton, UiModal } from '@/components/ui';
import type { CanvasEdge, CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { useCodexWebCanvasBridge } from '@/features/canvas-agent/hooks/useCodexWebCanvasBridge';
import type { Viewport } from '@xyflow/react';

interface CodexWebCanvasBridgeProps {
  projectId: string | null;
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
        isOpen={bridge.pendingProjectAuthorization !== null}
        title={t(`canvas.codexBridge.${bridge.pendingProjectAuthorization?.type === 'create_project'
          ? 'createProjectTitle'
          : 'openProjectTitle'}`)}
        closeLabel={t('common.close')}
        onClose={bridge.denyProjectAuthorization}
        closeOnBackdrop={false}
        widthClassName="w-[440px] max-w-[calc(100vw-24px)]"
        footer={(
          <>
            <UiButton onClick={bridge.denyProjectAuthorization}>{t('common.cancel')}</UiButton>
            <UiButton variant="primary" onClick={bridge.grantProjectAuthorization}>
              {t('canvas.codexBridge.allowProjectAction')}
            </UiButton>
          </>
        )}
      >
        <p className="text-sm leading-6 text-text-muted">
          {bridge.pendingProjectAuthorization?.type === 'create_project'
            ? t('canvas.codexBridge.createProjectMessage', {
              name: bridge.pendingProjectAuthorization.name,
            })
            : t('canvas.codexBridge.openProjectMessage', {
              projectId: bridge.pendingProjectAuthorization?.projectId ?? '',
            })}
        </p>
      </UiModal>

      <UiModal
        isOpen={bridge.pendingRunAuthorization !== null}
        title={t(bridge.pendingRunAuthorization?.kind === 'video'
          ? 'canvas.codexBridge.runVideoTitle'
          : 'canvas.codexBridge.runTitle')}
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
          {t(bridge.pendingRunAuthorization?.kind === 'video'
            ? 'canvas.codexBridge.runVideoMessage'
            : 'canvas.codexBridge.runMessage', {
            count: bridge.pendingRunAuthorization?.nodeIds.length ?? 0,
          })}
        </p>
      </UiModal>
    </>
  );
}
