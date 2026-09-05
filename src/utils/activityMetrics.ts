export type ActivityCounters = {
  mqttMessages: number;
  publishes: number;
  databaseQueries: number;
  httpRequests: number;
};

const counters: ActivityCounters = {
  mqttMessages: 0,
  publishes: 0,
  databaseQueries: 0,
  httpRequests: 0
};

export function incActivity(key: keyof ActivityCounters, n = 1): void {
  counters[key] += n;
}

export function getActivityCounters(): ActivityCounters {
  return { ...counters };
}

export function resetActivityMetricsForTests(): void {
  counters.mqttMessages = 0;
  counters.publishes = 0;
  counters.databaseQueries = 0;
  counters.httpRequests = 0;
}
