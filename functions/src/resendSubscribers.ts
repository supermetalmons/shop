import type { Resend } from 'resend';
import { normalizeNotificationEmailRecipient } from './notifications.js';
import { summarizeResendError } from './resendErrors.js';

type ResendSubscriberContactInput = {
  email: string;
  unsubscribed: false;
};

type ResendSubscriberContactResponse =
  | { data: { id: string }; error: null }
  | { data: null; error: unknown };

export interface ResendSubscribersProvider {
  createContact(input: ResendSubscriberContactInput): Promise<ResendSubscriberContactResponse>;
}

class ResendSubscriberValidationError extends Error {
  readonly code = 'invalid_email';

  constructor() {
    super('Enter a valid email address.');
    this.name = 'ResendSubscriberValidationError';
  }
}

class ResendSubscriberProviderError extends Error {
  constructor() {
    super('Unable to subscribe.');
    this.name = 'ResendSubscriberProviderError';
  }
}

const EXISTING_CONTACT_ERROR_NAMES = new Set([
  'contact_already_exists',
  'duplicate_contact',
  'already_exists',
]);

function isExistingContactError(error: unknown): boolean {
  const { name, statusCode } = summarizeResendError(error);
  return statusCode === 409 || EXISTING_CONTACT_ERROR_NAMES.has(name.trim().toLowerCase());
}

export async function subscribeResendContact(params: {
  email: unknown;
  provider: ResendSubscribersProvider;
}): Promise<{ subscribed: true }> {
  const email = normalizeNotificationEmailRecipient(params.email);
  if (!email) throw new ResendSubscriberValidationError();

  try {
    const response = await params.provider.createContact({ email, unsubscribed: false });
    if (response.error !== null) {
      if (isExistingContactError(response.error)) return { subscribed: true };
      throw new ResendSubscriberProviderError();
    }
    if (!response.data.id) throw new ResendSubscriberProviderError();
    return { subscribed: true };
  } catch (error) {
    if (error instanceof ResendSubscriberProviderError) throw error;
    throw new ResendSubscriberProviderError();
  }
}

export function createResendSubscribersProvider(resend: Resend): ResendSubscribersProvider {
  return {
    createContact(input) {
      return resend.contacts.create(input);
    },
  };
}
