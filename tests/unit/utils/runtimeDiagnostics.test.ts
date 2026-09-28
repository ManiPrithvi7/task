import {
  parseProcStatus,
  parseSmapsRollup,
  rssWatchdogMb
} from '@/utils/runtimeDiagnostics';

describe('runtimeDiagnostics parsers', () => {
  it('extracts smaps_rollup Rss and private pages', () => {
    const parsed = parseSmapsRollup(
      ['Rss:               12345 kB', 'Private_Dirty:      1111 kB', 'Private_Clean:       222 kB', 'Pss: 9 kB'].join(
        '\n'
      )
    );
    expect(parsed).toEqual({ rssKb: 12345, privateDirtyKb: 1111, privateCleanKb: 222 });
  });

  it('extracts VmRSS and VmData from /proc/self/status', () => {
    const parsed = parseProcStatus(['Name:\tbun', 'VmRSS:\t  602080 kB', 'VmData:\t  400000 kB'].join('\n'));
    expect(parsed).toEqual({ vmRssKb: 602080, vmDataKb: 400000 });
  });

  it('defaults watchdog to 2048 MB', () => {
    const prev = process.env.MEMORY_WATCHDOG_MB;
    delete process.env.MEMORY_WATCHDOG_MB;
    expect(rssWatchdogMb()).toBe(2048);
    if (prev === undefined) delete process.env.MEMORY_WATCHDOG_MB;
    else process.env.MEMORY_WATCHDOG_MB = prev;
  });
});
