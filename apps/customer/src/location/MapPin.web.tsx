import { Body } from '@onetappe/mobile-kit';

/** Web test build: no map, the coordinates found are shown instead. */
export function MapPin({
  point,
}: {
  point: { lat: number; lng: number };
  onChange: (p: { lat: number; lng: number }) => void;
}) {
  return (
    <Body muted>
      📍 {point.lat.toFixed(5)}, {point.lng.toFixed(5)}
    </Body>
  );
}
