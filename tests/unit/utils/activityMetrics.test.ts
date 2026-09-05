import { getActivityCounters, incActivity, resetActivityMetricsForTests } from '@/utils/activityMetrics';

describe('activityMetrics', () => {
  afterEach(() => {
    resetActivityMetricsForTests();
  });

  it('increments mqtt/http/db/publish counters', () => {
    incActivity('mqttMessages', 2);
    incActivity('publishes');
    incActivity('databaseQueries', 3);
    incActivity('httpRequests', 4);
    expect(getActivityCounters()).toEqual({
      mqttMessages: 2,
      publishes: 1,
      databaseQueries: 3,
      httpRequests: 4
    });
  });
});
