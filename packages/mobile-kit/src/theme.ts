/**
 * Design tokens shared by the customer and worker apps. Placeholder brand colours until
 * the brand assets arrive; contrast meets WCAG 2.2 AA; touch targets are at least 48 dp.
 */
export const colors = {
  background: '#f6f7f9',
  surface: '#ffffff',
  text: '#16181d',
  muted: '#5b6270',
  border: '#d9dde4',
  brand: '#0b5cad',
  onBrand: '#ffffff',
  danger: '#b3261e',
  warning: '#8a5300',
  ok: '#1b6e3a',
  okBackground: '#eaf6ee',
  errorBackground: '#fbeceb',
  warningBackground: '#fff5e0',
} as const;

export const space = { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 } as const;
export const radius = { sm: 6, md: 10, lg: 16 } as const;
export const font = { small: 14, body: 16, large: 20, title: 24 } as const;
export const MIN_TOUCH = 48;
