import { describe, expect, it } from 'vitest';
import type { StaffMe } from '@onetappe/api-client';
import { availableActions } from './booking-actions';

const CITY = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';

function staff(permissions: StaffMe['permissions']): StaffMe {
  return {
    id: '33333333-3333-3333-3333-333333333333',
    email: 'a@b.c',
    fullName: 'A',
    locale: 'en',
    roles: [],
    permissions,
    mfaVerifiedAt: null,
  };
}

describe('availableActions', () => {
  const opsHead = staff({
    'booking.reschedule': 'ALL',
    'booking.assign': 'ALL',
    'booking.cancel': 'ALL',
    'booking.mark_no_show': 'ALL',
  });

  it('follows the state machine', () => {
    expect(availableActions(opsHead, { status: 'CONFIRMED', cityId: CITY })).toEqual([
      'hold',
      'reschedule',
      'redispatch',
      'cancel',
    ]);
    expect(availableActions(opsHead, { status: 'ON_HOLD', cityId: CITY })).toContain('releaseHold');
    expect(availableActions(opsHead, { status: 'EN_ROUTE', cityId: CITY })).toEqual([
      'workerNoShow',
      'cancel',
    ]);
    expect(availableActions(opsHead, { status: 'CLOSED', cityId: CITY })).toEqual([]);
  });

  it('follows permissions and city scope', () => {
    const dispatcher = staff({ 'booking.assign': [CITY] });
    expect(availableActions(dispatcher, { status: 'CONFIRMED', cityId: CITY })).toEqual([
      'redispatch',
    ]);
    expect(availableActions(dispatcher, { status: 'CONFIRMED', cityId: OTHER })).toEqual([]);
  });
});
