/**
 * Personal data and secrets must not reach logs, metrics or error reports. Log text is
 * passed through these rules before it is written; structured fields whose name suggests
 * sensitive content are replaced entirely.
 */

const PHONE = /(?<![\w.])\+?\d[\d\s-]{8,14}\d(?![\w.])/g;
const EMAIL = /\b([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g;
const BEARER = /\b(Bearer|Zoho-oauthtoken)\s+[A-Za-z0-9._~+/=-]+/gi;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const SECRET_PARAM = /\b(key|token|secret|signature|password|otp|code)=([^&\s"']+)/gi;

const SENSITIVE_FIELD =
  /^(phone|mobile|email|address|addressText|password|secret|token|accessToken|refreshToken|authorization|otp|code|pan|aadhaar|accountNumber|ifsc|lat|lng|name|fullName|contactName|contactPhone)$/i;

export function redactText(text: string): string {
  return text
    .replace(BEARER, '$1 [REDACTED]')
    .replace(JWT, '[REDACTED_TOKEN]')
    .replace(SECRET_PARAM, '$1=[REDACTED]')
    .replace(EMAIL, '$1***@$2')
    .replace(PHONE, (match) => {
      const digits = match.replace(/\D/g, '');
      // Ids, amounts and timestamps are rarely 10–13 plain digits with a phone prefix;
      // anything that looks like a phone number is masked to its last four digits.
      return digits.length >= 10 && digits.length <= 13 ? `******${digits.slice(-4)}` : match;
    });
}

/** Deep copy of a log field value with sensitive keys removed and text redacted. */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 5) return '[TRUNCATED]';
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redactValue(v, depth + 1));
  if (value instanceof Error) return { name: value.name, message: redactText(value.message) };
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_FIELD.test(key) ? '[REDACTED]' : redactValue(inner, depth + 1);
    }
    return out;
  }
  return value;
}
