/**
 * Masking for personal data shown to staff. Unmasked values are only returned by the
 * explicit, permission-checked and audited reveal endpoints.
 */

/** "+919876543210" → "******3210". */
export function maskPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  return `******${digits.slice(-4)}`;
}

/** "sanjay@example.com" → "s*****@example.com". */
export function maskEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const [local = '', domain = ''] = email.split('@');
  return `${local.slice(0, 1)}*****@${domain}`;
}

/** Keeps only the first name initial and surname initial: "Sanjay Suman" → "S. S." */
export function maskName(name: string | null | undefined): string | null {
  if (!name) return null;
  return name
    .trim()
    .split(/\s+/)
    .map((part) => `${part.slice(0, 1).toUpperCase()}.`)
    .join(' ');
}

/** Area-level address for staff views: locality and pincode, no house or street. */
export interface MaskedAddress {
  readonly locality: string | null;
  readonly pincode: string;
  readonly cityName: string;
}

export function maskAddress(address: {
  pincode: string;
  cityName: string;
  locality?: string | null;
}): MaskedAddress {
  return {
    locality: address.locality ?? null,
    pincode: address.pincode,
    cityName: address.cityName,
  };
}
