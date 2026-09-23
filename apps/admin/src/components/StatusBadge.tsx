import { STATUS_LABELS, type Locale } from '@/i18n/dictionaries';

/** Status as words (never colour alone), with the code for searching. */
export function StatusBadge({ status, locale }: { status: string; locale: Locale }) {
  return (
    <span className="badge" title={status}>
      {STATUS_LABELS[locale][status] ?? status}
    </span>
  );
}
