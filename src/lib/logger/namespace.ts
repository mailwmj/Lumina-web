const UNKNOWN = 'unknown';

export function resolveNamespace(depth: number = 3): string {
  const stack = new Error().stack;
  if (!stack) return UNKNOWN;

  const lines = stack.split('\n');
  // depth=0 是 resolveNamespace 自己；depth=1 是调用者；depth=2 是更上一级
  // 我们要的是调用 logger 的那一行；Logger 内部又会包一层，所以一般 depth=3 起步
  const line = lines[depth];
  if (!line) return UNKNOWN;

  const match = line.match(/at\s+(?:.*\()?(.+?):\d+:\d+\)?$/);
  if (!match) return UNKNOWN;

  return fileToNamespace(match[1]);
}

export function fileToNamespace(filePath: string): string {
  // 去掉 query / hash (Vite 风格的 `?t=123`)
  const clean = filePath.split('?')[0].split('#')[0];
  // 找到 src/ 之后的部分；如果是 node_modules 内文件则直接保留
  const idx = clean.lastIndexOf('src/');
  const relative = idx >= 0 ? clean.slice(idx + 4) : clean.replace(/^.*[\\/]/, '');

  // 去掉扩展名
  const noExt = relative.replace(/\.(ts|tsx|js|jsx)$/, '');

  // 统一 / 和 \ 为 .，去掉 index 收尾
  return noExt
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/\/index$/, '')
    .replace(/\//g, '.')
    .replace(/^\.+|\.+$/g, '');
}