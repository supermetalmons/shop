import test from 'node:test';
import assert from 'node:assert/strict';
import {
  subscribeResendContact,
  type ResendSubscribersProvider,
} from '../functions/src/resendSubscribers.ts';

function provider(
  createContact: ResendSubscribersProvider['createContact'],
): ResendSubscribersProvider {
  return { createContact };
}

test('subscription normalizes the email and creates an active contact', async () => {
  let received: unknown;
  const result = await subscribeResendContact({
    email: ' Buyer@Example.COM ',
    provider: provider(async (input) => {
      received = input;
      return { data: { id: 'contact-1' }, error: null };
    }),
  });

  assert.deepEqual(received, {
    email: 'buyer@example.com',
    unsubscribed: false,
  });
  assert.deepEqual(result, { subscribed: true });
});

test('subscription rejects invalid email addresses before calling Resend', async () => {
  let calls = 0;

  await assert.rejects(
    subscribeResendContact({
      email: 'not an email',
      provider: provider(async () => {
        calls += 1;
        return { data: { id: 'unexpected' }, error: null };
      }),
    }),
    {
      name: 'ResendSubscriberValidationError',
      message: 'Enter a valid email address.',
    },
  );
  assert.equal(calls, 0);
});

test('subscription treats an existing Resend contact as success', async () => {
  const result = await subscribeResendContact({
    email: 'buyer@example.com',
    provider: provider(async () => ({
      data: null,
      error: {
        name: 'contact_already_exists',
        message: 'Contact already exists',
        statusCode: 409,
      },
    })),
  });

  assert.deepEqual(result, { subscribed: true });
});

test('subscription hides Resend response and transport failures', async () => {
  await assert.rejects(
    subscribeResendContact({
      email: 'buyer@example.com',
      provider: provider(async () => ({
        data: null,
        error: {
          name: 'validation_error',
          message: 'Provider detail',
          statusCode: 422,
        },
      })),
    }),
    {
      name: 'ResendSubscriberProviderError',
      message: 'Unable to subscribe.',
    },
  );

  await assert.rejects(
    subscribeResendContact({
      email: 'buyer@example.com',
      provider: provider(async () => {
        throw new Error('Network detail');
      }),
    }),
    {
      name: 'ResendSubscriberProviderError',
      message: 'Unable to subscribe.',
    },
  );
});
