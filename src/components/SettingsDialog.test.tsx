// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import i18n from '@/i18n';

import { SettingsDialog } from './SettingsDialog';

describe('SettingsDialog', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    await i18n.changeLanguage('zh');
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('hides the category heading while editing a video API provider', async () => {
    await act(async () => {
      root.render(
        <SettingsDialog
          isOpen
          onClose={() => undefined}
          initialCategory="videoApis"
        />
      );
    });

    expect(Array.from(container.querySelectorAll('h2'))
      .some((heading) => heading.textContent === '视频API')).toBe(true);

    const providerButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Seedance 2.0'));
    expect(providerButton).toBeDefined();

    await act(async () => {
      providerButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(Array.from(container.querySelectorAll('h2'))
      .some((heading) => heading.textContent === '视频API')).toBe(false);
  });

  it('removes the general settings category', async () => {
    await act(async () => {
      root.render(<SettingsDialog isOpen onClose={() => undefined} />);
    });

    expect(container.textContent).toContain('图片API');
    expect(container.textContent).not.toContain('通用');
    expect(container.textContent).not.toContain('浏览器下载');
  });

  it('hides removed general preferences from settings', async () => {
    await act(async () => {
      root.render(<SettingsDialog isOpen onClose={() => undefined} />);
    });

    expect(container.textContent).not.toContain('上传节点自动使用文件名作为标题');
    expect(container.textContent).not.toContain('分镜图风格与参考图保持一致');
    expect(container.textContent).not.toContain('复制/保存文本时忽略 @ 标签');
    expect(container.textContent).not.toContain('分镜图禁止生成描述文本');
  });
});
