/**
 * TEMP STIMULATE — remove after testing
 */
import { parseStimulateAllowlist } from '../../../src/utils/stimulateAllowlist';

const OLD_ENV = process.env;

beforeEach(() => {
  process.env = { ...OLD_ENV };
});

afterAll(() => {
  process.env = OLD_ENV;
});

describe('parseStimulateAllowlist', () => {
  it('parses comma-separated device IDs', () => {
    process.env.STIMULATE_DEVICE = 'DEVICE-12,DEVICE-13';
    expect(parseStimulateAllowlist()).toEqual(['DEVICE-12', 'DEVICE-13']);
  });

  it('trims whitespace', () => {
    process.env.STIMULATE_DEVICE = ' DEVICE-12 ,  DEVICE-13 ';
    expect(parseStimulateAllowlist()).toEqual(['DEVICE-12', 'DEVICE-13']);
  });

  it('filters out empty entries from trailing commas', () => {
    process.env.STIMULATE_DEVICE = 'DEVICE-12,,DEVICE-13,';
    expect(parseStimulateAllowlist()).toEqual(['DEVICE-12', 'DEVICE-13']);
  });

  it('returns empty array when env is unset', () => {
    delete process.env.STIMULATE_DEVICE;
    expect(parseStimulateAllowlist()).toEqual([]);
  });

  it('returns empty array when env is empty string', () => {
    process.env.STIMULATE_DEVICE = '';
    expect(parseStimulateAllowlist()).toEqual([]);
  });

  it('returns empty array when env is whitespace only', () => {
    process.env.STIMULATE_DEVICE = '   ';
    expect(parseStimulateAllowlist()).toEqual([]);
  });

  it('handles single ID', () => {
    process.env.STIMULATE_DEVICE = 'DEVICE-42';
    expect(parseStimulateAllowlist()).toEqual(['DEVICE-42']);
  });

  it('case-sensitive: DEVICE-12 and device-12 are different', () => {
    process.env.STIMULATE_DEVICE = 'DEVICE-12,device-12';
    expect(parseStimulateAllowlist()).toEqual(['DEVICE-12', 'device-12']);
  });
});
