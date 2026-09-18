import type { Request } from 'express';

export type StimFirmwareUploadBody = {
  version: string;
  bytes: Buffer;
  filename: string;
};

function headerValue(req: Request, name: string): string {
  const raw = req.headers[name.toLowerCase()];
  if (Array.isArray(raw)) return raw[0] || '';
  return typeof raw === 'string' ? raw : '';
}

/** Parse multipart/form-data (fields: version, file firmware|file|bin) or raw octet-stream. */
export function parseStimFirmwareUpload(req: Request, rawBody: Buffer): StimFirmwareUploadBody {
  const contentType = headerValue(req, 'content-type');
  if (contentType.toLowerCase().includes('multipart/form-data')) {
    return parseMultipart(rawBody, contentType);
  }

  const version = String(req.query.version || headerValue(req, 'x-firmware-version') || '').trim();
  if (!version) {
    throw new Error('version is required (query, X-Firmware-Version, or multipart field)');
  }
  return { version, bytes: rawBody, filename: 'firmware.bin' };
}

function parseMultipart(raw: Buffer, contentType: string): StimFirmwareUploadBody {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const boundary = (boundaryMatch?.[1] || boundaryMatch?.[2] || '').trim();
  if (!boundary) {
    throw new Error('multipart boundary missing');
  }
  const delim = Buffer.from(`--${boundary}`);
  let version = '';
  let bytes: Buffer | null = null;
  let filename = 'firmware.bin';

  let pos = 0;
  while (pos < raw.length) {
    const start = raw.indexOf(delim, pos);
    if (start < 0) break;
    pos = start + delim.length;
    if (raw[pos] === 45 && raw[pos + 1] === 45) break;
    if (raw[pos] === 13) pos += 1;
    if (raw[pos] === 10) pos += 1;

    const headerEnd = raw.indexOf(Buffer.from('\r\n\r\n'), pos);
    if (headerEnd < 0) break;
    const headers = raw.slice(pos, headerEnd).toString('utf8');
    const bodyStart = headerEnd + 4;
    const next = raw.indexOf(delim, bodyStart);
    const bodyEnd = next < 0 ? raw.length : next;
    let part = raw.slice(bodyStart, bodyEnd);
    if (part.length >= 2 && part[part.length - 2] === 13 && part[part.length - 1] === 10) {
      part = part.slice(0, -2);
    }

    const nameMatch = /name="([^"]+)"/i.exec(headers);
    const fileMatch = /filename="([^"]*)"/i.exec(headers);
    const name = (nameMatch?.[1] || '').toLowerCase();
    if (fileMatch && (name === 'firmware' || name === 'file' || name === 'bin' || name === '')) {
      bytes = part;
      filename = fileMatch[1] || filename;
    } else if (name === 'version') {
      version = part.toString('utf8').trim();
    }
    pos = bodyEnd;
  }

  if (!version) {
    throw new Error('multipart field version is required');
  }
  if (!bytes || bytes.length < 1) {
    throw new Error('multipart firmware file is required (field firmware, file, or bin)');
  }
  return { version, bytes, filename };
}
