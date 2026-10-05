import assert from 'node:assert/strict';
import test, { after, afterEach, mock } from 'node:test';
import { createElement } from 'react';
import { setupFrontendDom } from './helpers/frontendDom.ts';
import { MI_NOTE_PACK_STARS } from '../src/lib/miNotePackStars.ts';
import { parseMiNoteStarFolds, serializeMiNoteStarFolds } from '../src/lib/miNoteStarFolds.ts';
import { isKeyboardShortcutTarget } from '../src/lib/focusTrap.ts';

const { dom } = setupFrontendDom();

const { act, cleanup, fireEvent, render } = await import('@testing-library/react');
const { default: MiNoteFoldControls } = await import('../src/components/MiNoteFoldControls.tsx');

afterEach(() => {
  cleanup();
  mock.restoreAll();
  Reflect.deleteProperty(navigator, 'clipboard');
});
after(() => dom.window.close());

function props(overrides: Partial<Parameters<typeof MiNoteFoldControls>[0]> = {}) {
  return {
    foldPosition: 0.49,
    foldPositions: parseMiNoteStarFolds(null),
    rotationOffsetDegrees: 0,
    rotationOffsetsDegrees: Object.fromEntries(MI_NOTE_PACK_STARS.map(({ id, rotationOffsetDegrees }) => [id, rotationOffsetDegrees])),
    storageError: false,
    disabled: false,
    onChange: () => undefined,
    onRotationChange: () => undefined,
    ...overrides,
  };
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function setClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
}

test('horizontal slider emits normalized values and retains focus when the value changes', () => {
  const onChange = mock.fn();
  const initial = props({ onChange });
  const view = render(createElement(MiNoteFoldControls, initial));
  const slider = view.getByRole('slider', { name: 'Horizontal position' }) as HTMLInputElement;
  assert.equal(slider.min, '10');
  assert.equal(slider.max, '90');
  assert.equal(slider.step, '0.1');
  assert.equal(isKeyboardShortcutTarget(slider), true);
  slider.focus();
  fireEvent.change(slider, { target: { value: '62.1' } });
  assert.equal(onChange.mock.calls[0].arguments[0], 0.621);

  view.rerender(createElement(MiNoteFoldControls, {
    ...initial,
    foldPosition: 0.621,
    foldPositions: { ...initial.foldPositions, twinkle: 0.621 },
  }));
  assert.equal(view.getByRole('slider', { name: 'Horizontal position' }), slider);
  assert.equal(document.activeElement, slider);
  assert.equal(slider.value, '62.1');
  assert.equal(slider.getAttribute('aria-valuetext'), '62.1%');
});

test('rotation slider centers on the original orientation and preserves focus during adjustment', () => {
  const onRotationChange = mock.fn();
  const initial = props({ onRotationChange });
  const view = render(createElement(MiNoteFoldControls, initial));
  const slider = view.getByRole('slider', { name: 'Rotation' }) as HTMLInputElement;
  assert.equal(slider.min, '-15');
  assert.equal(slider.max, '15');
  assert.equal(slider.step, '0.1');
  assert.equal(slider.value, '0');
  assert.equal(slider.getAttribute('aria-valuetext'), '0.0°, original rotation');
  assert.equal(isKeyboardShortcutTarget(slider), true);
  slider.focus();
  fireEvent.change(slider, { target: { value: '-2.5' } });
  assert.equal(onRotationChange.mock.calls[0].arguments[0], -2.5);

  view.rerender(createElement(MiNoteFoldControls, {
    ...initial,
    rotationOffsetDegrees: -2.5,
    rotationOffsetsDegrees: { ...initial.rotationOffsetsDegrees, twinkle: -2.5 },
  }));
  assert.equal(view.getByRole('slider', { name: 'Rotation' }), slider);
  assert.equal(document.activeElement, slider);
  assert.equal(slider.value, '-2.5');
  assert.equal(slider.getAttribute('aria-valuetext'), '-2.5° from original rotation');
  assert.ok(view.getByText('-2.5°'));

  view.rerender(createElement(MiNoteFoldControls, { ...initial, rotationOffsetDegrees: 3 }));
  assert.equal(slider.getAttribute('aria-valuetext'), '+3.0° from original rotation');
  assert.ok(view.getByText('+3.0°'));
});

