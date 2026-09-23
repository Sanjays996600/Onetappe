import type { StaffMe } from '@onetappe/api-client';

/** Whether the staff member holds `permission` (in `cityId`, when given). Display only. */
export function can(me: StaffMe, permission: string, cityId?: string): boolean {
  const grant = me.permissions[permission];
  if (grant === undefined) return false;
  if (grant === 'ALL' || cityId === undefined) return true;
  return grant.includes(cityId);
}

/** The first screen this person may use (the board, else staff, else system status). */
export function homeFor(me: StaffMe): string | null {
  if (can(me, 'booking.read')) return '/';
  if (can(me, 'user.manage')) return '/staff';
  if (can(me, 'system.read')) return '/system';
  return null;
}
