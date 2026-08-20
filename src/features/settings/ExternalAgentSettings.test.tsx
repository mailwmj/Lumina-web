// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import i18n from '@/i18n';
import { ExternalAgentSettings } from './ExternalAgentSettings';

const canvasAgentCommands = vi.hoisted(() => ({
  managed: true,
  getRuntime: vi.fn(),
  getHealth: vi.fn(),
}));

vi.mock('@/commands/canvasAgent', () => ({
  isCanvasAgentManagedByLumina: () => canvasAgentCommands.managed,
  getCanvasAgentRuntime: canvasAgentCommands.getRuntime,
  getCanvasAgentHealth: canvasAgentCommands.getHealth,
}));

describe('ExternalAgentSettings', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    await i18n.changeLanguage('zh');
    vi.clearAllMocks();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    canvasAgentCommands.managed = true;
    canvasAgentCommands.getRuntime.mockResolvedValue({
      available: true,
      running: true,
      url: 'http://127.0.0.1:17372',
      token: 'private-token',
      registrationCommand: "codex mcp add lumina -- '/Applications/Lumina.app/Contents/MacOS/lumina-canvas-agent' mcp --config '/config/canvas-agent.json'",
      error: null,
    });
    canvasAgentCommands.getHealth.mockResolvedValue({
      ok: true,
      protocolVersion: 2,
      hasActiveCanvas: true,
      readiness: 'ready',
      activeProject: { id: 'project-1', name: 'Project' },
    });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('shows real canvas readiness and registration without exposing manual secrets', async () => {
    await act(async () => {
      root.render(
        <ExternalAgentSettings
          value={{ enabled: true, url: 'http://127.0.0.1:17372', token: '' }}
          onChange={() => undefined}
        />
      );
    });
    await vi.waitFor(() => expect(container.textContent).toContain('画布已就绪'));

    expect(container.textContent).toContain('当前项目：Project');
    expect(container.textContent).toContain('codex mcp add lumina');
    expect(container.textContent).not.toContain('private-token');
    expect(container.querySelector('#external-agent-url')).toBeNull();
    expect(container.querySelector('#external-agent-token')).toBeNull();
  });

  it('does not show ready while external canvas access is disabled', async () => {
    await act(async () => {
      root.render(
        <ExternalAgentSettings
          value={{ enabled: false, url: 'http://127.0.0.1:17372', token: '' }}
          onChange={() => undefined}
        />
      );
    });

    await vi.waitFor(() => expect(container.textContent).toContain('需要开启画布访问'));
    expect(container.textContent).not.toContain('画布已就绪');
  });

  it('keeps the registration command visible when the health check is unavailable', async () => {
    canvasAgentCommands.getHealth.mockRejectedValue(new Error('health unavailable'));
    await act(async () => {
      root.render(
        <ExternalAgentSettings
          value={{ enabled: true, url: 'http://127.0.0.1:17372', token: '' }}
          onChange={() => undefined}
        />
      );
    });

    await vi.waitFor(() => expect(container.textContent).toContain('不可用'));
    expect(container.textContent).toContain('codex mcp add lumina');
  });

  it('keeps URL and token fields in browser development mode', async () => {
    canvasAgentCommands.managed = false;
    await act(async () => {
      root.render(
        <ExternalAgentSettings
          value={{ enabled: true, url: 'http://127.0.0.1:17372', token: 'dev-token' }}
          onChange={() => undefined}
        />
      );
    });

    expect(container.querySelector('#external-agent-url')).toBeInstanceOf(HTMLInputElement);
    expect(container.querySelector('#external-agent-token')).toBeInstanceOf(HTMLInputElement);
    expect(canvasAgentCommands.getRuntime).not.toHaveBeenCalled();
  });
});
