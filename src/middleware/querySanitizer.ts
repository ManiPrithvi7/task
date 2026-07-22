const ALLOWED_FLUX_FUNCTIONS = new Set([
  'from', 'range', 'filter', 'pivot', 'sort', 'limit',
  'group', 'map', 'reduce',
  'aggregateWindow', 'window',
  'mean', 'sum', 'count', 'min', 'max',
  'last', 'first',
  'keep', 'drop', 'rename', 'duplicate',
  'toString', 'toInt', 'toFloat',
  'timeShift', 'truncateTimeColumn',
  'fill',
  'set',
  'columns',
]);

export const KNOWN_MEASUREMENTS: Record<string, RegExp[]> = {
  metrics: [
    /^profile_baseline$/,
    /^instagram_metrics$/,
    /^instagram_fetch_audit$/,
    /^instagram_mqtt_delivery$/,
    /^instagram_circuit_event$/,
    /^instagram_attention_e2e$/,
    /^webhook_received$/,
    /^webhook_device_resolution$/,
    /^webhook_mqtt_delivery$/,
    /^milestone_crossed$/,
    /^velocity_weekly$/,
    /^device_metrics$/,
    /^system_metrics$/,
    /^social_metrics$/,
    /^rate_limit_events$/,
    /^device_ota_events$/,
    /^gmb_review_snapshot$/,
    /^gmb_webhook_audit$/,
    /^gmb_velocity_weekly$/,
  ],
  compliance: [
    /^pki_audit$/,
    /^ct_log$/,
    /^ota_release_log$/,
  ],
};

const MAX_RESULTS = 10_000;
const MAX_EXECUTION_MS = 30_000;

export interface SanitizeResult {
  valid: boolean;
  error?: string;
}

function extractFunctionCalls(flux: string): string[] {
  const calls: string[] = [];
  const fnRegex = /[a-zA-Z_]\w*(?=\s*\()/g;
  let match: RegExpExecArray | null;
  while ((match = fnRegex.exec(flux)) !== null) {
    calls.push(match[0]);
  }
  return calls;
}

export function sanitizeFluxQuery(flux: string, scope: 'metrics' | 'compliance'): SanitizeResult {
  if (typeof flux !== 'string' || flux.trim().length === 0) {
    return { valid: false, error: 'Query must be a non-empty string' };
  }

  const functions = extractFunctionCalls(flux);
  for (const fn of functions) {
    if (!ALLOWED_FLUX_FUNCTIONS.has(fn)) {
      return {
        valid: false,
        error: `Function "${fn}()" is not allowed. Allowed functions: ${[...ALLOWED_FLUX_FUNCTIONS].sort().join(', ')}`,
      };
    }
  }

  const measurementMatch = flux.match(/r\._measurement\s*==\s*"([^"]+)"/);
  if (measurementMatch) {
    const measurement = measurementMatch[1];
    const allowed = KNOWN_MEASUREMENTS[scope] || [];
    const isAllowed = allowed.some((re) => re.test(measurement));
    if (!isAllowed) {
      return {
        valid: false,
        error: `Measurement "${measurement}" is not allowed in scope "${scope}"`,
      };
    }
  }

  const limitMatch = flux.match(/\|>\s*limit\s*\(\s*n\s*:\s*(\d+)\s*\)/);
  if (limitMatch) {
    const n = parseInt(limitMatch[1], 10);
    if (n > MAX_RESULTS) {
      return { valid: false, error: `Row limit exceeds maximum (${MAX_RESULTS})` };
    }
  }

  return { valid: true };
}

export { MAX_RESULTS, MAX_EXECUTION_MS };
