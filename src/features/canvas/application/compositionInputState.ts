export interface CompositionInputState {
  draft: string;
  committedValue: string;
  isComposing: boolean;
}

export interface CompositionInputTransition {
  state: CompositionInputState;
  committedValue: string | null;
}

export interface KeyboardCompositionState {
  isComposing?: boolean;
  keyCode?: number;
}

export function createCompositionInputState(value: string): CompositionInputState {
  return {
    draft: value,
    committedValue: value,
    isComposing: false,
  };
}

export function beginCompositionInput(state: CompositionInputState): CompositionInputState {
  return { ...state, isComposing: true };
}

function transitionInputValue(
  state: CompositionInputState,
  value: string,
  isComposing: boolean,
  shouldCommit: boolean
): CompositionInputTransition {
  const nextState: CompositionInputState = {
    ...state,
    draft: value,
    isComposing,
  };

  if (!shouldCommit || value === state.committedValue) {
    return { state: nextState, committedValue: null };
  }

  return {
    state: { ...nextState, committedValue: value },
    committedValue: value,
  };
}

export function updateCompositionInputDraft(
  state: CompositionInputState,
  value: string,
  nativeIsComposing = false
): CompositionInputTransition {
  const isComposing = state.isComposing || nativeIsComposing;
  return transitionInputValue(state, value, isComposing, !isComposing);
}

export function completeCompositionInput(
  state: CompositionInputState,
  value: string
): CompositionInputTransition {
  return transitionInputValue(state, value, false, true);
}

export function commitCompositionInputOnBlur(
  state: CompositionInputState,
  value: string
): CompositionInputTransition {
  return transitionInputValue(state, value, false, true);
}

export function shouldSuppressKeyboardCommand(event: KeyboardCompositionState): boolean {
  return event.isComposing === true || event.keyCode === 229;
}
