import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DeliveryForm } from '../src/components/DeliveryForm.tsx';

function renderDrifellaShirtDeliveryForm(countryCode: string): string {
  return renderToStaticMarkup(
    createElement(DeliveryForm, {
      onSubmit: async () => undefined,
      itemsPerBox: 0,
      boxNamePrefix: 'shirt',
      figureNamePrefix: 'shirt',
      dropFamily: 'drifella_shirt',
      countryCode,
    }),
  );
}

test('drifella shirt delivery form describes flat US and international shipping', () => {
  const usMarkup = renderDrifellaShirtDeliveryForm('US');
  assert.match(usMarkup, /US delivery: 0\.1 SOL\./);
  assert.doesNotMatch(usMarkup, /Free US shipping|additional shirt/);

  const internationalMarkup = renderDrifellaShirtDeliveryForm('TR');
  assert.match(internationalMarkup, /International delivery: 0\.25 SOL\./);
  assert.doesNotMatch(internationalMarkup, /up to 1 shirt|additional shirt/);
});
