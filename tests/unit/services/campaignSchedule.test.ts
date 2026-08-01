/**
 * campaignSchedule — Comprehensive Test Suite
 *
 * Pure-function coverage for isCampaignActive:
 *   status/date window, TIME_WINDOW (incl. overnight), DAY_OF_WEEK, timezone precedence
 * Fixed UTC instants — immune to host machine timezone.
 */

import type { ICampaign } from '@/models/Campaign';
import { CampaignStatus, ScheduleType } from '@/models/Campaign';
import { isCampaignActive } from '@/services/campaignSchedule';

const baseCampaign = {
  status: CampaignStatus.ACTIVE,
  scheduleType: ScheduleType.ALWAYS,
  scheduleConfig: {},
  startsAt: null,
  endsAt: null,
} as unknown as ICampaign;

describe('campaignSchedule - isCampaignActive', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.METRICS_TIMEZONE;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  /* ══════════════════════════════════════════════════════════════
   * 1.1 Status & Date Window
   * ══════════════════════════════════════════════════════════════ */

  describe('status and date window', () => {
    test('returns false if status is not ACTIVE', () => {
      const now = new Date('2026-06-04T12:00:00Z');
      const campaign = { ...baseCampaign, status: CampaignStatus.PAUSED };
      expect(isCampaignActive(campaign, now)).toBe(false);
    });

    test('returns false if now < startsAt', () => {
      const now = new Date('2026-06-04T12:00:00Z');
      const campaign = {
        ...baseCampaign,
        startsAt: new Date('2026-06-04T15:00:00Z'),
      };
      expect(isCampaignActive(campaign, now)).toBe(false);
    });

    test('returns false if now > endsAt', () => {
      const now = new Date('2026-06-04T12:00:00Z');
      const campaign = {
        ...baseCampaign,
        endsAt: new Date('2026-06-04T10:00:00Z'),
      };
      expect(isCampaignActive(campaign, now)).toBe(false);
    });

    test('boundary inclusive: now == startsAt -> true', () => {
      const now = new Date('2026-06-04T12:00:00Z');
      const campaign = {
        ...baseCampaign,
        startsAt: new Date('2026-06-04T12:00:00Z'),
      };
      expect(isCampaignActive(campaign, now)).toBe(true);
    });

    test('boundary inclusive: now == endsAt -> true', () => {
      const now = new Date('2026-06-04T12:00:00Z');
      const campaign = {
        ...baseCampaign,
        endsAt: new Date('2026-06-04T12:00:00Z'),
      };
      expect(isCampaignActive(campaign, now)).toBe(true);
    });

    test('returns true if inside both startsAt and endsAt', () => {
      const now = new Date('2026-06-04T12:00:00Z');
      const campaign = {
        ...baseCampaign,
        startsAt: new Date('2026-06-04T10:00:00Z'),
        endsAt: new Date('2026-06-04T15:00:00Z'),
      };
      expect(isCampaignActive(campaign, now)).toBe(true);
    });

    test('returns true for unknown scheduleType (default branch)', () => {
      const now = new Date('2026-06-04T12:00:00Z');
      const campaign = {
        ...baseCampaign,
        scheduleType: 'NIGHTLY' as ScheduleType,
      };
      expect(isCampaignActive(campaign, now)).toBe(true);
    });
  });

  /* ══════════════════════════════════════════════════════════════
   * 1.2 Time Window (isTimeWindowActive)
   * ══════════════════════════════════════════════════════════════ */

  describe('TIME_WINDOW schedule', () => {
    const windowCampaign = (
      startTime: string,
      endTime: string,
      timezone?: string
    ): ICampaign =>
      ({
        ...baseCampaign,
        scheduleType: ScheduleType.TIME_WINDOW,
        scheduleConfig: { startTime, endTime, timezone },
      }) as ICampaign;

    test('returns true if startTime/endTime are missing', () => {
      const now = new Date('2026-06-04T12:00:00Z');
      const campaign = {
        ...baseCampaign,
        scheduleType: ScheduleType.TIME_WINDOW,
        scheduleConfig: {},
      } as ICampaign;
      expect(isCampaignActive(campaign, now)).toBe(true);
    });

    test('inside window (09:00 - 17:00 UTC)', () => {
      const now = new Date('2026-06-04T12:00:00Z');
      expect(isCampaignActive(windowCampaign('09:00', '17:00', 'UTC'), now)).toBe(
        true
      );
    });

    test('outside window (before start)', () => {
      const now = new Date('2026-06-04T08:00:00Z');
      expect(isCampaignActive(windowCampaign('09:00', '17:00', 'UTC'), now)).toBe(
        false
      );
    });

    test('outside window (after end)', () => {
      const now = new Date('2026-06-04T18:00:00Z');
      expect(isCampaignActive(windowCampaign('09:00', '17:00', 'UTC'), now)).toBe(
        false
      );
    });

    test('boundary inclusive: current == start -> true', () => {
      const now = new Date('2026-06-04T09:00:00Z');
      expect(isCampaignActive(windowCampaign('09:00', '17:00', 'UTC'), now)).toBe(
        true
      );
    });

    test('boundary inclusive: current == end -> true', () => {
      const now = new Date('2026-06-04T17:00:00Z');
      expect(isCampaignActive(windowCampaign('09:00', '17:00', 'UTC'), now)).toBe(
        true
      );
    });

    describe('overnight window (22:00 - 06:00)', () => {
      const overnightCampaign = () => windowCampaign('22:00', '06:00', 'UTC');

      test('23:30 -> true (after start)', () => {
        const now = new Date('2026-06-04T23:30:00Z');
        expect(isCampaignActive(overnightCampaign(), now)).toBe(true);
      });

      test('04:00 -> true (before end)', () => {
        const now = new Date('2026-06-04T04:00:00Z');
        expect(isCampaignActive(overnightCampaign(), now)).toBe(true);
      });

      test('12:00 -> false (neither branch)', () => {
        const now = new Date('2026-06-04T12:00:00Z');
        expect(isCampaignActive(overnightCampaign(), now)).toBe(false);
      });
    });

    test('invalid timezone falls back to UTC', () => {
      const now = new Date('2026-06-04T12:00:00Z');
      const campaign = windowCampaign('09:00', '17:00', 'Invalid/Timezone');
      expect(isCampaignActive(campaign, now)).toBe(true);
    });

    test('whitespace-trimmed timezone', () => {
      const now = new Date('2026-06-04T12:00:00Z');
      const campaign = windowCampaign('09:00', '17:00', '  UTC  ');
      expect(isCampaignActive(campaign, now)).toBe(true);
    });
  });

  /* ══════════════════════════════════════════════════════════════
   * 1.3 Day of Week (isDayOfWeekActive)
   * ══════════════════════════════════════════════════════════════ */

  describe('DAY_OF_WEEK schedule', () => {
    const dowCampaign = (days: number[], timezone?: string): ICampaign =>
      ({
        ...baseCampaign,
        scheduleType: ScheduleType.DAY_OF_WEEK,
        scheduleConfig: { days, timezone },
      }) as ICampaign;

    // 2026-06-04T12:00:00Z is a Thursday (4)
    const thursdayUTC = new Date('2026-06-04T12:00:00Z');

    test('returns true if days array is missing or empty', () => {
      expect(
        isCampaignActive(
          {
            ...baseCampaign,
            scheduleType: ScheduleType.DAY_OF_WEEK,
            scheduleConfig: {},
          } as ICampaign,
          thursdayUTC
        )
      ).toBe(true);

      expect(
        isCampaignActive(
          {
            ...baseCampaign,
            scheduleType: ScheduleType.DAY_OF_WEEK,
            scheduleConfig: { days: [] },
          } as ICampaign,
          thursdayUTC
        )
      ).toBe(true);
    });

    test('returns true if current day is in list (Thursday = 4)', () => {
      expect(isCampaignActive(dowCampaign([1, 3, 4], 'UTC'), thursdayUTC)).toBe(
        true
      );
    });

    test('returns false if current day is not in list', () => {
      expect(isCampaignActive(dowCampaign([1, 2, 3], 'UTC'), thursdayUTC)).toBe(
        false
      );
    });

    test('Sunday mapping (0)', () => {
      const sundayUTC = new Date('2026-06-07T12:00:00Z');
      expect(isCampaignActive(dowCampaign([0], 'UTC'), sundayUTC)).toBe(true);
    });

    test('timezone-sensitive weekday flips day correctly', () => {
      // Instant is Thursday 12:00 UTC.
      // In Pacific/Kiritimati (+14), local time is Friday 02:00.
      // In America/Los_Angeles (-7), local time is Thursday 05:00.

      expect(
        isCampaignActive(dowCampaign([5], 'Pacific/Kiritimati'), thursdayUTC)
      ).toBe(true);

      expect(
        isCampaignActive(dowCampaign([4], 'America/Los_Angeles'), thursdayUTC)
      ).toBe(true);

      expect(
        isCampaignActive(dowCampaign([5], 'America/Los_Angeles'), thursdayUTC)
      ).toBe(false);
    });

    test('invalid timezone falls back to UTC day', () => {
      expect(isCampaignActive(dowCampaign([4], 'Invalid/Tz'), thursdayUTC)).toBe(
        true
      );
      expect(isCampaignActive(dowCampaign([5], 'Invalid/Tz'), thursdayUTC)).toBe(
        false
      );
    });
  });

  /* ══════════════════════════════════════════════════════════════
   * 1.4 Timezone Resolution (resolveTimezone)
   * ══════════════════════════════════════════════════════════════ */

  describe('timezone resolution precedence', () => {
    const windowCampaign = (timezone?: string): ICampaign =>
      ({
        ...baseCampaign,
        scheduleType: ScheduleType.TIME_WINDOW,
        scheduleConfig: { startTime: '09:00', endTime: '17:00', timezone },
      }) as ICampaign;

    // 16:00 UTC → 18:00 in Africa/Cairo (+2) → outside 09:00-17:00
    const now = new Date('2026-06-04T16:00:00Z');

    test('campaign timezone wins over env', () => {
      process.env.METRICS_TIMEZONE = 'UTC';
      const campaign = windowCampaign('Africa/Cairo');
      expect(isCampaignActive(campaign, now)).toBe(false);
    });

    test('env timezone used when campaign tz is missing', () => {
      process.env.METRICS_TIMEZONE = 'Africa/Cairo';
      const campaign = windowCampaign(undefined);
      expect(isCampaignActive(campaign, now)).toBe(false);
    });

    test('defaults to UTC when neither is present', () => {
      const campaign = windowCampaign(undefined);
      expect(isCampaignActive(campaign, now)).toBe(true);
    });
  });
});
