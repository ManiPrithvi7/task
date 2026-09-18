/** Drop local .env stim OTA vars so production validateConfig tests see a clean slate. */
export function clearStimTestOtaEnv(): void {
  delete process.env.TEST_OTA_URL;
  delete process.env.TEST_OTA_VERSION;
  delete process.env.TEST_OTA_SHA256;
  delete process.env.TEST_OTA_SIGNATURE;
  delete process.env.TEST_OTA_SIZE_BYTES;
}
