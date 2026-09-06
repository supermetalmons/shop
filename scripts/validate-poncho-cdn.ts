import { CDN_VALIDATION_SPECS, validateCdn } from './shared/cdnValidation.ts';

const result = await validateCdn(CDN_VALIDATION_SPECS.ponchoDrifella);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
