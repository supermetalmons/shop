import { z } from 'zod';
import { isStripeDisputeId } from '../../../../shared/stripeChargebacks.js';

export const stripeChargebackBackfillRequestSchema = z.object({
  mode: z.enum(['live', 'test']),
  cursor: z.string().refine(isStripeDisputeId).optional(),
  write: z.boolean().optional(),
}).strict();

export const stripeChargebackWebhookConfigurationRequestSchema = z.object({
  mode: z.enum(['live', 'test']),
  write: z.boolean().optional(),
}).strict();
