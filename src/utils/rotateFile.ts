import { promises as fs } from 'fs';

/** Rename path → path.1 when over maxBytes; drop a previous .1. */
export async function rotateKeepingOne(filePath: string, maxBytes: number): Promise<void> {
  try {
    const st = await fs.stat(filePath);
    if (st.size <= maxBytes) return;
    const bak = `${filePath}.1`;
    await fs.unlink(bak).catch(() => undefined);
    await fs.rename(filePath, bak);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw err;
  }
}
