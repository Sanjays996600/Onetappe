import { ValidationError } from '../../common/errors.js';

/**
 * Normalises an Indian mobile number to E.164 (+91XXXXXXXXXX). Accepts "9876543210",
 * "09876543210", "919876543210" and "+91 98765 43210".
 */
export function normaliseIndianMobile(input: string): string {
  const digits = input.replace(/[\s()-]/g, '');
  const match = /^(?:\+?91|0)?([6-9]\d{9})$/.exec(digits);
  if (!match?.[1]) {
    throw new ValidationError('PHONE_INVALID', 'Enter a valid 10-digit Indian mobile number');
  }
  return `+91${match[1]}`;
}
