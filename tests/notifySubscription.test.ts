import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NotifySubscription } from '../src/components/NotifySubscription.tsx';

test('shared notification subscription renders the Resend-backed form when open', () => {
  const markup = renderToStaticMarkup(
    createElement(NotifySubscription, {
      open: true,
      onOpenChange: () => undefined,
      onSubscribed: () => undefined,
    }),
  );

  assert.match(markup, /role="dialog"/);
  assert.match(markup, /aria-label="Notify me"/);
  assert.match(markup, /type="email"/);
  assert.match(markup, />Cancel</);
  assert.match(markup, />OK</);
  assert.doesNotMatch(markup, /success-hud|success-announcer/);
});

test('shared notification subscription keeps the form hidden when closed', () => {
  const markup = renderToStaticMarkup(
    createElement(NotifySubscription, {
      open: false,
      onOpenChange: () => undefined,
      onSubscribed: () => undefined,
    }),
  );

  assert.doesNotMatch(markup, /role="dialog"/);
  assert.doesNotMatch(markup, /type="email"/);
});
