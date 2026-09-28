# One Tappe customer website

The customer website is in `apps/web`. It uses React, TypeScript and Vite and calls the
existing NestJS API. This contribution changes no API controllers, database migrations,
booking rules, pricing rules, worker eligibility rules, or payment verification logic.

## Repository review

Reviewed at base commit `fc2912c3dfddc1aed061e6b6795141597315a831`.
The implementation follows the controllers and response serializers where older planning
documents differ from the code.

| Area                 | Current implementation                                                                              |
| -------------------- | --------------------------------------------------------------------------------------------------- |
| Backend              | NestJS / Fastify, versioned `/api/v1` routes                                                        |
| Database             | PostgreSQL, SQL migrations, typed Kysely queries                                                    |
| Shared rules         | `packages/domain`: state machine, pricing, capacity, money and time                                 |
| Customer identity    | Phone OTP, bearer access token, rotating refresh token                                              |
| Other clients        | Existing Expo customer and worker apps, Next.js admin, shared API client and mobile kit             |
| Worker identity      | Separate worker app and verification / training lifecycle                                           |
| Staff                | Password + TOTP, permission and city scope checks, PII masking                                      |
| Discovery            | Customer-authenticated catalogue and serviceability; location-filtered services                     |
| Booking              | Database rechecks capacity and price; idempotent creation                                           |
| Payment              | API-created Razorpay checkout, server-verified payment status                                       |
| Operations           | Separate worker process for expiry, dispatch, payment reconciliation and notifications              |
| Integrations         | MSG91 OTP, Razorpay, notification adapters, Zoho outbox / support synchronization, document storage |
| Configuration        | Admin APIs configure service areas, services, prices, promotions and operating hours                |
| Current launch scope | Noida, HH60 House Help, English and Hindi; live areas and services come from the API                |

## Included customer journeys

- Public homepage, service introduction, how it works, FAQs and help navigation.
- English / Hindi website copy, accessible form labels, visible keyboard focus, mobile menu.
- OTP sign-in, resend cooldown, profile completion when saving a first address, sign-out.
- Published legal-document links before sign-in and explicit versioned consent before booking.
- Address creation and selection, user-initiated geolocation or manual coordinates.
- Live location-filtered catalogue, service options, task priorities, instant or scheduled visits.
- Available slot picker, optional promotion and notes, itemised quote, booking creation.
- Razorpay checkout using the order created by the API, then a server-side payment refresh.
- Booking list with pagination, status polling every 15 seconds while visible, timeline,
  original/current schedule, professional identity, start code, cancellation, rescheduling,
  rating, invoice summary and printing.
- Support request creation and case list. Emergency telephone link on every page.

The public HH60 description is introductory. Actual task lists, durations, prices,
availability and services are loaded from the authenticated API. No sample bookings,
prices, ratings or fake success responses ship in the application.

## Run locally

Use the repository's Node and pnpm versions. From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm build
# Start PostgreSQL, configure apps/api/.env, apply migrations as described in README.md.
pnpm --filter @onetappe/api start
pnpm --filter @onetappe/api start:worker
# In another terminal:
pnpm --filter @onetappe/web dev
```

Open `http://localhost:5173`. Vite proxies `/api/v1` to `http://127.0.0.1:3000`,
so development does not require changing backend CORS settings. Set `API_PROXY_TARGET`
when the local API runs elsewhere. The dev server is not a production server.

Use configured services, prices, zones and eligible workers in a development database.
Migrations alone do not create a complete commercial catalogue or worker availability.
The console OTP provider prints codes in the local API logs; no test OTP bypass exists
in the website. Sandbox payments display an explicit environment message and never
claim to have charged money. Exercise the signed sandbox gateway through the existing
backend test tools, or use a staging API with Razorpay test credentials.

## Build and deploy on an existing server

```bash
pnpm --filter @onetappe/web build
```

Serve `apps/web/dist` as static files over HTTPS. Prefer the same public origin for
website and API. Forward `/api/v1/` to the existing NestJS API without rewriting that
prefix. Example Nginx location blocks inside the existing HTTPS server configuration:

