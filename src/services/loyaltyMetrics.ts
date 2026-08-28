import client from 'prom-client';
import { metricsRegister } from '../middleware/metrics';

function histogram(name: string, help: string, buckets: number[]): client.Histogram<string> {
  const existing = metricsRegister.getSingleMetric(name);
  if (existing) return existing as client.Histogram<string>;
  return new client.Histogram({ name, help, buckets, registers: [metricsRegister] });
}

function counter(name: string, help: string, labelNames?: string[]): client.Counter<string> {
  const existing = metricsRegister.getSingleMetric(name);
  if (existing) return existing as client.Counter<string>;
  const opts: client.CounterConfiguration<string> = { name, help, registers: [metricsRegister] };
  if (labelNames && labelNames.length > 0) opts.labelNames = labelNames;
  return new client.Counter(opts);
}

const ackLatency = histogram(
  'loyalty_spin_ack_latency_ms',
  'MQTT command publish to spin/ack ingest latency',
  [50, 100, 250, 500, 1000, 2000, 5000]
);

const failures = counter('loyalty_spin_failures_total', 'Loyalty spin failures by cause', ['reason']);

const sessionExpiry = counter(
  'loyalty_session_expiry_total',
  'Loyalty session expiry by reason',
  ['reason']
);

const clockDriftWarn = counter(
  'loyalty_clock_drift_warn_total',
  'spin/ack startedAt vs server ackReceivedAt delta over warn threshold'
);

const deviceAckSkew = histogram(
  'loyalty_spin_device_ack_skew_ms',
  'Absolute delta between device startedAt and server ackReceivedAt',
  [50, 100, 250, 500, 1000, 2000, 5000]
);

export function observeLoyaltyAckLatencyMs(ms: number): void {
  ackLatency.observe(ms);
}

export function observeLoyaltyDeviceAckSkewMs(ms: number): void {
  deviceAckSkew.observe(ms);
}

export function incLoyaltySpinFailure(reason: string): void {
  failures.inc({ reason });
}

export function incLoyaltySessionExpiry(reason: string): void {
  sessionExpiry.inc({ reason });
}

export function incLoyaltyClockDriftWarn(): void {
  clockDriftWarn.inc();
}
