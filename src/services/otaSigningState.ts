/**
 * Runtime OTA signing confirmation — env var or admin API can enable promote.
 */

let runtimeSigningConfirmed = false;

export function initOtaSigningState(envConfirmed: boolean): void {
  runtimeSigningConfirmed = envConfirmed;
}

export function isOtaSigningConfirmed(envConfirmed: boolean): boolean {
  return envConfirmed || runtimeSigningConfirmed;
}

export function setOtaSigningConfirmed(confirmed: boolean): void {
  runtimeSigningConfirmed = confirmed;
}

export function getRuntimeSigningConfirmed(): boolean {
  return runtimeSigningConfirmed;
}