```nginx
root /var/www/onetappe-web;
index index.html;

location / {
    try_files $uri $uri/ /index.html;
}

location /api/v1/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    add_header Cache-Control "no-store" always;
}
```

Adapt trusted-proxy headers if another trusted load balancer sits in front of Nginx.
Restrict the backend port to the trusted proxy. Do not expose database ports or secrets.
Geolocation requires HTTPS except on localhost. Hash-based application routes work with
static hosting and do not require a frontend application server.

For a separately hosted API, build with `VITE_API_BASE_URL=https://api.example.com/api/v1`
and add the exact website origin to the existing API's `CORS_ORIGINS`. The value is public,
compiled into the browser bundle. **Never put a secret in a `VITE_` variable.**

Razorpay's checkout script loads only after the customer presses the payment button.
Allow its official script, frame and connection endpoints in a deployment CSP, following
the gateway's current integration guidance. The theme uses Google Fonts with local system
font fallbacks; self-host the font files if the deployment must avoid third-party font requests.

## Session, money and retry behavior

Tokens are kept only in memory: refreshing or closing the page requires signing in again.
No refresh token, phone, address, start code or booking data is written to browser storage.
The client shares one in-flight refresh request across callers and clears the session on
refresh failure. This is a deliberate first release tradeoff; persistent sign-in would
benefit from a separately designed HttpOnly cookie / BFF flow.

Money is displayed from integer paise. The exact quoted total is sent back as
`expectedTotalPaise`; the server can reject a stale price. Checkout success in the browser
never marks a booking paid. The API refresh/webhook response remains authoritative.

Address, booking and support submissions retain an idempotency key for the same payload
within the mounted form. A lost network response is not automatically retried. Submitting
the unchanged form again reuses its key. Changing the payload produces a new key. If the
page was reloaded after an uncertain booking response, check My bookings before creating
another visit. Backend validation remains the final authority.

## Boundaries and launch inputs

- This is a customer website, not a worker app or staff administration panel.
- A working API URL, configured catalogue/areas/prices/workers, SMS configuration and
  Razorpay account are necessary for live bookings. None were supplied as production
  credentials in this contribution; the site has not been deployed or connected to a live account.
- Final brand assets and legal terms/privacy/consent text are still open items in
  `03-inputs-needed.md`. The wordmark and green/cream design are an initial implementation.
  Publish approved document versions through the existing legal APIs before launch. The website displays these before sign-in and records explicit acceptance before booking.
- The backend provides no cancellation-fee preview or customer refund-status read endpoint.
  The cancellation screen explains this and directs customers to support for an exact
  refund quote before proceeding. It does not promise a refund amount or settlement date.
- Rescheduling submits a requested India-time slot and lets the backend validate it;
  it does not show a separate rescheduling availability calendar.
- The current invoice endpoint returns JSON, not a PDF. The website displays its issuer,
  customer, invoice number and totals with browser printing; statutory invoice presentation
  should be finalized with the approved business details before launch.
- This website uses device coordinates with browser permission or manual coordinate entry.
  It does not yet reuse the native customer app’s map picker or infer coordinates from a pincode.
- No waitlist, careers submission, WhatsApp number, service ETA guarantee or additional
  sellable services have been invented where the current backend/configuration lacks them.
- Website copy is bilingual; free-text catalogue descriptions and server error messages
  depend on the backend's available translations.

## Validation

```bash
pnpm --filter @onetappe/web typecheck
pnpm --filter @onetappe/web build
pnpm --filter @onetappe/web test
pnpm lint
pnpm format:check
```

The client tests cover concurrent refresh rotation, expired session mutation blocking,
network-uncertain booking retries, server error identifiers and paise formatting.
The `web-tests` CI job runs these checks independently of the database integration suite.

Before public launch, perform browser acceptance against a configured staging backend:
OTP and resend, served/unserved addresses, no slots, stale quote, booking retry, Razorpay
success/failure/abandonment, status changes, cancellation, reschedule rejection, start-code
visibility, rating, invoice and support case. Check 360px mobile and desktop layouts,
keyboard navigation, Hindi copy and screen-reader announcements. Live SMS and gateway
behavior cannot be certified from mock responses or a compilation check.
