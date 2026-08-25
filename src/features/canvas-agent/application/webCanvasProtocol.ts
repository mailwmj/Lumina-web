export const WEB_CANVAS_PROTOCOL = {
  major: 2,
  minor: 0,
  build: 'lumina-canvas-web-v2',
} as const;

export const WEB_CANVAS_CAPABILITIES = [
  'canvas.read.state',
  'canvas.read.selection',
  'canvas.read.capabilities',
  'canvas.read.change-status',
  'canvas.write.changes',
  'canvas.write.import-images',
  'canvas.run.images',
  'canvas.wait.nodes',
  'canvas.read.node-images',
  'canvas.read.action-status',
] as const;
