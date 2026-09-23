import { useEffect, useState } from 'react';
import type { IssuedTokens, OtpChallenge } from '@onetappe/api-client';
import { Body, Button, Field, Notice, Title } from './components';
import { describeError } from './errors';
import { toE164 } from './format';
import { commonStrings, type Locale } from './strings';

const OTP_MESSAGES: Record<Locale, Record<string, string>> = {
  en: {
    OTP_INVALID: 'That code is not correct. Check the SMS and try again.',
    OTP_ATTEMPTS_EXCEEDED: 'Too many wrong codes. Ask for a new code.',
    OTP_EXPIRED: 'This code has expired. Ask for a new code.',
    OTP_COOLDOWN: 'Please wait a little before asking for another code.',
    OTP_LIMIT: 'Too many codes requested. Please try again later.',
    OTP_LOCKED: 'Too many wrong codes for this number. Please try again in an hour.',
    OTP_DELIVERY_FAILED: 'We could not send the SMS just now. Please try again.',
    PHONE_INVALID: 'Enter a valid 10-digit Indian mobile number.',
  },
  hi: {
    OTP_INVALID: 'यह कोड सही नहीं है। SMS जाँचें और फिर कोशिश करें।',
    OTP_ATTEMPTS_EXCEEDED: 'बहुत बार गलत कोड। नया कोड माँगें।',
    OTP_EXPIRED: 'यह कोड समाप्त हो गया है। नया कोड माँगें।',
    OTP_COOLDOWN: 'दूसरा कोड माँगने से पहले थोड़ा इंतज़ार करें।',
    OTP_LIMIT: 'बहुत सारे कोड माँगे गए। बाद में फिर कोशिश करें।',
    OTP_LOCKED: 'इस नंबर के लिए बहुत बार गलत कोड। एक घंटे बाद फिर कोशिश करें।',
    OTP_DELIVERY_FAILED: 'अभी SMS नहीं भेज पाए। फिर कोशिश करें।',
    PHONE_INVALID: 'सही 10 अंकों का भारतीय मोबाइल नंबर डालें।',
  },
};

export interface OtpApi<S extends IssuedTokens> {
  requestOtp(input: { phone: string; locale?: Locale }): Promise<OtpChallenge>;
  verifyOtp(input: { challengeId: string; phone: string; code: string }): Promise<S>;
}

/**
 * Phone number → SMS code → signed in. Shared by the customer and worker apps. There is
 * no password and no test/master code: the code only ever comes by SMS.
 */
export function PhoneSignIn<S extends IssuedTokens>({
  api,
  locale,
  title,
  onSignedIn,
}: {
  api: OtpApi<S>;
  locale: Locale;
  title: string;
  onSignedIn: (session: S) => Promise<void> | void;
}) {
  const t = commonStrings[locale];
  const [phone, setPhone] = useState('');
  const [challenge, setChallenge] = useState<OtpChallenge | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<ReturnType<typeof describeError> | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!challenge) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [challenge]);

  const send = async () => {
    const e164 = toE164(phone);
    if (!e164) {
      setProblem({
        message: OTP_MESSAGES[locale].PHONE_INVALID ?? '',
        reference: null,
        code: 'PHONE_INVALID',
      });
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      setChallenge(await api.requestOtp({ phone: e164, locale }));
      setCode('');
    } catch (error) {
      setProblem(describeError(error, locale, OTP_MESSAGES[locale]));
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    if (!challenge) return;
    setBusy(true);
    setProblem(null);
    try {
      const session = await api.verifyOtp({
        challengeId: challenge.challengeId,
        phone: challenge.phone,
        code: code.trim(),
      });
      await onSignedIn(session);
    } catch (error) {
      setProblem(describeError(error, locale, OTP_MESSAGES[locale]));
    } finally {
      setBusy(false);
    }
  };

  const waitSeconds = challenge
    ? Math.max(0, Math.ceil((Date.parse(challenge.resendAvailableAt) - now) / 1000))
    : 0;

  return (
    <>
      <Title>{title}</Title>
      {problem ? (
        <Notice kind="error" reference={problem.reference} locale={locale}>
          {problem.message}
        </Notice>
      ) : null}
      {!challenge ? (
        <>
          <Field
            label={t.phoneNumber}
            value={phone}
            onChangeText={setPhone}
            keyboardType="phone-pad"
            autoComplete="tel"
            textContentType="telephoneNumber"
            placeholder="98765 43210"
            maxLength={16}
          />
          <Button label={t.sendCode} onPress={() => void send()} busy={busy} />
        </>
      ) : (
        <>
          <Body>
            {t.enterCode} {challenge.phone}
          </Body>
          <Field
            label={t.code}
            value={code}
            onChangeText={(v) => setCode(v.replace(/\D/g, '').slice(0, 6))}
            keyboardType="number-pad"
            autoComplete="sms-otp"
            textContentType="oneTimeCode"
            maxLength={6}
          />
          <Button
            label={t.verify}
            onPress={() => void verify()}
            busy={busy}
            disabled={code.length !== 6}
          />
          <Button
            kind="secondary"
            label={waitSeconds > 0 ? `${t.resendIn} (${String(waitSeconds)}s)` : t.resend}
            onPress={() => void send()}
            disabled={waitSeconds > 0 || busy}
          />
          <Button kind="secondary" label={t.changeNumber} onPress={() => setChallenge(null)} />
        </>
      )}
    </>
  );
}