test('the fixed Blush reference blocks slider changes but still exports every star', async () => {
  const onChange = mock.fn();
  const onRotationChange = mock.fn();
  const writeText = mock.fn(async () => undefined);
  setClipboard(writeText);
  const initial = props({ disabled: true, foldPosition: 0.578, rotationOffsetDegrees: 2.8, onChange, onRotationChange });
  const view = render(createElement(MiNoteFoldControls, initial));
  assert.ok(view.getByText('Blush is the fixed reference.'));
  const horizontal = view.getByRole('slider', { name: 'Horizontal position' }) as HTMLInputElement;
  const rotation = view.getByRole('slider', { name: 'Rotation' }) as HTMLInputElement;
  assert.equal(horizontal.disabled, true);
  assert.equal(rotation.disabled, true);
  fireEvent.change(horizontal, { target: { value: '80' } });
  fireEvent.change(rotation, { target: { value: '-10' } });
  assert.equal(onChange.mock.callCount(), 0);
  assert.equal(onRotationChange.mock.callCount(), 0);
  const copy = view.getByRole('button', { name: 'Copy JSON' }) as HTMLButtonElement;
  assert.equal(copy.disabled, false);
  assert.equal(isKeyboardShortcutTarget(copy), true);
  await act(async () => fireEvent.click(copy));
  const exported = JSON.parse(writeText.mock.calls[0].arguments[0] as string);
  assert.deepEqual(Object.keys(exported.foldPositions), MI_NOTE_PACK_STARS.map(({ id }) => id));
  assert.equal(exported.foldPositions.blush, 0.578);
  assert.equal(exported.rotationOffsetsDegrees.blush, 2.8);
});

test('copy waits for clipboard success and exports every star including unchanged defaults', async () => {
  const request = deferred();
  const writeText = mock.fn(() => request.promise);
  setClipboard(writeText);
  const initial = props({
    foldPositions: { ...parseMiNoteStarFolds(null), twinkle: 0.621 },
    rotationOffsetsDegrees: { ...props().rotationOffsetsDegrees, twinkle: -2.5 },
  });
  const view = render(createElement(MiNoteFoldControls, initial), { reactStrictMode: true });
  fireEvent.click(view.getByRole('button', { name: 'Copy JSON' }));

  assert.equal(view.queryByRole('button', { name: 'Copied' }), null);
  assert.equal((view.getByRole('button', { name: 'Copying…' }) as HTMLButtonElement).disabled, true);
  assert.equal(writeText.mock.callCount(), 1);
  const json = writeText.mock.calls[0].arguments[0] as string;
  assert.equal(json, serializeMiNoteStarFolds(initial.foldPositions, initial.rotationOffsetsDegrees));
  const exported = JSON.parse(json);
  assert.equal(exported.version, 1);
  assert.equal(Object.keys(exported.foldPositions).length, MI_NOTE_PACK_STARS.length);
  assert.equal(exported.foldPositions.twinkle, 0.621);
  assert.equal(exported.foldPositions.blush, 0.578);
  assert.equal(Object.keys(exported.rotationOffsetsDegrees).length, MI_NOTE_PACK_STARS.length);
  assert.equal(exported.rotationOffsetsDegrees.twinkle, -2.5);
  assert.equal(exported.rotationOffsetsDegrees.blush, 2.8);

  await act(async () => request.resolve());
  assert.ok(view.getByRole('button', { name: 'Copied' }));
  assert.ok(view.getByText('Copied to clipboard'));
});

test('clipboard rejection exposes selectable JSON and closing returns focus to Copy JSON', async () => {
  setClipboard(() => Promise.reject(new Error('Permission denied')));
  const initial = props();
  const view = render(createElement(MiNoteFoldControls, initial));
  await act(async () => fireEvent.click(view.getByRole('button', { name: 'Copy JSON' })));
  const textarea = view.getByRole('textbox', { name: 'Star tuning JSON' }) as HTMLTextAreaElement;
  assert.equal(view.queryByRole('button', { name: 'Copied' }), null);
  assert.equal(textarea.value, serializeMiNoteStarFolds(initial.foldPositions, initial.rotationOffsetsDegrees));
  assert.equal(textarea.readOnly, true);
  assert.equal(isKeyboardShortcutTarget(textarea), true);
  assert.equal(document.activeElement, textarea);
  assert.equal(textarea.selectionStart, 0);
  assert.equal(textarea.selectionEnd, textarea.value.length);

  const copyButton = view.getByRole('button', { name: 'Copy JSON' });
  const focus = copyButton.focus.bind(copyButton);
  const restoredFocus = mock.method(copyButton, 'focus', () => {
    assert.equal(view.queryByRole('textbox', { name: 'Star tuning JSON' }), null);
    focus();
  });
  fireEvent.click(view.getByRole('button', { name: 'Close JSON export' }));
  assert.equal(view.queryByRole('textbox', { name: 'Star tuning JSON' }), null);
  assert.equal(restoredFocus.mock.callCount(), 1);
  assert.equal(document.activeElement, view.getByRole('button', { name: 'Copy JSON' }));
});

test('missing clipboard support offers a manual export with the latest values', async () => {
  const initial = props();
  const view = render(createElement(MiNoteFoldControls, initial));
  await act(async () => fireEvent.click(view.getByRole('button', { name: 'Copy JSON' })));
  const latest = {
    ...initial,
    foldPositions: { ...initial.foldPositions, twinkle: 0.45 },
    rotationOffsetsDegrees: { ...initial.rotationOffsetsDegrees, twinkle: 3 },
  };
  view.rerender(createElement(MiNoteFoldControls, latest));
  const textarea = view.getByRole('textbox', { name: 'Star tuning JSON' }) as HTMLTextAreaElement;
  assert.equal(JSON.parse(textarea.value).foldPositions.twinkle, 0.45);
  assert.equal(JSON.parse(textarea.value).rotationOffsetsDegrees.twinkle, 3);
});

