import test, { after, afterEach, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createElement, useState } from 'react';
import { setupFrontendDom } from './helpers/frontendDom.ts';

const { dom } = setupFrontendDom();
const { act, cleanup, fireEvent, render, waitFor } = await import('@testing-library/react');
const { NotifySubscription } = await import('../src/components/NotifySubscription.tsx');
const { SuccessHud, useSuccessHud } = await import('../src/components/SuccessHud.tsx');
let respond: typeof fetch;

beforeEach(() => {
  respond = async () => assert.fail('Unexpected notification request');
  mock.method(globalThis, 'fetch', (...args: Parameters<typeof fetch>) => respond(...args));
});
afterEach(() => {
  cleanup();
  mock.restoreAll();
});
after(() => dom.window.close());

function Subscription({ suspended = false, onSubscribed = () => undefined }: {
  suspended?: boolean;
  onSubscribed?: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const hud = useSuccessHud(suspended);
  return createElement('div', null,
    createElement('button', { onClick: () => setOpen(true) }, 'Notify me about drops'),
    createElement(NotifySubscription, {
      open,
      onOpenChange: setOpen,
      suspended,
      onSubscribed: (message) => {
        onSubscribed(message);
        hud.show(message);
      },
    }),
    createElement(SuccessHud, { phase: hud.phase, announcement: hud.announcement }),
  );
}

function openSubscription(view: ReturnType<typeof render>) {
  const opener = view.getByRole('button', { name: 'Notify me about drops' });
  opener.focus();
  fireEvent.click(opener);
  return opener;
}

test('notification form is hidden until opened, and cancelling restores opener focus', () => {
  const view = render(createElement(Subscription));
  assert.equal(view.queryByRole('dialog'), null);
  assert.equal(view.queryByRole('textbox', { name: 'Email' }), null);
  const opener = openSubscription(view);
  const email = view.getByRole('textbox', { name: 'Email' });
  assert.equal(email.getAttribute('type'), 'email');
  assert.equal(document.activeElement, email);
  assert.ok(view.getByRole('dialog', { name: 'Notify me' }));
  fireEvent.click(view.getByRole('button', { name: 'Cancel' }));
  assert.equal(view.queryByRole('dialog'), null);
  assert.equal(document.activeElement, opener);
  assert.equal(view.getByRole('status').textContent, '');
});

test('successful notification signup closes the form and announces through the parent HUD', async () => {
  const announcements: string[] = [];
  const requests: unknown[] = [];
  let complete!: (response: Response) => void;
  respond = async (input, init) => {
    assert.match(String(input), /\/notifications\/subscribe$/);
    assert.equal(init?.method, 'POST');
    requests.push(JSON.parse(String(init?.body)));
    return new Promise<Response>((resolve) => { complete = resolve; });
  };
  const view = render(createElement(Subscription, { onSubscribed: (message) => { announcements.push(message); } }));
  const opener = openSubscription(view);
  const email = view.getByRole('textbox', { name: 'Email' }) as HTMLInputElement;
  fireEvent.change(email, { target: { value: 'person@example.com' } });
  const submit = view.getByRole('button', { name: 'OK' });
  fireEvent.click(submit);
  assert.equal(email.disabled, true);
  assert.equal(submit.getAttribute('aria-busy'), 'true');
  assert.equal(document.activeElement, submit);
  fireEvent.click(submit);
  assert.deepEqual(requests, [{ email: 'person@example.com' }]);
  assert.deepEqual(announcements, []);

  await act(async () => complete(Response.json({ subscribed: true })));
  assert.equal(view.queryByRole('dialog'), null);
  assert.equal(document.activeElement, opener);
  assert.deepEqual(announcements, ['You’re on the list.']);
  await waitFor(() => assert.equal(view.getByRole('status').textContent, 'You’re on the list.'));
});

test('invalid email and failed requests leave the form usable without announcing success', async () => {
  const view = render(createElement(Subscription, { onSubscribed: () => assert.fail('Failed signup must not announce success') }));
  openSubscription(view);
  const email = view.getByRole('textbox', { name: 'Email' }) as HTMLInputElement;
  fireEvent.change(email, { target: { value: 'invalid' } });
  fireEvent.click(view.getByRole('button', { name: 'OK' }));
  assert.equal(view.getByRole('alert').textContent, 'Enter a valid email address.');
  assert.equal(email.getAttribute('aria-invalid'), 'true');

  respond = async () => Response.json({ error: 'unavailable' }, { status: 503 });
  fireEvent.change(email, { target: { value: 'person@example.com' } });
  assert.equal(view.queryByRole('alert'), null);
  await act(async () => { fireEvent.click(view.getByRole('button', { name: 'OK' })); });
  assert.equal(view.getByRole('alert').textContent, 'Unable to subscribe. Please try again.');
  assert.equal(email.disabled, false);
  assert.equal(view.getByRole('button', { name: 'OK' }).getAttribute('aria-busy'), 'false');
  assert.equal(view.getByRole('status').textContent, '');
});

test('suspended notification overlays ignore dismissal and resume Escape handling when active', () => {
  const view = render(createElement(Subscription));
  const opener = openSubscription(view);
  const dialog = view.getByRole('dialog', { name: 'Notify me' });
  view.rerender(createElement(Subscription, { suspended: true }));
  assert.equal(dialog.hasAttribute('inert'), true);
  assert.equal(dialog.getAttribute('aria-hidden'), 'true');
  fireEvent.keyDown(document, { key: 'Escape' });
  fireEvent.click(dialog.parentElement!);
  assert.equal(dialog.isConnected, true);

  view.rerender(createElement(Subscription));
  assert.equal(dialog.hasAttribute('inert'), false);
  fireEvent.keyDown(document, { key: 'Escape' });
  assert.equal(view.queryByRole('dialog'), null);
  assert.equal(document.activeElement, opener);
});
