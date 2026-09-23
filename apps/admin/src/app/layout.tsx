import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { requestLocale } from '@/server/locale';
import './globals.css';

export const metadata: Metadata = {
  title: 'One Tappe Operations',
  robots: { index: false, follow: false },
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = await requestLocale();
  return (
    <html lang={locale}>
      <body>{children}</body>
    </html>
  );
}