test('changing folds during clipboard permission does not claim stale values were copied', async () => {
  const request = deferred();
  const writeText = mock.fn(() => request.promise);
  setClipboard(writeText);
  const initial = props();
  const view = render(createElement(MiNoteFoldControls, initial));
  fireEvent.click(view.getByRole('button', { name: 'Copy JSON' }));
  const latest = { ...initial, foldPosition: 0.7, foldPositions: { ...initial.foldPositions, twinkle: 0.7 } };
  view.rerender(createElement(MiNoteFoldControls, latest));
  fireEvent.click(view.getByRole('button', { name: 'Copying…' }));
  assert.equal(writeText.mock.callCount(), 1);

  await act(async () => request.resolve());
  assert.equal(view.queryByRole('button', { name: 'Copied' }), null);
  await act(async () => fireEvent.click(view.getByRole('button', { name: 'Copy JSON' })));
  assert.equal(writeText.mock.callCount(), 2);
  assert.equal(JSON.parse(writeText.mock.calls[1].arguments[0] as string).foldPositions.twinkle, 0.7);
  assert.ok(view.getByRole('button', { name: 'Copied' }));
});

test('changing rotation during clipboard permission does not claim stale values were copied', async () => {
  const request = deferred();
  const writeText = mock.fn(() => request.promise);
  setClipboard(writeText);
  const initial = props();
  const view = render(createElement(MiNoteFoldControls, initial));
  fireEvent.click(view.getByRole('button', { name: 'Copy JSON' }));
  view.rerender(createElement(MiNoteFoldControls, {
    ...initial,
    rotationOffsetDegrees: 4.1,
    rotationOffsetsDegrees: { ...initial.rotationOffsetsDegrees, twinkle: 4.1 },
  }));

  await act(async () => request.resolve());
  assert.equal(view.queryByRole('button', { name: 'Copied' }), null);
  await act(async () => fireEvent.click(view.getByRole('button', { name: 'Copy JSON' })));
  assert.equal(writeText.mock.callCount(), 2);
  assert.equal(JSON.parse(writeText.mock.calls[1].arguments[0] as string).rotationOffsetsDegrees.twinkle, 4.1);
  assert.ok(view.getByRole('button', { name: 'Copied' }));
});

test('changing tuning clears an earlier clipboard success message', async () => {
  setClipboard(async () => undefined);
  const initial = props();
  const view = render(createElement(MiNoteFoldControls, initial));
  await act(async () => fireEvent.click(view.getByRole('button', { name: 'Copy JSON' })));
  assert.ok(view.getByRole('button', { name: 'Copied' }));
  view.rerender(createElement(MiNoteFoldControls, {
    ...initial,
    foldPosition: 0.64,
    foldPositions: { ...initial.foldPositions, twinkle: 0.64 },
  }));
  assert.ok(view.getByRole('button', { name: 'Copy JSON' }));
  assert.equal(view.queryByText('Copied to clipboard'), null);
});

test('storage failures briefly report the problem while tuning remains usable', () => {
  let dismiss: (() => void) | undefined;
  mock.method(window, 'setTimeout', (callback: () => void, delay: number) => {
    if (delay === 4000) dismiss = callback;
    return 1;
  });
  const onChange = mock.fn();
  const onRotationChange = mock.fn();
  const initial = props({ storageError: true, onChange, onRotationChange });
  const view = render(createElement(MiNoteFoldControls, initial));
  assert.ok(view.getByText('Not saved locally'));
  fireEvent.change(view.getByRole('slider', { name: 'Horizontal position' }), { target: { value: '80' } });
  assert.equal(onChange.mock.calls[0].arguments[0], 0.8);
  assert.ok(dismiss);
  act(() => dismiss());
  assert.equal(view.queryByText('Not saved locally'), null);
  fireEvent.change(view.getByRole('slider', { name: 'Rotation' }), { target: { value: '5' } });
  assert.equal(onRotationChange.mock.calls[0].arguments[0], 5);
  view.rerender(createElement(MiNoteFoldControls, {
    ...initial,
    rotationOffsetDegrees: 5,
    rotationOffsetsDegrees: { ...initial.rotationOffsetsDegrees, twinkle: 5 },
  }));
  assert.ok(view.getByText('Not saved locally'));
});

test('a clipboard failure after unmount does not focus or show a stale export', async () => {
  const request = deferred();
  setClipboard(() => request.promise);
  const view = render(createElement(MiNoteFoldControls, props()));
  fireEvent.click(view.getByRole('button', { name: 'Copy JSON' }));
  view.unmount();
  await act(async () => request.reject(new Error('Permission denied')));
  assert.equal(document.querySelector('textarea'), null);
});
