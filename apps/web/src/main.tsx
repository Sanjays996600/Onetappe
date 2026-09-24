import { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';
import type { SyntheticEvent, ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { ApiClient, ApiError, SubmissionKeys, dateTime, indiaDate, money } from './api.ts';
import { checkout } from './checkout.ts';
import { Room } from './Room.tsx';
import type {
  Address,
  Booking,
  BookingSummary,
  Catalog,
  Invoice,
  Locale,
  Payment,
  Profile,
  Quote,
  Service,
  ServiceDetail,
  SupportCase,
  Tokens,
} from './types.ts';
import './styles.css';

type Translate = (en: string, hi: string) => string;
interface AppContext {
  api: ApiClient;
  locale: Locale;
  t: Translate;
  profile: Profile | null;
  setProfile: (p: Profile | null) => void;
}
const Context = createContext<AppContext | null>(null);
function useApp() {
  const value = useContext(Context);
  if (!value) throw new Error('App context missing');
  return value;
}
function Icon({ name = 'check' }: { name?: string }) {
  const paths: Record<string, ReactNode> = {
    arrow: <path d="M4 12h15m-6-6 6 6-6 6" />,
    pin: (
      <>
        <path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 1 1 14 0Z" />
        <circle cx="12" cy="10" r="2" />
      </>
    ),
    clock: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 6v6l4 2" />
      </>
    ),
    shield: (
      <>
        <path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z" />
        <path d="m8 12 3 3 5-6" />
      </>
    ),
    home: (
      <>
        <path d="m3 11 9-8 9 8v10H3Z" />
        <path d="M9 21v-8h6v8" />
      </>
    ),
    sparkle: (
      <>
        <path d="m12 2 3 7 7 3-7 3-3 7-3-7-7-3 7-3Z" />
      </>
    ),
    check: <path d="m5 12 4 4L19 6" />,
    menu: <path d="M4 6h16M4 12h16M4 18h16" />,
    phone: <path d="m5 3 4 4-2 3c2 4 3 5 7 7l3-2 4 4c-5 7-22-10-16-16Z" />,
  };
  return (
    <svg
      viewBox="0 0 24 24"
      width="22"
      height="22"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] ?? paths['check']}
    </svg>
  );
}
function useAction() {
  const { t } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);
  const run = useCallback(
    (action: () => Promise<void>) => {
      if (lock.current) return;
      lock.current = true;
      setBusy(true);
      setError('');
      void action()
        .catch((e: unknown) => {
          const message =
            e instanceof Error
              ? e.message
              : t('Something went wrong. Please try again.', 'कुछ गलत हुआ। फिर से कोशिश करें।');
          setError(`${message}${e instanceof ApiError && e.requestId ? ` (${e.requestId})` : ''}`);
        })
        .finally(() => {
          lock.current = false;
          setBusy(false);
        });
    },
    [t],
  );
  return { busy, error, run, setError };
}
function Notice({ children, error = false }: { children: ReactNode; error?: boolean }) {
  return (
    <div className={`notice ${error ? 'error' : ''}`} role={error ? 'alert' : 'status'}>
      {children}
    </div>
  );
}
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}
function Form({
  children,
  submit,
  busy,
  label,
}: {
  children: ReactNode;
  submit: (data: FormData) => void;
  busy: boolean;
  label: string;
}) {
  return (
    <form
      onSubmit={(event: SyntheticEvent<HTMLFormElement>) => {
        event.preventDefault();
        submit(new FormData(event.currentTarget));
      }}
    >
      <fieldset disabled={busy}>
        {children}
        <button className="button full" type="submit">
          {busy ? '…' : label}
          <Icon name="arrow" />
        </button>
      </fieldset>
    </form>
  );
}
function value(data: FormData, key: string) {
  const item = data.get(key);
  return typeof item === 'string' ? item.trim() : '';
}
function PageIntro({ eyebrow, title, text }: { eyebrow: string; title: string; text?: string }) {
  return (
    <div className="page-intro">
      <p className="eyebrow">{eyebrow}</p>
      <h1>{title}</h1>
      {text && <p>{text}</p>}
    </div>
  );
}
function App() {
  const [locale, setLocale] = useState<Locale>('en');
  const [profile, setProfile] = useState<Profile | null>(null);
  const [route, setRoute] = useState(location.hash.slice(1) || '/');
  const [menu, setMenu] = useState(false);
  const [api] = useState(
    () =>
      new ApiClient(import.meta.env['VITE_API_BASE_URL'] as string | undefined, fetch, () => {
        setProfile(null);
      }),
  );
  const t: Translate = useCallback((en, hi) => (locale === 'en' ? en : hi), [locale]);
  useEffect(() => {
    const navigate = () => {
      setRoute(location.hash.slice(1) || '/');
      setMenu(false);
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', navigate);
    return () => {
      window.removeEventListener('hashchange', navigate);
    };
  }, []);
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  const links = [
    ['/book', t('Our services', 'हमारी सेवाएँ')],
    ['/about', t('How it works', 'कैसे काम करता है')],
    ['/bookings', t('My bookings', 'मेरी बुकिंग')],
    ['/help', t('Help & support', 'सहायता')],
  ];
  return (
    <Context.Provider value={{ api, locale, t, profile, setProfile }}>
      <a className="skip" href="#main">
        {t('Skip to content', 'सीधे सामग्री पर जाएँ')}
      </a>
      <div className="announcement">
        {t(
          'A little help for your home. A little more time for you.',
          'घर के लिए थोड़ी मदद। आपके लिए थोड़ा और समय।',
        )}
        <span>
          {t('Noida pilot', 'नोएडा पायलट')} <span className="dot" />
        </span>
      </div>
      <header>
        <a className="brand" href="#/" aria-label="One Tappe home">
          <span className="brand-icon">
            <Icon name="home" />
          </span>
          one tappe<span className="brand-period">.</span>
        </a>
        <nav aria-label={t('Main navigation', 'मुख्य मेनू')} className={menu ? 'open' : ''}>
          {links.map(([path, label]) => (
            <a key={path} href={`#${path}`} aria-current={route === path ? 'page' : undefined}>
              {label}
            </a>
          ))}
        </nav>
        <div className="header-actions">
          <button
            className="language"
            onClick={() => {
              setLocale(locale === 'en' ? 'hi' : 'en');
            }}
            aria-label={t('Switch to Hindi', 'Switch to English')}
          >
            {locale === 'en' ? 'हिन्दी' : 'English'}
          </button>
          <a className="button small" href="#/book">
            {t('Book a service', 'सेवा बुक करें')}
            <Icon name="arrow" />
          </a>
          <button
            className="mobile-menu"
            aria-expanded={menu}
            aria-label={t('Open menu', 'मेनू खोलें')}
            onClick={() => {
              setMenu(!menu);
            }}
          >
            <Icon name="menu" />
          </button>
        </div>
      </header>
      <main id="main" tabIndex={-1}>
        {route === '/' ? (
          <Home />
        ) : route === '/about' ? (
          <About />
        ) : ['/book', '/bookings', '/help'].includes(route) || route.startsWith('/bookings/') ? (
          <div className="workspace">
            <div className="account-bar">
              <span>
                {profile
                  ? t(
                      `Welcome, ${profile.fullName ?? 'neighbour'}`,
                      `नमस्ते, ${profile.fullName ?? 'दोस्त'}`,
                    )
                  : t('Your home, taken care of.', 'आपके घर का खयाल।')}
              </span>
              {profile && <Logout />}
            </div>
            {!profile ? (
              <Login />
            ) : route === '/book' ? (
              <ConsentGate>
                <Book key={profile.id} />
              </ConsentGate>
            ) : route === '/bookings' ? (
              <Bookings />
            ) : route === '/help' ? (
              <Help />
            ) : (
              <BookingPage key={route} id={route.split('/')[2] ?? ''} />
            )}
          </div>
        ) : (
          <div className="workspace">
            <PageIntro eyebrow="404" title={t('This page has moved.', 'यह पेज नहीं मिला।')} />
            <a className="button" href="#/">
              {t('Back to home', 'होम पर वापस')}
            </a>
          </div>
        )}
      </main>
      <footer>
        <div>
          <a className="brand" href="#/">
            <span className="brand-icon">
              <Icon name="home" />
            </span>
            one tappe.
          </a>
          <p>{t('A little help. A lot more living.', 'थोड़ी मदद। ज़िंदगी के लिए ज़्यादा समय।')}</p>
        </div>
        <div>
          <strong>{t('At your service', 'आपकी सेवा में')}</strong>
          <a href="#/book">{t('Explore house help', 'घरेलू सहायता देखें')}</a>
          <a href="#/bookings">{t('Manage a booking', 'बुकिंग देखें')}</a>
          <a href="#/help">{t('Get support', 'सहायता लें')}</a>
        </div>
        <div>
          <strong>{t('Thoughtful, by design', 'सोच-समझकर बनाई गई सेवा')}</strong>
          <p>
            {t(
              'Availability and prices depend on your address and selected time.',
              'उपलब्धता और कीमत आपके पते और चुने हुए समय पर निर्भर करती हैं।',
            )}
          </p>
          <a className="emergency" href="tel:112">
            <Icon name="phone" />
            {t('Emergency? Call 112', 'आपातकाल? 112 पर कॉल करें')}
          </a>
        </div>
        <div className="footer-bottom">
          © {new Date().getFullYear()} One Tappe{' '}
          <span>{t('Made for everyday life.', 'रोज़मर्रा की ज़िंदगी के लिए।')}</span>
        </div>
      </footer>
    </Context.Provider>
  );
}
function Home() {
  const { t } = useApp();
  return (
    <>
      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">
            <span className="dot" />
            {t('HOME HELP, WITHOUT THE HASSLE', 'घरेलू मदद, बिना परेशानी')}
          </p>
          <h1>
            {t('A little help.', 'थोड़ी मदद।')}
            <br />
            <em>
              {t('A lot more', 'ज़िंदगी के लिए')}
              <br />
              {t('living.', 'ज़्यादा समय।')}
            </em>
          </h1>
          <p className="hero-description">
            {t(
              'Come home to a lighter to-do list. Book thoughtful house help and make more room for the things you love.',
              'घर के कामों की चिंता कम करें। घरेलू सहायता बुक करें और अपनी पसंद की चीज़ों के लिए समय निकालें।',
            )}
          </p>
          <a className="button" href="#/book">
            {t('Find help for my home', 'मेरे घर के लिए मदद खोजें')}
            <Icon name="arrow" />
          </a>
          <p className="micro">
            <Icon name="pin" />
            {t(
              'Starting in Noida · Check your address for availability',
              'शुरुआत नोएडा से · अपने पते पर उपलब्धता जाँचें',
            )}
          </p>
        </div>
        <div className="hero-visual">
          <Room />
          <div className="floating floating-top">
            <span className="icon-circle">
              <Icon name="sparkle" />
            </span>
            <div>
              <strong>{t('Less on your list.', 'कामों की चिंता कम।')}</strong>
              <span>{t('More in your day.', 'दिन में ज़्यादा समय।')}</span>
            </div>
          </div>
          <div className="floating floating-bottom">
            <Icon name="home" />
            <div>
              <strong>{t('A happier kind of home.', 'सुकून भरा घर।')}</strong>
              <span>{t('One small tap away.', 'बस एक टैप दूर।')}</span>
            </div>
          </div>
          <span className="visual-caption">
            {t('MAKE ROOM FOR WHAT MATTERS', 'जो ज़रूरी है, उसके लिए समय निकालें')}
          </span>
        </div>
      </section>
      <section className="trust-strip" aria-label={t('Service features', 'सेवा की विशेषताएँ')}>
        {[
          ['shield', t('Identity checks before work', 'काम से पहले पहचान जाँच')],
          ['clock', t('Choose an available time', 'उपलब्ध समय चुनें')],
          ['check', t('See your price before booking', 'बुकिंग से पहले कीमत देखें')],
        ].map(([icon, label]) => (
          <div key={icon}>
            <Icon name={icon} />
            <span>{label}</span>
          </div>
        ))}
      </section>
      <section className="section services">
        <div className="section-heading">
          <div>
            <p className="eyebrow">{t('ONE LESS THING TO DO', 'एक चिंता कम')}</p>
            <h2>
              {t('Everyday help.', 'रोज़ की मदद।')}
              <br />
              <em>{t('Extraordinary relief.', 'सुकून का एहसास।')}</em>
            </h2>
          </div>
          <p>
            {t(
              'We’re starting with the everyday essentials. Explore the live service list for your neighbourhood after signing in.',
              'शुरुआत रोज़मर्रा की ज़रूरतों से। साइन इन करके अपने इलाके में उपलब्ध सेवाएँ देखें।',
            )}
          </p>
        </div>
        <div className="service-feature">
          <div className="service-art">
            <div className="art-sun" />
            <Icon name="home" />
            <span>60</span>
            <p>{t('minutes for your home', 'मिनट आपके घर के लिए')}</p>
          </div>
          <div className="service-copy">
            <span className="pill">{t('OUR FIRST SERVICE · HH60', 'हमारी पहली सेवा · HH60')}</span>
            <h3>{t('House help, by the hour.', 'एक घंटे की घरेलू सहायता।')}</h3>
            <p>
              {t(
                'A focused 60-minute visit to help with your home. Check the included tasks, choose your priorities, and review the full price before you book.',
                'घर के कामों में मदद के लिए 60 मिनट की सेवा। शामिल काम देखें, अपनी प्राथमिकताएँ चुनें और बुकिंग से पहले पूरी कीमत जानें।',
              )}
            </p>
            <div className="feature-points">
              <span>
                <Icon />
                {t('Tasks you can review', 'कामों का विवरण')}
              </span>
              <span>
                <Icon />
                {t('Available slots you can choose', 'उपलब्ध समय का चुनाव')}
              </span>
            </div>
            <a href="#/book" className="text-link">
              {t('Explore available services', 'उपलब्ध सेवाएँ देखें')}
              <Icon name="arrow" />
            </a>
          </div>
        </div>
      </section>
      <How />
      <section className="care-banner">
        <div className="care-symbol">
          <Icon name="shield" />
        </div>
        <div>
          <p className="eyebrow">{t('FEEL AT HOME WITH YOUR HELP', 'मदद के साथ सुकून')}</p>
          <h2>
            {t('Your peace of mind', 'आपका सुकून')}
            <br />
            <em>{t('comes first.', 'सबसे पहले।')}</em>
          </h2>
          <p>
            {t(
              'See your assigned professional’s name and worker code. Check their ID at the door, then share the service start code when you are ready.',
              'अपने सेवा सहयोगी का नाम और वर्कर कोड देखें। दरवाज़े पर पहचान जाँचें और तैयार होने पर ही सेवा शुरू करने का कोड दें।',
            )}
          </p>
          <a href="#/about" className="text-link">
            {t('Get to know One Tappe', 'One Tappe को जानें')}
            <Icon name="arrow" />
          </a>
        </div>
        <div className="care-note">
          <span>01</span>
          <p>
            {t(
              'Your address is shared with the assigned professional for the visit.',
              'सेवा के लिए आपका पता नियुक्त सहयोगी को दिया जाता है।',
            )}
          </p>
          <span>02</span>
          <p>
            {t(
              'A service start code helps you stay in control.',
              'सेवा शुरू करने का कोड आपके नियंत्रण में रहता है।',
            )}
          </p>
          <span>03</span>
          <p>
            {t('Raise a support request from your booking.', 'बुकिंग से सहायता का अनुरोध करें।')}
          </p>
        </div>
      </section>
      <Faq />
      <section className="closing">
        <p className="eyebrow">{t('YOUR DAY IS WAITING', 'आपका दिन आपका इंतज़ार कर रहा है')}</p>
        <h2>
          {t('Let’s take a little', 'घर के कामों की')}
          <br />
          <em>{t('off your plate.', 'चिंता कम करें।')}</em>
        </h2>
        <a className="button" href="#/book">
          {t('Find my home help', 'घरेलू सहायता खोजें')}
          <Icon name="arrow" />
        </a>
      </section>
    </>
  );
}
function How() {
  const { t } = useApp();
  return (
    <section className="section how">
      <p className="eyebrow">{t('SIMPLE FROM THE FIRST TAP', 'पहले टैप से आसान')}</p>
      <h2>
        {t('Your home. Your time.', 'आपका घर। आपका समय।')}
        <br />
        <em>{t('Three easy steps.', 'तीन आसान चरण।')}</em>
      </h2>
      <div className="steps">
        {[
          [
            t('Tell us where', 'अपना पता बताएँ'),
            t(
              'Sign in with your phone and check services at your address.',
              'फोन से साइन इन करें और अपने पते पर सेवाएँ जाँचें।',
            ),
            'pin',
          ],
          [
            t('Make it your visit', 'अपने अनुसार सेवा चुनें'),
            t(
              'Choose your service, tasks and an available time. Review the price.',
              'सेवा, काम और उपलब्ध समय चुनें। पूरी कीमत देखें।',
            ),
            'clock',
          ],
          [
            t('Get on with your day', 'अपने दिन का आनंद लें'),
            t(
              'Pay securely, follow your booking, and welcome your assigned professional.',
              'सुरक्षित भुगतान करें, बुकिंग देखें और नियुक्त सहयोगी का स्वागत करें।',
            ),
            'sparkle',
          ],
        ].map(([title, text, icon], i) => (
          <article key={title}>
            <div className="step-top">
              <span>0{i + 1}</span>
              <Icon name={icon} />
            </div>
            <h3>{title}</h3>
            <p>{text}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
function Faq() {
  const { t } = useApp();
  return (
    <section className="section faq">
      <div>
        <p className="eyebrow">{t('GOOD QUESTIONS', 'आपके सवाल')}</p>
        <h2>
          {t('A few things', 'कुछ बातें')}
          <br />
          <em>{t('you might ask.', 'जो आप जानना चाहेंगे।')}</em>
        </h2>
      </div>
      <div>
        {[
          [
            t('Is One Tappe available in my area?', 'क्या मेरे इलाके में One Tappe उपलब्ध है?'),
            t(
              'The pilot starts in Noida. Sign in and add your address to check the current service area. Availability is checked for your exact location.',
              'पायलट नोएडा से शुरू होता है। साइन इन करके पता जोड़ें। उपलब्धता आपके स्थान के अनुसार जाँची जाती है।',
            ),
          ],
          [
            t('How much does a visit cost?', 'सेवा की कीमत कितनी है?'),
            t(
              'Your quote comes from the current pricing rules for your address, service and time. You will see charges, discounts and taxes before creating a booking.',
              'कीमत आपके पते, सेवा और समय के अनुसार तय होती है। बुकिंग से पहले शुल्क, छूट और कर दिखाए जाते हैं।',
            ),
          ],
          [
            t('Can I book for later?', 'क्या मैं बाद के लिए बुक कर सकता हूँ?'),
            t(
              'Yes, when scheduled visits are enabled for your chosen service. Only currently available slots are shown; availability is checked again when you book.',
              'हाँ, यदि चुनी गई सेवा में निर्धारित समय की बुकिंग उपलब्ध है। बुक करते समय उपलब्धता फिर से जाँची जाती है।',
            ),
          ],
          [
            t('How do I get help with a booking?', 'बुकिंग में सहायता कैसे मिलेगी?'),
            t(
              'Open Help & support after signing in. Send your concern and follow the case status. For an emergency, call 112 immediately.',
              'साइन इन करके सहायता खोलें। अपनी समस्या भेजें और स्थिति देखें। आपातकाल में तुरंत 112 पर कॉल करें।',
            ),
          ],
        ].map(([q, a]) => (
          <details key={q}>
            <summary>
              {q}
              <span>+</span>
            </summary>
            <p>{a}</p>
          </details>
        ))}
      </div>
    </section>
  );
}
function About() {
  const { t } = useApp();
  return (
    <>
      <div className="workspace">
        <PageIntro
          eyebrow={t('ABOUT ONE TAPPE', 'ONE TAPPE के बारे में')}
          title={t('More time for your life.', 'अपनी ज़िंदगी के लिए ज़्यादा समय।')}
          text={t(
            'One Tappe connects everyday home needs with a clear, bookable service. We are starting with HH60 House Help in Noida and growing one carefully configured service area at a time.',
            'One Tappe घर की रोज़मर्रा की ज़रूरतों के लिए सेवाएँ बुक करना आसान बनाता है। शुरुआत नोएडा में HH60 घरेलू सहायता से हो रही है।',
          )}
        />
      </div>
      <How />
      <Faq />
    </>
  );
}
function Logout() {
  const { api, setProfile, t } = useApp();
  const action = useAction();
  return (
    <div>
      {action.error && <span role="alert">{action.error}</span>}
      <button
        className="text-link"
        disabled={action.busy}
        onClick={() => {
          action.run(async () => {
            await api.request('/auth/logout', 'POST');
            api.setTokens(null);
            setProfile(null);
          });
        }}
      >
        {t('Sign out', 'साइन आउट')}
      </button>
    </div>
  );
}
function Login() {
  const { api, locale, setProfile, t } = useApp();
  const action = useAction();
  const [challenge, setChallenge] = useState<{
    challengeId: string;
    phone: string;
    resendAvailableAt: string;
    expiresAt: string;
  } | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, []);
  return (
    <div className="auth-layout">
      <div>
        <PageIntro
          eyebrow={t('WELCOME TO ONE TAPPE', 'ONE TAPPE में स्वागत है')}
          title={t('Good help starts here.', 'अच्छी मदद की शुरुआत यहाँ से।')}
          text={t(
            'Your phone number is all you need. Sign in to check your address, explore services and manage your bookings.',
            'बस आपका फोन नंबर चाहिए। साइन इन करें, अपने पते पर सेवाएँ देखें और बुकिंग सँभालें।',
          )}
        />
        <div className="auth-art">
          <Room />
        </div>
      </div>
      <div className="panel auth-panel">
        <LegalLinks />
        <span className="icon-circle">
          <Icon name="phone" />
        </span>
        <h2>
          {challenge
            ? t('Check your messages.', 'अपने संदेश देखें।')
            : t('Let’s get you started.', 'शुरुआत करें।')}
        </h2>
        <p>
          {challenge
            ? t(
                `Enter the 6-digit code sent to ${challenge.phone}.`,
                `${challenge.phone} पर भेजा गया 6 अंकों का कोड डालें।`,
              )
            : t(
                'We’ll send you a one-time code by SMS.',
                'हम SMS से एक बार इस्तेमाल होने वाला कोड भेजेंगे।',
              )}
        </p>
        {action.error && <Notice error>{action.error}</Notice>}
        {challenge ? (
          <>
            <Form
              busy={action.busy}
              label={t('Verify & continue', 'सत्यापित करके आगे बढ़ें')}
              submit={(data) => {
                action.run(async () => {
                  const result = await api.request<Tokens>('/customer/auth/verify', 'POST', {
                    challengeId: challenge.challengeId,
                    phone: challenge.phone,
                    code: value(data, 'code'),
                  });
                  api.setTokens(result);
                  setProfile(await api.request<Profile>('/customer/me'));
                });
              }}
            >
              <Field label={t('Verification code', 'सत्यापन कोड')}>
                <input
                  name="code"
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  autoComplete="one-time-code"
                  required
                  autoFocus
                />
              </Field>
            </Form>
            <div className="row">
              <button
                className="text-link"
                disabled={action.busy}
                onClick={() => {
                  setChallenge(null);
                  action.setError('');
                }}
              >
                {t('Change number', 'नंबर बदलें')}
              </button>
              <button
                className="text-link"
                disabled={action.busy || now < Date.parse(challenge.resendAvailableAt)}
                onClick={() => {
                  action.run(async () => {
                    setChallenge(
                      await api.request('/customer/auth/otp', 'POST', {
                        phone: challenge.phone,
                        locale,
                      }),
                    );
                  });
                }}
              >
                {now < Date.parse(challenge.resendAvailableAt)
                  ? `${t('Resend in', 'दोबारा भेजें')} ${Math.ceil((Date.parse(challenge.resendAvailableAt) - now) / 1000)}s`
                  : t('Resend code', 'कोड फिर भेजें')}
              </button>
            </div>
          </>
        ) : (
          <Form
            busy={action.busy}
            label={t('Send verification code', 'सत्यापन कोड भेजें')}
            submit={(data) => {
              action.run(async () => {
                setChallenge(
                  await api.request('/customer/auth/otp', 'POST', {
                    phone: `+91${value(data, 'phone')}`,
                    locale,
                  }),
                );
              });
            }}
          >
            <Field label={t('Mobile number', 'मोबाइल नंबर')}>
              <div className="phone-input">
                <span>+91</span>
                <input
                  name="phone"
                  type="tel"
                  inputMode="tel"
                  pattern="[6-9][0-9]{9}"
                  maxLength={10}
                  placeholder="98765 43210"
                  autoComplete="tel-national"
                  required
                />
              </div>
            </Field>
          </Form>
        )}
        <p className="micro">
          {t(
            'Your login code is private. Never share it with a service professional.',
            'आपका लॉगिन कोड निजी है। इसे सेवा सहयोगी के साथ कभी साझा न करें।',
          )}
        </p>
      </div>
    </div>
  );
}
function Book() {
  const { api, locale, profile, setProfile, t } = useApp();
  const action = useAction();
  const [addresses, setAddresses] = useState<Address[]>([]);
  const [address, setAddress] = useState<Address | null>(null);
  const [adding, setAdding] = useState(false);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [service, setService] = useState<ServiceDetail | null>(null);
  const [optionId, setOptionId] = useState('');
  const [tasks, setTasks] = useState<string[]>([]);
  const [date, setDate] = useState(indiaDate());
  const [slots, setSlots] = useState<string[] | null>(null);
  const [startAt, setStartAt] = useState('');
  const [instant, setInstant] = useState(false);
  const [promo, setPromo] = useState('');
  const [notes, setNotes] = useState('');
  const [quote, setQuote] = useState<Quote | null>(null);
  const [coords, setCoords] = useState<{ lat: string; lng: string }>({ lat: '', lng: '' });
  const keys = useRef(new SubmissionKeys());
  const [initialError, setInitialError] = useState('');
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let active = true;
    void api
      .request<Address[]>('/customer/addresses')
      .then((rows) => {
        if (active) {
          setAddresses(rows);
          setAdding(rows.length === 0);
          setLoaded(true);
        }
      })
      .catch(() => {
        if (active)
          setInitialError(
            t(
              'Could not load addresses. Reload the page to retry.',
              'पते लोड नहीं हो सके। फिर कोशिश करने के लिए पेज रीफ्रेश करें।',
            ),
          );
      });
    return () => {
      active = false;
    };
  }, [api, t]);
  async function selectAddress(next: Address) {
    setAddress(next);
    setService(null);
    setCatalog(null);
    setQuote(null);
    setSlots(null);
    setAdding(false);
    const query = new URLSearchParams({
      pincode: next.pincode,
      lat: String(next.lat),
      lng: String(next.lng),
      locale,
    });
    setCatalog(await api.request<Catalog>(`/customer/catalog?${query.toString()}`));
  }
  async function selectService(next: Service) {
    const detail = await api.request<ServiceDetail>(
      `/customer/services/${next.id}?locale=${locale}`,
    );
    setService(detail);
    setOptionId(detail.options.find((o) => o.isDefault)?.id ?? detail.options[0]?.id ?? '');
    setTasks(detail.tasks.filter((task) => task.selectedByDefault).map((task) => task.id));
    setQuote(null);
    setSlots(null);
    setStartAt('');
    setInstant(!detail.supportsScheduled && detail.supportsInstant);
  }
  const requestBody = {
    serviceId: service?.id,
    serviceOptionId: optionId || null,
    addressId: address?.id,
    bookingType: instant ? 'INSTANT' : 'SCHEDULED',
    startAt: instant ? null : startAt,
    promoCode: promo || null,
  };
  return (
    <>
      <PageIntro
        eyebrow={t('BOOK A LITTLE BREATHING ROOM', 'सुकून के लिए बुक करें')}
        title={t('What can we help with?', 'हम किस काम में मदद करें?')}
        text={t(
          'Choose your address, make the visit yours, and review your price.',
          'पता चुनें, सेवा तय करें और कीमत देखें।',
        )}
      />
      <ol className="progress">
        <li className="active">1. {t('Your address', 'आपका पता')}</li>
        <li className={address ? 'active' : ''}>2. {t('Service & time', 'सेवा और समय')}</li>
        <li className={quote ? 'active' : ''}>3. {t('Review & book', 'जाँचें और बुक करें')}</li>
      </ol>
      {action.error && <Notice error>{action.error}</Notice>}
      {initialError && <Notice error>{initialError}</Notice>}
      {!loaded && !initialError && (
        <Notice>{t('Loading your addresses…', 'आपके पते लोड हो रहे हैं…')}</Notice>
      )}
      <div className="booking-layout">
        <div className="booking-main">
          <section className="panel">
            <div className="row">
              <h2>{t('Where do you need help?', 'मदद कहाँ चाहिए?')}</h2>
              {loaded && (
                <button
                  className="text-link"
                  disabled={action.busy}
                  onClick={() => {
                    setAdding(!adding);
                  }}
                >
                  {adding ? t('Close', 'बंद करें') : t('+ Add address', '+ पता जोड़ें')}
                </button>
              )}
            </div>
            <div className="address-list">
              {addresses.map((a) => (
                <button
                  className={`select-card ${address?.id === a.id ? 'selected' : ''}`}
                  key={a.id}
                  disabled={action.busy}
                  onClick={() => {
                    action.run(() => selectAddress(a));
                  }}
                >
                  <Icon name="pin" />
                  <span>
                    <strong>
                      {a.label} · {a.contactName}
                    </strong>
                    <small>
                      {[a.houseNumber, a.building, a.street, a.cityName, a.pincode]
                        .filter(Boolean)
                        .join(', ')}
                    </small>
                  </span>
                  {address?.id === a.id && <Icon />}
                </button>
              ))}
            </div>
            {adding && (
              <Form
                busy={action.busy}
                label={t('Save address & check services', 'पता सेव करें और सेवाएँ देखें')}
                submit={(data) => {
                  action.run(async () => {
                    const body = {
                      label: value(data, 'label') || 'Home',
                      contactName: value(data, 'name'),
                      contactPhone: value(data, 'phone'),
                      houseNumber: value(data, 'house'),
                      building: value(data, 'building'),
                      street: value(data, 'street'),
                      cityName: value(data, 'city'),
                      pincode: value(data, 'pincode'),
                      lat: Number(coords.lat),
                      lng: Number(coords.lng),
                      accessNotes: value(data, 'access'),
                    };
                    const next = await api.request<Address>(
                      '/customer/addresses',
                      'POST',
                      body,
                      keys.current.for('/addresses', body),
                    );
                    if (!profile?.fullName)
                      setProfile(
                        await api.request<Profile>('/customer/me', 'PATCH', {
                          fullName: body.contactName,
                          preferredLocale: locale,
                        }),
                      );
                    setAddresses(await api.request<Address[]>('/customer/addresses'));
                    await selectAddress(next);
                  });
                }}
              >
                <div className="form-grid">
                  <Field label={t('Contact name', 'संपर्क नाम')}>
                    <input
                      name="name"
                      required
                      maxLength={120}
                      defaultValue={profile?.fullName ?? ''}
                      autoComplete="name"
                    />
                  </Field>
                  <Field label={t('Contact phone (+91…)', 'संपर्क फोन (+91…)')}>
                    <input
                      name="phone"
                      type="tel"
                      required
                      pattern="\+[1-9][0-9]{7,14}"
                      defaultValue={profile?.phone}
                      autoComplete="tel"
                    />
                  </Field>
                  <Field label={t('House / flat number', 'मकान / फ्लैट नंबर')}>
                    <input name="house" required maxLength={60} autoComplete="address-line1" />
                  </Field>
                  <Field label={t('Building / society', 'इमारत / सोसाइटी')}>
                    <input name="building" maxLength={120} autoComplete="address-line2" />
                  </Field>
                  <Field label={t('Street / locality', 'सड़क / इलाका')}>
                    <input name="street" maxLength={160} />
                  </Field>
                  <Field label={t('City', 'शहर')}>
                    <input name="city" required maxLength={80} autoComplete="address-level2" />
                  </Field>
                  <Field label={t('Pincode', 'पिनकोड')}>
                    <input
                      name="pincode"
                      required
                      pattern="[1-9][0-9]{5}"
                      inputMode="numeric"
                      maxLength={6}
                      autoComplete="postal-code"
                    />
                  </Field>
                  <Field label={t('Address label', 'पते का नाम')}>
                    <input name="label" maxLength={40} placeholder={t('Home', 'घर')} />
                  </Field>
                </div>
                <p className="micro">
                  {t(
                    'Location helps us check your service zone. Use your current location only if you are at this address, or enter the address coordinates.',
                    'स्थान से सेवा क्षेत्र की जाँच होती है। यदि आप इसी पते पर हैं तो वर्तमान स्थान लें, या पते के निर्देशांक भरें।',
                  )}
                </p>
                <button
                  className="button secondary full"
                  type="button"
                  onClick={() => {
                    action.run(async () => {
                      const position = await new Promise<GeolocationPosition>((resolve, reject) => {
                        navigator.geolocation.getCurrentPosition(
                          resolve,
                          () => {
                            reject(
                              new Error(
                                t(
                                  'Location permission was not granted. You can enter coordinates below.',
                                  'स्थान की अनुमति नहीं मिली। नीचे निर्देशांक भर सकते हैं।',
                                ),
                              ),
                            );
                          },
                          { timeout: 10000, enableHighAccuracy: true },
                        );
                      });
                      setCoords({
                        lat: String(position.coords.latitude),
                        lng: String(position.coords.longitude),
                      });
                    });
                  }}
                >
                  <Icon name="pin" />
                  {t('Use my current location', 'मेरा वर्तमान स्थान लें')}
                </button>
                <div className="form-grid">
                  <Field label={t('Latitude', 'अक्षांश')}>
                    <input
                      type="number"
                      step="any"
                      min={-90}
                      max={90}
                      required
                      value={coords.lat}
                      onChange={(e) => {
                        setCoords({ ...coords, lat: e.target.value });
                      }}
                    />
                  </Field>
                  <Field label={t('Longitude', 'देशांतर')}>
                    <input
                      type="number"
                      step="any"
                      min={-180}
                      max={180}
                      required
                      value={coords.lng}
                      onChange={(e) => {
                        setCoords({ ...coords, lng: e.target.value });
                      }}
                    />
                  </Field>
                </div>
                <Field label={t('Access instructions (optional)', 'पहुंचने के निर्देश (वैकल्पिक)')}>
                  <textarea name="access" maxLength={500} rows={2} />
                </Field>
              </Form>
            )}
          </section>
          {address && !catalog && !action.busy && (
            <button
              className="button secondary"
              onClick={() => {
                action.run(() => selectAddress(address));
              }}
            >
              {t('Retry service check', 'सेवाएँ फिर जाँचें')}
            </button>
          )}
          {catalog && (
            <section className="panel">
              <h2>{t('Choose your service', 'अपनी सेवा चुनें')}</h2>
              {!catalog.serviceable ? (
                <Notice>
                  {t(
                    'We are not serving this location yet. Choose another address to check availability.',
                    'अभी इस स्थान पर सेवा उपलब्ध नहीं है। कोई दूसरा पता चुनें।',
                  )}
                </Notice>
              ) : catalog.categories.every((c) => c.services.length === 0) ? (
                <Notice>
                  {t(
                    'There are no bookable services here yet. Please check back later.',
                    'अभी यहाँ बुकिंग के लिए कोई सेवा उपलब्ध नहीं है। बाद में जाँचें।',
                  )}
                </Notice>
              ) : (
                catalog.categories.map((category) => (
                  <div key={category.id}>
                    <h3>{category.name}</h3>
                    {category.services.map((s) => (
                      <button
                        key={s.id}
                        className={`select-card ${service?.id === s.id ? 'selected' : ''}`}
                        disabled={action.busy}
                        onClick={() => {
                          action.run(() => selectService(s));
                        }}
                      >
                        <span className="icon-circle">
                          <Icon name="home" />
                        </span>
                        <span>
                          <strong>{s.name}</strong>
                          <small>
                            {s.durationMinutes} {t('minutes · From', 'मिनट · शुरुआती कीमत')}{' '}
                            {money(s.fromPricePaise, locale)}
                          </small>
                          <small>{s.description}</small>
                        </span>
                        <Icon name="arrow" />
                      </button>
                    ))}
                  </div>
                ))
              )}
            </section>
          )}
          {service && (
            <section className="panel">
              <h2>{t('Make the visit yours', 'सेवा अपनी ज़रूरत के अनुसार चुनें')}</h2>
              <fieldset disabled={action.busy || Boolean(quote)}>
                {service.options.length > 0 && (
                  <Field label={t('Service option', 'सेवा विकल्प')}>
                    <select
                      value={optionId}
                      onChange={(e) => {
                        setOptionId(e.target.value);
                        setSlots(null);
                        setStartAt('');
                      }}
                    >
                      {service.options.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.name} · {o.durationMinutes} {t('min', 'मिनट')}
                        </option>
                      ))}
                    </select>
                  </Field>
                )}
                {service.tasks.length > 0 && (
                  <>
                    <h3>{t('Your task priorities', 'कामों की प्राथमिकता')}</h3>
                    <p className="micro">
                      {t(
                        'Select tasks in priority order. Selected tasks are numbered; uncheck and reselect to move one later.',
                        'काम प्राथमिकता के क्रम में चुनें। क्रम बदलने के लिए हटाकर फिर चुनें।',
                      )}
                    </p>
                    <div className="tasks">
                      {service.tasks.map((task) => (
                        <label className="task" key={task.id}>
                          <input
                            type="checkbox"
                            checked={tasks.includes(task.id)}
                            onChange={(e) => {
                              setTasks(
                                e.target.checked
                                  ? [...tasks, task.id]
                                  : tasks.filter((id) => id !== task.id),
                              );
                            }}
                          />
                          <span>
                            {tasks.includes(task.id) ? `${tasks.indexOf(task.id) + 1}. ` : ''}
                            {task.name}
                            <small>{task.description}</small>
                          </span>
                        </label>
                      ))}
                    </div>
                  </>
                )}
                <h3>{t('When should we come?', 'हम कब आएँ?')}</h3>
                <div className="segmented">
                  {service.supportsScheduled && (
                    <button
                      type="button"
                      aria-pressed={!instant}
                      onClick={() => {
                        setInstant(false);
                      }}
                    >
                      {t('Schedule a visit', 'समय चुनें')}
                    </button>
                  )}
                  {service.supportsInstant && (
                    <button
                      type="button"
                      aria-pressed={instant}
                      onClick={() => {
                        setInstant(true);
                      }}
                    >
                      {t('Earliest available', 'सबसे जल्दी उपलब्ध')}
                    </button>
                  )}
                </div>
                {instant ? (
                  <p>
                    {t(
                      'Your estimated start time will appear in the quote. Availability is confirmed when you book.',
                      'अनुमानित समय कीमत के साथ दिखेगा। उपलब्धता की पुष्टि बुकिंग पर होगी।',
                    )}
                  </p>
                ) : (
                  <>
                    <Field label={t('Visit date (India time)', 'सेवा की तारीख (भारत का समय)')}>
                      <input
                        type="date"
                        min={indiaDate()}
                        value={date}
                        onChange={(e) => {
                          setDate(e.target.value);
                          setSlots(null);
                          setStartAt('');
                        }}
                        required
                      />
                    </Field>
                    <button
                      type="button"
                      className="button secondary"
                      disabled={!date}
                      onClick={() => {
                        action.run(async () => {
                          setStartAt('');
                          setSlots(null);
                          const params = new URLSearchParams({
                            serviceId: service.id,
                            addressId: address?.id ?? '',
                            date,
                            ...(optionId ? { serviceOptionId: optionId } : {}),
                          });
                          setSlots(
                            (
                              await api.request<{ slots: string[] }>(
                                `/customer/availability?${params.toString()}`,
                              )
                            ).slots,
                          );
                        });
                      }}
                    >
                      {t('Check available times', 'उपलब्ध समय जाँचें')}
                    </button>
                    {slots &&
                      (slots.length === 0 ? (
                        <Notice>
                          {t(
                            'No slots are available on this date. Try another day.',
                            'इस तारीख पर समय उपलब्ध नहीं है। दूसरी तारीख चुनें।',
                          )}
                        </Notice>
                      ) : (
                        <div className="slots">
                          {slots.map((slot) => (
                            <button
                              type="button"
                              className={startAt === slot ? 'selected' : ''}
                              aria-pressed={startAt === slot}
                              key={slot}
                              onClick={() => {
                                setStartAt(slot);
                              }}
                            >
                              {new Date(slot).toLocaleTimeString(
                                locale === 'hi' ? 'hi-IN' : 'en-IN',
                                { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit' },
                              )}
                            </button>
                          ))}
                        </div>
                      ))}
                  </>
                )}
                <Field label={t('Promo code (optional)', 'प्रोमो कोड (वैकल्पिक)')}>
                  <input
                    value={promo}
                    maxLength={30}
                    onChange={(e) => {
                      setPromo(e.target.value);
                    }}
                  />
                </Field>
                <Field label={t('Visit notes (optional)', 'सेवा के लिए नोट (वैकल्पिक)')}>
                  <textarea
                    value={notes}
                    maxLength={1000}
                    rows={3}
                    onChange={(e) => {
                      setNotes(e.target.value);
                    }}
                  />
                </Field>
                <button
                  className="button full"
                  disabled={!instant && !startAt}
                  onClick={() => {
                    action.run(async () => {
                      setQuote(await api.request<Quote>('/customer/quotes', 'POST', requestBody));
                    });
                  }}
                >
                  {t('Review my price', 'पूरी कीमत देखें')}
                  <Icon name="arrow" />
                </button>
              </fieldset>
            </section>
          )}
        </div>
        <aside className="panel booking-summary">
          <p className="eyebrow">{t('YOUR VISIT', 'आपकी सेवा')}</p>
          <h2>{service?.name ?? t('A little help awaits.', 'मदद आपका इंतज़ार कर रही है।')}</h2>
          {address && (
            <p>
              <Icon name="pin" />
              {address.houseNumber}, {address.cityName} {address.pincode}
            </p>
          )}
          {quote ? (
            <>
              <p>
                <Icon name="clock" />
                {dateTime(quote.startAt, locale)} IST
              </p>
              <Price quote={quote} />
              <p className="micro">
                {t(
                  'Creating a booking holds availability for a limited time. Your exact payment deadline appears next.',
                  'बुकिंग के बाद उपलब्धता सीमित समय तक रोकी जाती है। भुगतान की समय सीमा अगले पेज पर दिखेगी।',
                )}
              </p>
              <button
                className="button full"
                disabled={action.busy}
                onClick={() => {
                  action.run(async () => {
                    const body = {
                      ...requestBody,
                      taskIds: tasks,
                      notes: notes || null,
                      expectedTotalPaise: quote.totalPaise,
                    };
                    const booking = await api.request<Booking>(
                      '/customer/bookings',
                      'POST',
                      body,
                      keys.current.for('/bookings', body),
                    );
                    location.hash = `/bookings/${booking.id}`;
                  });
                }}
              >
                {t('Create booking', 'बुकिंग बनाएँ')}
                <Icon name="arrow" />
              </button>
              <button
                className="text-link full"
                disabled={action.busy}
                onClick={() => {
                  setQuote(null);
                }}
              >
                {t('Edit visit details', 'सेवा विवरण बदलें')}
              </button>
            </>
          ) : (
            <p>
              {t(
                'Your itemised quote will appear here once you select a service and time.',
                'सेवा और समय चुनने के बाद पूरी कीमत यहाँ दिखेगी।',
              )}
            </p>
          )}
          <div className="summary-footer">
            <Icon name="shield" />
            <span>
              {t('You review the price before you book.', 'बुकिंग से पहले पूरी कीमत देखें।')}
            </span>
          </div>
        </aside>
      </div>
    </>
  );
}
function Price({ quote }: { quote: Quote }) {
  const { locale, t } = useApp();
  return (
    <div className="price">
      {quote.lines.map((line, i) => (
        <div key={`${line.code}-${i}`}>
          <span>{line.label}</span>
          <span>{money(line.amountPaise, locale)}</span>
        </div>
      ))}
      <div className="price-total">
        <strong>{t('Total', 'कुल')}</strong>
        <strong>{money(quote.totalPaise, locale)}</strong>
      </div>
    </div>
  );
}
function Bookings() {
  const { api, locale, t } = useApp();
  const action = useAction();
  const { run } = action;
  const [rows, setRows] = useState<BookingSummary[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  useEffect(() => {
    run(async () => {
      const data = await api.request<{ items: BookingSummary[]; nextBefore: string | null }>(
        '/customer/bookings',
      );
      setRows(data.items);
      setNext(data.nextBefore);
    });
  }, [api, run]);
  return (
    <>
      <PageIntro
        eyebrow={t('YOUR ONE TAPPE', 'आपका ONE TAPPE')}
        title={t('Your visits, in one place.', 'आपकी सभी बुकिंग एक जगह।')}
      />
      {action.error && <Notice error>{action.error}</Notice>}
      <button
        className="text-link"
        disabled={action.busy}
        onClick={() => {
          action.run(async () => {
            const data = await api.request<{ items: BookingSummary[]; nextBefore: string | null }>(
              '/customer/bookings',
            );
            setRows(data.items);
            setNext(data.nextBefore);
          });
        }}
      >
        {t('Refresh bookings', 'बुकिंग रीफ्रेश करें')}
      </button>
      {action.busy && <Notice>{t('Loading bookings…', 'बुकिंग लोड हो रही हैं…')}</Notice>}
      {rows?.length === 0 && (
        <div className="empty">
          <Icon name="home" />
          <h2>{t('Your first visit starts here.', 'पहली सेवा यहाँ से बुक करें।')}</h2>
          <p>
            {t(
              'When you book a service, you can follow it here.',
              'सेवा बुक करने के बाद उसकी स्थिति यहाँ देखें।',
            )}
          </p>
          <a className="button" href="#/book">
            {t('Explore services', 'सेवाएँ देखें')}
            <Icon name="arrow" />
          </a>
        </div>
      )}
      <div className="booking-list">
        {rows?.map((b) => (
          <a className="panel booking-row" href={`#/bookings/${b.id}`} key={b.id}>
            <span className="icon-circle">
              <Icon name="home" />
            </span>
            <div>
              <small>{b.bookingCode}</small>
              <h3>{b.serviceName}</h3>
              <p>{dateTime(b.scheduledStart, locale)} IST</p>
            </div>
            <div>
              <span className="pill">{statusText(b.status, t)}</span>
              <strong>{money(b.totalPaise, locale)}</strong>
            </div>
            <Icon name="arrow" />
          </a>
        ))}
      </div>
      {next && (
        <button
          className="button secondary"
          disabled={action.busy}
          onClick={() => {
            action.run(async () => {
              const data = await api.request<{
                items: BookingSummary[];
                nextBefore: string | null;
              }>(`/customer/bookings?before=${encodeURIComponent(next)}`);
              setRows([...(rows ?? []), ...data.items]);
              setNext(data.nextBefore);
            });
          }}
        >
          {t('Load earlier bookings', 'पुरानी बुकिंग देखें')}
        </button>
      )}
    </>
  );
}
function statusText(status: string, t: Translate) {
  const labels: Record<string, [string, string]> = {
    OPEN: ['Open', 'खुला'],
    WAITING_ON_CUSTOMER: ['Waiting for your response', 'आपके जवाब का इंतज़ार'],
    RESOLVED: ['Resolved', 'हल हो गया'],
    PENDING_PAYMENT: ['Awaiting payment', 'भुगतान बाकी'],
    CONFIRMED: ['Finding your professional', 'सहयोगी की खोज जारी'],
    ASSIGNED: ['Professional assigned', 'सहयोगी नियुक्त'],
    EN_ROUTE: ['On the way', 'रास्ते में'],
    ARRIVED: ['Professional arrived', 'सहयोगी पहुँच गए'],
    IN_PROGRESS: ['Service in progress', 'सेवा जारी'],
    COMPLETED: ['Service completed', 'सेवा पूरी'],
    CLOSED: ['Completed', 'पूरी हुई'],
    CANCELLED: ['Cancelled', 'रद्द'],
    EXPIRED: ['Payment window expired', 'भुगतान का समय समाप्त'],
    ON_HOLD: ['On hold', 'रुकी हुई'],
    NO_SHOW: ['Visit not completed', 'सेवा पूरी नहीं हुई'],
  };
  const label = labels[status];
  return label ? t(...label) : status.replaceAll('_', ' ');
}
function BookingPage({ id }: { id: string }) {
  const { api, locale, t } = useApp();
  const action = useAction();
  const { setError } = action;
  const [booking, setBooking] = useState<Booking | null>(null);
  const [timeline, setTimeline] = useState<{ to: string; at: string }[]>([]);
  const [startCode, setStartCode] = useState('');
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [mode, setMode] = useState<'cancel' | 'reschedule' | 'rate' | null>(null);
  const [message, setMessage] = useState('');
  const refresh = async () => {
    const next = await api.request<Booking>(`/customer/bookings/${id}`);
    setBooking(next);
    if (!next.actions.canViewStartCode) setStartCode('');
    setTimeline(
      (
        await api.request<{ statuses: { to: string; at: string }[] }>(
          `/customer/bookings/${id}/timeline`,
        )
      ).statuses,
    );
  };
  useEffect(() => {
    let active = true;
    let fetching = false;
    const poll = async () => {
      if (fetching || document.hidden) return;
      fetching = true;
      try {
        const next = await api.request<Booking>(`/customer/bookings/${id}`);
        const history = await api.request<{ statuses: { to: string; at: string }[] }>(
          `/customer/bookings/${id}/timeline`,
        );
        if (active) {
          setBooking(next);
          setTimeline(history.statuses);
          if (!next.actions.canViewStartCode) setStartCode('');
        }
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : 'Unable to refresh booking.');
      } finally {
        fetching = false;
      }
    };
    void poll();
    const timer = setInterval(() => {
      void poll();
    }, 15000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [api, id, setError]);
  return (
    <>
      <a className="text-link" href="#/bookings">
        ← {t('All bookings', 'सभी बुकिंग')}
      </a>
      <PageIntro
        eyebrow={booking?.bookingCode ?? t('YOUR BOOKING', 'आपकी बुकिंग')}
        title={booking?.service.name ?? t('Loading your visit…', 'सेवा लोड हो रही है…')}
      />
      {action.error && <Notice error>{action.error}</Notice>}
      {message && <Notice>{message}</Notice>}
      <button
        className="text-link"
        disabled={action.busy}
        onClick={() => {
          action.run(refresh);
        }}
      >
        {t('Refresh status', 'स्थिति रीफ्रेश करें')}
      </button>
      {booking && (
        <div className="booking-layout">
          <div className="booking-main">
            <section className="panel">
              <span className="pill">{statusText(booking.status, t)}</span>
              <h2>{dateTime(booking.schedule.current.start, locale)} IST</h2>
              {booking.schedule.rescheduleCount > 0 && (
                <p>
                  {t('Originally scheduled:', 'मूल समय:')}{' '}
                  {dateTime(booking.schedule.original.start, locale)} IST
                </p>
              )}
              <p>
                {t('Payment status:', 'भुगतान की स्थिति:')}{' '}
                {booking.payment.status === 'PAID'
                  ? t('Paid', 'भुगतान हो गया')
                  : booking.payment.status === 'UNPAID'
                    ? t('Unpaid', 'भुगतान बाकी')
                    : t('Pay after service', 'सेवा के बाद भुगतान')}
              </p>
              {booking.worker && (
                <div className="professional">
                  <span className="icon-circle">
                    <Icon name="shield" />
                  </span>
                  <div>
                    <strong>
                      {booking.worker.firstName} · {booking.worker.workerCode}
                    </strong>
                    <p>
                      {t(
                        'Check the worker code and identity at your door.',
                        'दरवाज़े पर वर्कर कोड और पहचान जाँचें।',
                      )}
                    </p>
                  </div>
                </div>
              )}
              {booking.actions.canViewStartCode && (
                <div className="start-code">
                  <p>
                    {t(
                      'Share this service code only after checking the professional’s ID. This is not a payment OTP.',
                      'पहचान जाँचने के बाद ही सेवा कोड दें। यह भुगतान का OTP नहीं है।',
                    )}
                  </p>
                  {startCode ? (
                    <strong className="code">{startCode}</strong>
                  ) : (
                    <button
                      className="button secondary"
                      disabled={action.busy}
                      onClick={() => {
                        action.run(async () => {
                          setStartCode(
                            (
                              await api.request<{ code: string }>(
                                `/customer/bookings/${id}/start-code`,
                              )
                            ).code,
                          );
                        });
                      }}
                    >
                      {t('Show service start code', 'सेवा शुरू करने का कोड देखें')}
                    </button>
                  )}
                </div>
              )}
              {booking.actions.canPay && (
                <>
                  <p>
                    {t('Complete payment by', 'इस समय तक भुगतान करें')}{' '}
                    {booking.payment.payBy ? dateTime(booking.payment.payBy, locale) : '—'} IST
                  </p>
                  <button
                    className="button full"
                    disabled={action.busy}
                    onClick={() => {
                      action.run(async () => {
                        const payment = await api.request<Payment>(
                          `/customer/bookings/${id}/payments`,
                          'POST',
                        );
                        await checkout(payment);
                        const result = await api.request<{ booking: Booking }>(
                          `/customer/bookings/${id}/payments/${payment.paymentId}/refresh`,
                          'POST',
                        );
                        setBooking(result.booking);
                        setMessage(
                          result.booking.payment.status === 'PAID'
                            ? t(
                                'Payment verified. Follow your visit here.',
                                'भुगतान सत्यापित हो गया। सेवा की स्थिति यहाँ देखें।',
                              )
                            : t(
                                'Payment is not confirmed yet. Refresh the status before trying again.',
                                'अभी भुगतान की पुष्टि नहीं हुई है। दोबारा कोशिश करने से पहले स्थिति रीफ्रेश करें।',
                              ),
                        );
                      });
                    }}
                  >
                    {t('Pay securely', 'सुरक्षित भुगतान करें')}{' '}
                    {money(booking.price.totalPaise, locale)}
                    <Icon name="arrow" />
                  </button>
                </>
              )}
              <div className="action-row">
                {booking.actions.canCancel && (
                  <button
                    className="text-link"
                    onClick={() => {
                      setMode(mode === 'cancel' ? null : 'cancel');
                    }}
                  >
                    {t('Cancel visit', 'सेवा रद्द करें')}
                  </button>
                )}
                {booking.actions.canReschedule && (
                  <button
                    className="text-link"
                    onClick={() => {
                      setMode(mode === 'reschedule' ? null : 'reschedule');
                    }}
                  >
                    {t('Reschedule', 'समय बदलें')}
                  </button>
                )}
                {booking.actions.canRate && (
                  <button
                    className="text-link"
                    onClick={() => {
                      setMode('rate');
                    }}
                  >
                    {t('Rate your visit', 'सेवा को रेट करें')}
                  </button>
                )}
                <a className="text-link" href="#/help">
                  {t('Get help', 'सहायता लें')}
                </a>
              </div>
              {mode === 'cancel' && booking.actions.canCancel && (
                <Form
                  busy={action.busy}
                  label={t('Confirm cancellation', 'रद्द करने की पुष्टि करें')}
                  submit={(data) => {
                    action.run(async () => {
                      const result = await api.request<{ booking: Booking }>(
                        `/customer/bookings/${id}/cancel`,
                        'POST',
                        { reason: value(data, 'reason') },
                      );
                      setBooking(result.booking);
                      setMode(null);
                      setMessage(
                        t(
                          'The visit is cancelled. Any refund follows the applicable cancellation policy. Contact support for the refund amount or progress.',
                          'सेवा रद्द हो गई। रिफंड लागू नीति के अनुसार होगा। राशि या स्थिति के लिए सहायता से संपर्क करें।',
                        ),
                      );
                      await refresh();
                    });
                  }}
                >
                  <Notice>
                    {t(
                      'This cancels your visit. The API does not provide a fee preview. If you need the exact refund amount before cancelling, ask support first.',
                      'इससे सेवा रद्द हो जाएगी। अभी शुल्क का पूर्वावलोकन उपलब्ध नहीं है। पहले सही रिफंड राशि जानने के लिए सहायता से संपर्क करें।',
                    )}
                  </Notice>
                  <Field label={t('Cancellation reason', 'रद्द करने का कारण')}>
                    <textarea name="reason" required maxLength={500} />
                  </Field>
                </Form>
              )}
              {mode === 'reschedule' && booking.actions.canReschedule && (
                <Form
                  busy={action.busy}
                  label={t('Request new time', 'नया समय अनुरोध करें')}
                  submit={(data) => {
                    action.run(async () => {
                      const iso = new Date(`${value(data, 'start')}+05:30`).toISOString();
                      setBooking(
                        await api.request<Booking>(`/customer/bookings/${id}/reschedule`, 'POST', {
                          startAt: iso,
                          reason: value(data, 'reason'),
                        }),
                      );
                      setMode(null);
                      await refresh();
                    });
                  }}
                >
                  <p>
                    {t(
                      'Enter a time in India. The server checks availability; if unavailable, your current booking stays in place.',
                      'भारत के समय में चुनें। उपलब्धता की जाँच होगी; समय उपलब्ध न होने पर मौजूदा बुकिंग बनी रहेगी।',
                    )}
                  </p>
                  <Field label={t('New date & time (IST)', 'नई तारीख और समय (IST)')}>
                    <input name="start" type="datetime-local" required step={900} />
                  </Field>
                  <Field label={t('Reason for change', 'बदलाव का कारण')}>
                    <textarea name="reason" required maxLength={500} />
                  </Field>
                </Form>
              )}
              {mode === 'rate' && booking.actions.canRate && (
                <Form
                  busy={action.busy}
                  label={t('Submit rating', 'रेटिंग भेजें')}
                  submit={(data) => {
                    action.run(async () => {
                      await api.request(`/customer/bookings/${id}/rating`, 'POST', {
                        score: Number(value(data, 'score')),
                        comment: value(data, 'comment') || null,
                      });
                      setMode(null);
                      setMessage(
                        t(
                          'Thank you for sharing your experience.',
                          'अपना अनुभव साझा करने के लिए धन्यवाद।',
                        ),
                      );
                      await refresh();
                    });
                  }}
                >
                  <Field label={t('Rating', 'रेटिंग')}>
                    <select name="score" defaultValue="5">
                      {[5, 4, 3, 2, 1].map((n) => (
                        <option key={n} value={n}>
                          {n} / 5
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label={t('Your feedback (optional)', 'आपका अनुभव (वैकल्पिक)')}>
                    <textarea name="comment" maxLength={2000} />
                  </Field>
                </Form>
              )}
            </section>
            <section className="panel">
              <h2>{t('Visit updates', 'सेवा के अपडेट')}</h2>
              <p className="micro">
                {t(
                  'Refreshes every 15 seconds while this page is visible.',
                  'यह पेज खुला रहने पर हर 15 सेकंड में रीफ्रेश होता है।',
                )}
              </p>
              <ol className="timeline">
                {timeline.map((event, i) => (
                  <li key={`${event.at}-${i}`}>
                    <strong>{statusText(event.to, t)}</strong>
                    <time>{dateTime(event.at, locale)} IST</time>
                  </li>
                ))}
              </ol>
            </section>
          </div>
          <aside className="panel booking-summary">
            <h2>{t('Your price', 'आपकी कीमत')}</h2>
            <Price quote={booking.price} />
            {booking.tasks.length > 0 && (
              <>
                <h3>{t('Selected tasks', 'चुने हुए काम')}</h3>
                <ol>
                  {booking.tasks.map((task) => (
                    <li key={task.priority}>{task.name}</li>
                  ))}
                </ol>
              </>
            )}
            {['COMPLETED', 'CLOSED'].includes(booking.status) && (
              <button
                className="button secondary full"
                disabled={action.busy}
                onClick={() => {
                  action.run(async () => {
                    setInvoice(await api.request<Invoice>(`/customer/bookings/${id}/invoice`));
                  });
                }}
              >
                {t('View invoice', 'इनवॉइस देखें')}
              </button>
            )}
          </aside>
        </div>
      )}
      {invoice && (
        <section className="panel invoice">
          <h2>
            {t('Invoice', 'इनवॉइस')} {invoice.invoiceNumber}
          </h2>
          <p>
            {invoice.issuer.legalName} · {invoice.issuer.gstin ?? ''}
          </p>
          <p>{readable(invoice.issuer.address)}</p>
          <p>
            {t('Billed to', 'बिल प्राप्तकर्ता')}: {invoice.billedTo.name} ·{' '}
            {readable(invoice.billedTo.address)}
          </p>
          <p>{dateTime(invoice.issuedAt, locale)}</p>
          <div className="price">
            {invoice.lines.map((line, i) => (
              <div key={`${line.code}-${i}`}>
                <span>{line.label}</span>
                <span>{money(line.amountPaise, locale)}</span>
              </div>
            ))}
          </div>
          <dl>
            <dt>{t('Subtotal', 'उपयोग राशि')}</dt>
            <dd>{money(invoice.subtotalPaise, locale)}</dd>
            <dt>{t('Discount', 'छूट')}</dt>
            <dd>{money(invoice.discountPaise, locale)}</dd>
            <dt>{t('Tax', 'कर')}</dt>
            <dd>{money(invoice.taxPaise, locale)}</dd>
            <dt>{t('Total', 'कुल')}</dt>
            <dd>{money(invoice.totalPaise, locale)}</dd>
          </dl>
          <button
            className="button secondary"
            onClick={() => {
              window.print();
            }}
          >
            {t('Print invoice', 'इनवॉइस प्रिंट करें')}
          </button>
        </section>
      )}
    </>
  );
}
function readable(data: unknown): string {
  if (typeof data === 'string') return data;
  if (!data || typeof data !== 'object') return '';
  return Object.values(data)
    .filter((v): v is string => typeof v === 'string')
    .join(', ');
}
function Help() {
  const { api, t } = useApp();
  const action = useAction();
  const { run } = action;
  const [cases, setCases] = useState<SupportCase[] | null>(null);
  const [bookings, setBookings] = useState<BookingSummary[]>([]);
  const [sent, setSent] = useState('');
  const keys = useRef(new SubmissionKeys());
  useEffect(() => {
    run(async () => {
      const [list, visits] = await Promise.all([
        api.request<SupportCase[]>('/customer/support-cases'),
        api.request<{ items: BookingSummary[] }>('/customer/bookings?limit=50'),
      ]);
      setCases(list);
      setBookings(visits.items);
    });
  }, [api, run]);
  return (
    <>
      <PageIntro
        eyebrow={t('WE’RE HERE TO HELP', 'हम आपकी मदद के लिए हैं')}
        title={t('Let’s make it right.', 'आइए इसे ठीक करें।')}
        text={t(
          'Tell us what happened and what would help. Your request goes to the support team.',
          'हमें समस्या और अपनी अपेक्षा बताएँ। आपका अनुरोध सहायता टीम को जाएगा।',
        )}
      />
      <a className="emergency banner" href="tel:112">
        <Icon name="phone" />
        {t('In immediate danger? Call 112 now.', 'तुरंत खतरा है? अभी 112 पर कॉल करें।')}
      </a>
      {action.error && <Notice error>{action.error}</Notice>}
      {sent && <Notice>{sent}</Notice>}
      <div className="booking-layout">
        <section className="panel">
          <h2>{t('Send a support request', 'सहायता का अनुरोध भेजें')}</h2>
          <Form
            busy={action.busy}
            label={t('Send request', 'अनुरोध भेजें')}
            submit={(data) => {
              action.run(async () => {
                const body = {
                  bookingId: value(data, 'booking') || null,
                  category: value(data, 'category'),
                  subject: value(data, 'subject'),
                  description: value(data, 'description'),
                  desiredResolution: value(data, 'resolution') || null,
                };
                const result = await api.request<SupportCase>(
                  '/customer/support-cases',
                  'POST',
                  body,
                  keys.current.for('/support-cases', body),
                );
                setSent(
                  t(
                    `Request sent${result.caseCode ? `: ${result.caseCode}` : ''}. Track it below.`,
                    `अनुरोध भेज दिया गया${result.caseCode ? `: ${result.caseCode}` : ''}। स्थिति नीचे देखें।`,
                  ),
                );
                setCases(await api.request<SupportCase[]>('/customer/support-cases'));
              });
            }}
          >
            <Field label={t('Related booking (optional)', 'संबंधित बुकिंग (वैकल्पिक)')}>
              <select name="booking">
                <option value="">{t('General question', 'सामान्य सवाल')}</option>
                {bookings.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.bookingCode} · {b.serviceName}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('What is this about?', 'समस्या किससे संबंधित है?')}>
              <select name="category">
                {[
                  ['SERVICE_QUALITY', t('Service quality', 'सेवा की गुणवत्ता')],
                  ['LATE_ARRIVAL', t('Late arrival', 'देर से पहुँचना')],
                  ['NO_SHOW', t('Professional did not arrive', 'सहयोगी नहीं पहुँचे')],
                  ['BILLING', t('Billing or payment', 'बिल या भुगतान')],
                  ['REFUND', t('Refund', 'रिफंड')],
                  ['DAMAGE', t('Damage', 'नुकसान')],
                  ['BEHAVIOUR', t('Behaviour', 'व्यवहार')],
                  ['APP_ISSUE', t('Website issue', 'वेबसाइट की समस्या')],
                  ['OTHER', t('Other', 'अन्य')],
                ].map(([code, name]) => (
                  <option key={code} value={code}>
                    {name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('Subject', 'विषय')}>
              <input name="subject" required maxLength={200} />
            </Field>
            <Field label={t('What happened?', 'क्या हुआ?')}>
              <textarea name="description" required rows={5} maxLength={5000} />
            </Field>
            <Field label={t('How can we help? (optional)', 'हम कैसे मदद कर सकते हैं? (वैकल्पिक)')}>
              <textarea name="resolution" rows={2} maxLength={1000} />
            </Field>
          </Form>
        </section>
        <section className="panel booking-summary">
          <h2>{t('Your requests', 'आपके अनुरोध')}</h2>
          <button
            className="text-link"
            disabled={action.busy}
            onClick={() => {
              action.run(async () => {
                setCases(await api.request<SupportCase[]>('/customer/support-cases'));
              });
            }}
          >
            {t('Refresh requests', 'अनुरोध रीफ्रेश करें')}
          </button>
          {cases?.length === 0 && (
            <p>
              {t(
                'No requests yet. We’re here when you need us.',
                'अभी कोई अनुरोध नहीं। ज़रूरत होने पर हम यहाँ हैं।',
              )}
            </p>
          )}
          {cases?.map((c) => (
            <article className="case" key={c.id}>
              <small>{c.caseCode}</small>
              <h3>{c.subject}</h3>
              <span className="pill">{statusText(c.status, t)}</span>
              {c.resolution && <p>{c.resolution}</p>}
            </article>
          ))}
        </section>
      </div>
    </>
  );
}
interface LegalDocument {
  id: string;
  title: string;
  version: string;
  url: string;
  accepted?: boolean;
}
interface ConsentStatus {
  allAccepted: boolean;
  required: LegalDocument[];
}
function LegalLinks() {
  const { api, locale, t } = useApp();
  const [docs, setDocs] = useState<LegalDocument[]>([]);
  const [problem, setProblem] = useState(false);
  useEffect(() => {
    let active = true;
    void api
      .request<LegalDocument[]>(`/legal/documents?app=CUSTOMER_APP&locale=${locale}`)
      .then((result) => {
        if (active) {
          setDocs(result);
          setProblem(false);
        }
      })
      .catch(() => {
        if (active) setProblem(true);
      });
    return () => {
      active = false;
    };
  }, [api, locale]);
  return (
    <div className="legal-links">
      {problem && (
        <p>
          {t(
            'Policy documents could not be loaded. Please refresh to retry.',
            'नीति दस्तावेज़ लोड नहीं हुए। फिर कोशिश करने के लिए रीफ्रेश करें।',
          )}
        </p>
      )}
      {docs.map((doc) => (
        <a
          className="text-link"
          key={doc.id}
          href={doc.url.startsWith('https://') ? doc.url : undefined}
          target="_blank"
          rel="noopener noreferrer"
        >
          {doc.title} · {doc.version} ↗
        </a>
      ))}
    </div>
  );
}
function ConsentGate({ children }: { children: ReactNode }) {
  const { api, locale, t } = useApp();
  const action = useAction();
  const { run } = action;
  const [status, setStatus] = useState<ConsentStatus | null>(null);
  const [checked, setChecked] = useState(false);
  const loadStatus = useCallback(async () => {
    setChecked(false);
    setStatus(await api.request<ConsentStatus>(`/me/consents?locale=${locale}`));
  }, [api, locale]);
  useEffect(() => {
    run(loadStatus);
  }, [loadStatus, run]);
  if (status?.allAccepted) return children;
  return (
    <section className="panel">
      <PageIntro
        eyebrow={t('BEFORE YOUR FIRST BOOKING', 'बुकिंग से पहले')}
        title={t('Review your terms and choices.', 'नियम और जानकारी पढ़ें।')}
        text={t(
          'Please read the current terms, privacy notice and cancellation policy. Acceptance is your choice and is required before booking.',
          'मौजूदा नियम, गोपनीयता जानकारी और रद्द करने की नीति पढ़ें। बुकिंग से पहले आपकी स्वीकृति आवश्यक है।',
        )}
      />
      {action.error && <Notice error>{action.error}</Notice>}
      {!status ? (
        <button
          className="button secondary"
          disabled={action.busy}
          onClick={() => {
            run(loadStatus);
          }}
        >
          {t('Load current policies', 'मौजूदा नीतियाँ लोड करें')}
        </button>
      ) : (
        <>
          {status.required.map((doc) => (
            <p key={doc.id}>
              <a
                className="text-link"
                href={doc.url.startsWith('https://') ? doc.url : undefined}
                target="_blank"
                rel="noopener noreferrer"
              >
                {doc.title} · {doc.version} ↗
              </a>
              {doc.accepted && <Icon />}
            </p>
          ))}
          <label className="task">
            <input
              type="checkbox"
              checked={checked}
              disabled={action.busy}
              onChange={(event) => {
                setChecked(event.target.checked);
              }}
            />
            <span>
              {t(
                'I have read and accept the documents shown above.',
                'मैंने ऊपर दिए गए दस्तावेज़ पढ़े हैं और स्वीकार करता/करती हूँ।',
              )}
            </span>
          </label>
          <button
            className="button"
            disabled={!checked || action.busy}
            onClick={() => {
              run(async () => {
                const body = {
                  documentIds: status.required.filter((doc) => !doc.accepted).map((doc) => doc.id),
                };
                await api.request('/me/consents/accept', 'POST', body);
                await loadStatus();
              });
            }}
          >
            {t('Accept & continue', 'स्वीकार करके आगे बढ़ें')}
          </button>
        </>
      )}
    </section>
  );
}
const root = document.getElementById('root');
if (root) createRoot(root).render(<App />);
