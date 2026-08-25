import assert from 'node:assert/strict';
import test from 'node:test';

import { canvasImportImagesSchema } from './protocol.js';

test('rejects local sources and oversized inline image imports before they reach the browser bridge', () => {
  const base = {
    projectId: 'project-1',
    images: [{ clientId: 'image', source: 'data:image/png;base64,AA==' }],
  };
  assert.equal(canvasImportImagesSchema.safeParse({
    ...base,
    images: [{ clientId: 'image', source: 'file:///private/image.png' }],
  }).success, false);

  const sixMegabytesPlusOne = 6 * 1024 * 1024 + 1;
  const oversizedPayload = 'A'.repeat(Math.ceil(sixMegabytesPlusOne * 4 / 3 / 4) * 4);
  assert.equal(canvasImportImagesSchema.safeParse({
    ...base,
    images: [{ clientId: 'image', source: `data:image/png;base64,${oversizedPayload}` }],
  }).success, false);
});
