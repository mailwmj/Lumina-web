import { describe, expect, it } from 'vitest';

import {
  DEFAULT_IMAGE_REFERENCE_PICKER_INDEX,
  moveImageReferencePickerIndex,
  buildImageReferenceModelPrompt,
  createImageReferencePromptToken,
  findImageReferencePromptTokens,
  insertImageReferencePromptToken,
  materializeImageReferencePrompt,
  normalizeImageReferenceShortcuts,
  pruneImageReferencePromptTokensForEdges,
  removeImageReferencePromptToken,
} from './imageReferencePrompt';
import { canvasNodeFactory } from './canvasServices';
import { CANVAS_NODE_TYPES, type CanvasNode } from '../domain/canvasNodes';
import { resolveImageReferenceCursorMove } from '../ui/ImageReferencePromptInput';

function createNode(type: CanvasNode['type'], id: string): CanvasNode {
  return {
    ...canvasNodeFactory.createNode(type, { x: 0, y: 0 }),
    id,
  };
}

describe('image reference prompt', () => {
  it('starts the picker at the first image and cycles it with the arrow keys', () => {
    expect(DEFAULT_IMAGE_REFERENCE_PICKER_INDEX).toBe(0);
    expect(moveImageReferencePickerIndex(0, 3, 'next')).toBe(1);
    expect(moveImageReferencePickerIndex(0, 3, 'previous')).toBe(2);
    expect(moveImageReferencePickerIndex(2, 3, 'next')).toBe(0);
  });

  it('keeps a selected image identity while its visible ordinal changes after reorder', () => {
    const redEdgeId = 'red-edge';
    const yellowEdgeId = 'yellow-edge';
    const prompt = [
      '衣服参考',
      createImageReferencePromptToken(redEdgeId),
      '；帽子参考',
      createImageReferencePromptToken(yellowEdgeId),
      '。',
    ].join('');

    expect(materializeImageReferencePrompt(prompt, [
      { edgeId: redEdgeId },
      { edgeId: yellowEdgeId },
    ])).toBe('衣服参考图片 1；帽子参考图片 2。');

    expect(materializeImageReferencePrompt(prompt, [
      { edgeId: yellowEdgeId },
      { edgeId: redEdgeId },
    ])).toBe('衣服参考图片 2；帽子参考图片 1。');
  });

  it('inserts and removes one atomic reference token without affecting another occurrence', () => {
    const first = insertImageReferencePromptToken('衣服参考。', 4, 'red-edge');
    const second = insertImageReferencePromptToken(first.nextText, first.nextOffset, 'red-edge');
    const tokens = findImageReferencePromptTokens(second.nextText);

    expect(tokens).toHaveLength(2);
    const removed = removeImageReferencePromptToken(second.nextText, tokens[0].start, tokens[0].end);
    expect(findImageReferencePromptTokens(removed.nextText)).toHaveLength(1);
    expect(materializeImageReferencePrompt(removed.nextText, [{ edgeId: 'red-edge' }]))
      .toBe('衣服参考图片 1。');
  });

  it('turns typed Chinese image ordinals into edge-bound reference tokens', () => {
    const firstToken = createImageReferencePromptToken('first-edge');
    const secondToken = createImageReferencePromptToken('second-edge');
    const typedPrompt = '保留图 1的身份，使用图片2的服装，并参考图一和图片二。';
    const normalized = normalizeImageReferenceShortcuts(typedPrompt, [
      { edgeId: 'first-edge' },
      { edgeId: 'second-edge' },
    ], typedPrompt.length);

    expect(normalized.nextText).toBe(
      `保留${firstToken}的身份，使用${secondToken}的服装，并参考${firstToken}和${secondToken}。`
    );
    expect(normalized.selectionOffset).toBe(normalized.nextText.length);
    expect(materializeImageReferencePrompt(normalized.nextText, [
      { edgeId: 'second-edge' },
      { edgeId: 'first-edge' },
    ])).toBe('保留图片 2的身份，使用图片 1的服装，并参考图片 2和图片 1。');
  });

  it('leaves an unavailable image ordinal as ordinary prompt text', () => {
    const typedPrompt = '保持图片三中的帽子。';

    expect(normalizeImageReferenceShortcuts(typedPrompt, [
      { edgeId: 'first-edge' },
      { edgeId: 'second-edge' },
    ])).toEqual({ nextText: typedPrompt, selectionOffset: typedPrompt.length });
  });

  it('silently prunes only tags that point to removed image edges across supported nodes', () => {
    const text = createNode(CANVAS_NODE_TYPES.textGeneration, 'text');
    text.data = {
      ...text.data,
      inputText: `衣服${createImageReferencePromptToken('red')}帽子${createImageReferencePromptToken('yellow')}`,
    };
    const image = createNode(CANVAS_NODE_TYPES.imageEdit, 'image');
    image.data = {
      ...image.data,
      prompt: `参考${createImageReferencePromptToken('red')}`,
    };

    const nextNodes = pruneImageReferencePromptTokensForEdges([text, image], ['red']);

    expect(nextNodes[0]?.data).toMatchObject({
      inputText: `衣服帽子${createImageReferencePromptToken('yellow')}`,
    });
    expect(nextNodes[1]?.data).toMatchObject({ prompt: '参考' });
  });

  it('adds an explicit ordered mapping before an image-generation prompt', () => {
    expect(buildImageReferenceModelPrompt('衣服参考图片 1；帽子参考图片 2。', [
      { edgeId: 'red' },
      { edgeId: 'yellow' },
    ])).toBe([
      '参考图片会按以下顺序提供。提示词中的“图片 N”专指第 N 张参考图片，必须按此对应关系理解和执行：',
      '- 图片 1：第 1 张参考图片',
      '- 图片 2：第 2 张参考图片',
      '',
      '衣服参考图片 1；帽子参考图片 2。',
    ].join('\n'));
  });

  it('moves the caret across a reference tag as one atomic item', () => {
    const token = createImageReferencePromptToken('red');
    const prompt = `衣服${token}帽子`;
    const [reference] = findImageReferencePromptTokens(prompt);
    expect(reference).toBeDefined();
    if (!reference) {
      return;
    }

    expect(resolveImageReferenceCursorMove(prompt, {
      start: reference.end,
      end: reference.end,
    }, 'backward')).toBe(reference.start);
    expect(resolveImageReferenceCursorMove(prompt, {
      start: reference.start,
      end: reference.start,
    }, 'forward')).toBe(reference.end);
  });
});
