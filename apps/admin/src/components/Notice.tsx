import type { ReactNode } from 'react';

export function Notice({
  kind,
  children,
}: {
  kind: 'ok' | 'error' | 'warning';
  children: ReactNode;
}) {
  return (
    <div className={`notice ${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      {children}
    </div>
  );
}
