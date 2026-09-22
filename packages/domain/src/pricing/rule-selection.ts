import { isWithinDailyWindow, toLocalClock, type IsoWeekday } from '../time/local-time.js';

/**
 * Dimensions shared by customer price rules and worker payout rules. A `null` dimension
 * matches everything; a set dimension must match the booking.
 */
export interface ScopedRule {
  readonly id: string;
  readonly serviceId: string;
  readonly serviceOptionId: string | null;
  readonly cityId: string | null;
  readonly zoneId: string | null;
  /** ISO weekdays the rule applies to; null = every day. */
  readonly weekdays: readonly IsoWeekday[] | null;
  /** Local minutes since midnight; both null = all day. */
  readonly startMinute: number | null;
  readonly endMinute: number | null;
  readonly validFrom: Date;
  readonly validTo: Date | null;
  /** Higher wins before specificity is considered. */
  readonly priority: number;
  readonly isActive: boolean;
}

export interface RuleContext {
  readonly serviceId: string;
  readonly serviceOptionId: string | null;
  readonly cityId: string;
  readonly zoneId: string;
  /** Scheduled start of the service. */
  readonly serviceStart: Date;
  /** When the price is being calculated (rule validity is checked at this instant). */
  readonly pricedAt: Date;
  readonly timeZone: string;
}

export function ruleMatches(rule: ScopedRule, ctx: RuleContext): boolean {
  if (!rule.isActive) return false;
  if (rule.serviceId !== ctx.serviceId) return false;
  if (rule.serviceOptionId !== null && rule.serviceOptionId !== ctx.serviceOptionId) return false;
  if (rule.cityId !== null && rule.cityId !== ctx.cityId) return false;
  if (rule.zoneId !== null && rule.zoneId !== ctx.zoneId) return false;
  if (ctx.pricedAt < rule.validFrom) return false;
  if (rule.validTo !== null && ctx.pricedAt >= rule.validTo) return false;

  const clock = toLocalClock(ctx.serviceStart, ctx.timeZone);
  if (rule.weekdays !== null && !rule.weekdays.includes(clock.weekday)) return false;
  if (rule.startMinute !== null && rule.endMinute !== null) {
    if (!isWithinDailyWindow(clock.minuteOfDay, rule.startMinute, rule.endMinute)) return false;
  }
  return true;
}

function specificity(rule: ScopedRule): number {
  let score = 0;
  if (rule.serviceOptionId !== null) score += 16;
  if (rule.zoneId !== null) score += 8;
  if (rule.cityId !== null) score += 4;
  if (rule.weekdays !== null) score += 2;
  if (rule.startMinute !== null && rule.endMinute !== null) score += 1;
  return score;
}

/**
 * Picks the rule that applies to a booking: highest priority, then most specific, then
 * the most recently effective, then lowest id (so the result is always deterministic).
 * Returns null when nothing matches; callers must treat that as "not sellable".
 */
export function selectRule<R extends ScopedRule>(rules: readonly R[], ctx: RuleContext): R | null {
  const matching = rules.filter((rule) => ruleMatches(rule, ctx));
  matching.sort(
    (a, b) =>
      b.priority - a.priority ||
      specificity(b) - specificity(a) ||
      b.validFrom.getTime() - a.validFrom.getTime() ||
      a.id.localeCompare(b.id),
  );
  return matching[0] ?? null;
}
