import { formatInr } from '@onetappe/domain';

/** Operations work in India time; every time shown says so. */
const IST = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  dateStyle: 'medium',
  timeStyle: 'short',
});

export const formatTime = (iso: string) => `${IST.format(new Date(iso))} IST`;
export const formatMoney = (paise: number) => formatInr(paise);

/** `datetime-local` value (India time) → ISO instant. */
export function istLocalToIso(value: string): string {
  return new Date(`${value}:00+05:30`).toISOString();
}

/** ISO instant → `datetime-local` value in India time. */
export function isoToIstLocal(iso: string): string {
  const shifted = new Date(new Date(iso).getTime() + 330 * 60_000);
  return shifted.toISOString().slice(0, 16);
}
