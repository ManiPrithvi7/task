import type { ICampaign } from '../models/Campaign';
import { CampaignStatus, ScheduleType } from '../models/Campaign';

function resolveTimezone(campaign: ICampaign): string {
  const cfg = campaign.scheduleConfig as { timezone?: string } | undefined;
  if (cfg?.timezone && typeof cfg.timezone === 'string' && cfg.timezone.trim()) {
    return cfg.timezone.trim();
  }
  const envTz = process.env.METRICS_TIMEZONE?.trim();
  return envTz || 'UTC';
}

function isWithinDateWindow(campaign: ICampaign, now: Date): boolean {
  if (campaign.startsAt && now < campaign.startsAt) return false;
  if (campaign.endsAt && now > campaign.endsAt) return false;
  return true;
}

function localTimeHHmm(now: Date, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).formatToParts(now);
    const hour = parts.find((p) => p.type === 'hour')?.value ?? '00';
    const minute = parts.find((p) => p.type === 'minute')?.value ?? '00';
    return `${hour}:${minute}`;
  } catch {
    return `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`;
  }
}

function localWeekday(now: Date, timeZone: string): number {
  try {
    const day = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(now);
    const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return map[day] ?? now.getUTCDay();
  } catch {
    return now.getUTCDay();
  }
}

function isTimeWindowActive(campaign: ICampaign, now: Date): boolean {
  const cfg = campaign.scheduleConfig as { startTime?: string; endTime?: string } | undefined;
  if (!cfg?.startTime || !cfg?.endTime) return true;

  const tz = resolveTimezone(campaign);
  const current = localTimeHHmm(now, tz);
  const start = cfg.startTime.trim();
  const end = cfg.endTime.trim();

  if (start <= end) {
    return current >= start && current <= end;
  }
  // Overnight window (e.g. 22:00 - 06:00)
  return current >= start || current <= end;
}

function isDayOfWeekActive(campaign: ICampaign, now: Date): boolean {
  const cfg = campaign.scheduleConfig as { days?: number[] } | undefined;
  const days = cfg?.days;
  if (!Array.isArray(days) || days.length === 0) return true;

  const tz = resolveTimezone(campaign);
  const weekday = localWeekday(now, tz);
  return days.includes(weekday);
}

/** Server-side campaign schedule gate before MQTT publish. */
export function isCampaignActive(campaign: ICampaign, now: Date = new Date()): boolean {
  if (campaign.status !== CampaignStatus.ACTIVE) return false;
  if (!isWithinDateWindow(campaign, now)) return false;

  switch (campaign.scheduleType) {
    case ScheduleType.ALWAYS:
      return true;
    case ScheduleType.TIME_WINDOW:
      return isTimeWindowActive(campaign, now);
    case ScheduleType.DAY_OF_WEEK:
      return isDayOfWeekActive(campaign, now);
    default:
      return true;
  }
}
