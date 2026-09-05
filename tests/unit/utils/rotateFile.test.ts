import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { rotateKeepingOne } from '@/utils/rotateFile';

describe('rotateKeepingOne', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rotate-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('renames over-size file to .1 and drops a previous generation', async () => {
    const file = path.join(dir, 'log.csv');
    const bak = `${file}.1`;
    await fs.writeFile(bak, 'old-gen');
    await fs.writeFile(file, 'x'.repeat(64));
    await rotateKeepingOne(file, 32);
    await expect(fs.readFile(bak, 'utf8')).resolves.toBe('x'.repeat(64));
    await expect(fs.stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('leaves a small file in place', async () => {
    const file = path.join(dir, 'log.csv');
    await fs.writeFile(file, 'tiny');
    await rotateKeepingOne(file, 32);
    await expect(fs.readFile(file, 'utf8')).resolves.toBe('tiny');
  });
});
