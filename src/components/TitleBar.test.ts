import { describe, expect, it } from 'vitest';

import { resolveTitleText } from './titleText';

describe('resolveTitleText', () => {
  it('shows an open project name without the application title suffix', () => {
    expect(resolveTitleText({
      appTitle: '流光',
      currentProjectName: '11',
    })).toBe('11');
  });

  it('keeps the application title for the home page and tool contexts', () => {
    expect(resolveTitleText({ appTitle: '流光' })).toBe('流光');
    expect(resolveTitleText({
      appTitle: '流光',
      contextTitle: '批量裁剪',
    })).toBe('批量裁剪 - 流光');
  });
});
