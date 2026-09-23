import type { NextConfig } from 'next';

const config: NextConfig = {
  // Workspace packages are TypeScript source; Next compiles them with the app.
  transpilePackages: ['@onetappe/api-client', '@onetappe/domain'],
  poweredByHeader: false,
  reactStrictMode: true,
  output: 'standalone',
  headers() {
    // The per-request Content-Security-Policy (with a nonce) is set in src/proxy.ts.
    return Promise.resolve([
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
        ],
      },
    ]);
  },
};

export default config;
