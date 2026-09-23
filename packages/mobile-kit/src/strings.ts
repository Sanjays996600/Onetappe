export type Locale = 'en' | 'hi';

/** Copy shared by both apps. A missing Hindi string is a type error. */
const en = {
  retry: 'Try again',
  continue: 'Continue',
  cancel: 'Cancel',
  back: 'Back',
  loading: 'Loading…',
  emergency: 'Emergency? Call 112',
  noConnection: 'No internet connection. Check your connection and try again.',
  timeout: 'The server took too long to answer. Try again.',
  serviceUnavailable: 'The service is busy right now. Please try again in a moment.',
  tooManyRequests: 'Too many attempts in a short time. Please wait a minute and try again.',
  signedOut: 'Please sign in again.',
  somethingWrong: 'Something went wrong. Please try again.',
  reference: 'Reference',
  phoneNumber: 'Mobile number',
  sendCode: 'Send code',
  enterCode: 'Enter the 6-digit code sent to',
  code: 'Code',
  verify: 'Verify',
  resendIn: 'Resend code in',
  resend: 'Resend code',
  changeNumber: 'Change number',
} as const;

type Strings = { readonly [K in keyof typeof en]: string };

const hi: Strings = {
  retry: 'फिर कोशिश करें',
  continue: 'आगे बढ़ें',
  cancel: 'रद्द करें',
  back: 'वापस',
  loading: 'लोड हो रहा है…',
  emergency: 'आपातकाल? 112 पर कॉल करें',
  noConnection: 'इंटरनेट कनेक्शन नहीं है। कनेक्शन जाँचें और फिर कोशिश करें।',
  timeout: 'सर्वर ने जवाब देने में बहुत समय लिया। फिर कोशिश करें।',
  serviceUnavailable: 'सेवा अभी व्यस्त है। थोड़ी देर में फिर कोशिश करें।',
  tooManyRequests: 'कम समय में बहुत सारे प्रयास। एक मिनट रुककर फिर कोशिश करें।',
  signedOut: 'कृपया फिर से साइन इन करें।',
  somethingWrong: 'कुछ गलत हो गया। कृपया फिर कोशिश करें।',
  reference: 'संदर्भ',
  phoneNumber: 'मोबाइल नंबर',
  sendCode: 'कोड भेजें',
  enterCode: '6 अंकों का कोड डालें जो भेजा गया है',
  code: 'कोड',
  verify: 'पुष्टि करें',
  resendIn: 'कोड दोबारा भेजें',
  resend: 'कोड दोबारा भेजें',
  changeNumber: 'नंबर बदलें',
};

export const commonStrings: Record<Locale, Strings> = { en, hi };
export type CommonKey = keyof typeof en;
