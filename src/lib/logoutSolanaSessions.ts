import { logoutAnonymousSession } from './anonymousSession';
import { logoutStaffWalletSession, readStaffWalletSession } from './staffWalletSession';

const DEFAULT_RUNTIME = { logoutAnonymousSession, logoutStaffWalletSession, readStaffWalletSession };

export async function logoutSolanaSessions(runtime = DEFAULT_RUNTIME): Promise<void> {
  const staffSession = runtime.readStaffWalletSession();
  const errors: unknown[] = [];
  try {
    await runtime.logoutAnonymousSession();
  } catch (error) {
    errors.push(error);
  }
  if (staffSession) {
    try {
      await runtime.logoutStaffWalletSession(staffSession);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'Unable to end all sign-in sessions. Please try again.');
}
