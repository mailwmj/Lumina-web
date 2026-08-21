import { expect, test } from '@playwright/test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';

interface JsonRpcResponse {
  id?: number;
  result?: { content?: Array<{ text?: string }> };
  error?: unknown;
}

test('opens the local canvas URL, clears its bootstrap fragment, and exposes only the current project', async ({ page }) => {
  const projectName = `Read-only bridge ${Date.now()}`;
  const mcp = startMcp();
  try {
    await mcp.initialize();
    const opened = await mcp.call('canvas_open');
    const openUrl = JSON.parse(opened) as { canonicalOrigin?: string; url?: string };
    const origin = new URL(openUrl.canonicalOrigin ?? '');
    expect(origin.protocol).toBe('http:');
    expect(origin.hostname).toBe('127.0.0.1');
    expect(origin.port).not.toBe('');
    expect(origin.port).not.toBe('1420');
    expect(openUrl.url).toMatch(new RegExp(`^${escapeRegExp(origin.origin)}/#lumina-canvas=`));

    await page.goto(openUrl.url ?? '');
    await page.getByRole('button', { name: /新建项目|New Project/ }).click();
    await page.getByPlaceholder(/请输入项目名称|Enter project name/).fill(projectName);
    await page.getByRole('button', { name: /确认|Confirm/ }).click();
    await expect(page.getByRole('heading', {
      name: /允许 Codex 受限编辑|Allow limited Codex editing/,
    })).toBeVisible();
    await page.getByRole('button', { name: /保持只读|Keep read-only/ }).click();

    await page.goto(`/?bridge-reload=${Date.now()}`);
    const reopened = JSON.parse(await mcp.call('canvas_open')) as { url?: string };
    await page.goto(reopened.url ?? '');
    await page.getByRole('heading', { name: projectName, exact: true }).click();
    await expect(page.getByRole('heading', {
      name: /允许 Codex 受限编辑|Allow limited Codex editing/,
    })).toBeVisible();
    await page.getByRole('button', { name: /保持只读|Keep read-only/ }).click();
    await expect(page.locator('.react-flow__pane')).toBeVisible();
    await expect.poll(() => new URL(page.url()).hash).toBe('');

    await expect.poll(async () => {
      const state = JSON.parse(await mcp.call('canvas_get_state')) as {
        projectName?: string;
      };
      return state.projectName ?? null;
    }).toBe(projectName);
  } finally {
    mcp.close();
  }
});

function startMcp() {
  const child = spawn(process.execPath, [path.resolve('scripts/start-codex-canvas.mjs')], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const responses = createResponseReader(child);
  let nextId = 1;
  return {
    async initialize(): Promise<void> {
      const response = await send(child, responses, nextId++, {
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'lumina-e2e', version: '1.0.0' },
        },
      });
      expect(response.error).toBeUndefined();
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);
    },
    async call(name: string): Promise<string> {
      const response = await send(child, responses, nextId++, {
        method: 'tools/call',
        params: { name, arguments: {} },
      });
      expect(response.error).toBeUndefined();
      return response.result?.content?.[0]?.text ?? '';
    },
    close(): void {
      child.stdin.end();
      child.kill('SIGTERM');
    },
  };
}

function send(
  child: ChildProcessWithoutNullStreams,
  responses: ReturnType<typeof createResponseReader>,
  id: number,
  payload: Record<string, unknown>,
): Promise<JsonRpcResponse> {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, ...payload })}\n`);
  return responses.waitFor(id);
}

function createResponseReader(child: ChildProcessWithoutNullStreams) {
  let buffer = '';
  const responses = new Map<number, JsonRpcResponse>();
  const waiters = new Map<number, (response: JsonRpcResponse) => void>();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line) {
        const response = JSON.parse(line) as JsonRpcResponse;
        if (typeof response.id === 'number') {
          const waiter = waiters.get(response.id);
          if (waiter) {
            waiters.delete(response.id);
            waiter(response);
          } else {
            responses.set(response.id, response);
          }
        }
      }
      newlineIndex = buffer.indexOf('\n');
    }
  });
  return {
    waitFor(id: number): Promise<JsonRpcResponse> {
      const response = responses.get(id);
      if (response) {
        responses.delete(id);
        return Promise.resolve(response);
      }
      return new Promise((resolve) => waiters.set(id, resolve));
    },
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
