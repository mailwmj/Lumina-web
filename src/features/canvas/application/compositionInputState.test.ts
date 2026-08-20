import { describe, expect, it } from 'vitest';

import {
  beginCompositionInput,
  commitCompositionInputOnBlur,
  completeCompositionInput,
  createCompositionInputState,
  shouldSuppressKeyboardCommand,
  updateCompositionInputDraft,
} from './compositionInputState';

describe('composition input state', () => {
  it('keeps an IME draft local until composition ends, then commits its final value', () => {
    let state = createCompositionInputState('initial prompt');
    state = beginCompositionInput(state);

    const composing = updateCompositionInputDraft(state, 'ni', true);

    expect(composing.state).toMatchObject({
      draft: 'ni',
      committedValue: 'initial prompt',
      isComposing: true,
    });
    expect(composing.committedValue).toBeNull();

    const completed = completeCompositionInput(composing.state, '你');

    expect(completed.state).toMatchObject({
      draft: '你',
      committedValue: '你',
      isComposing: false,
    });
    expect(completed.committedValue).toBe('你');
  });

  it('updates the local draft and commits ordinary input immediately', () => {
    const updated = updateCompositionInputDraft(
      createCompositionInputState('first prompt'),
      'second prompt'
    );

    expect(updated.state).toMatchObject({
      draft: 'second prompt',
      committedValue: 'second prompt',
      isComposing: false,
    });
    expect(updated.committedValue).toBe('second prompt');
  });

  it('commits the final input value when focus leaves during composition', () => {
    const composing = beginCompositionInput(createCompositionInputState('initial prompt'));
    const blurred = commitCompositionInputOnBlur(composing, '最终提示词');

    expect(blurred.state).toMatchObject({
      draft: '最终提示词',
      committedValue: '最终提示词',
      isComposing: false,
    });
    expect(blurred.committedValue).toBe('最终提示词');
  });

  it('suppresses canvas keyboard commands for active and legacy native composition events', () => {
    expect(shouldSuppressKeyboardCommand({ isComposing: true, keyCode: 13 })).toBe(true);
    expect(shouldSuppressKeyboardCommand({ isComposing: false, keyCode: 229 })).toBe(true);
    expect(shouldSuppressKeyboardCommand({ isComposing: false, keyCode: 13 })).toBe(false);
  });
});
