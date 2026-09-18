/** Open stim OTA upload page (non-prod). No JWT for lab testing. */

export const STIM_OTA_ADMIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Stim OTA upload</title>
  <style>
    :root { color-scheme: dark; }
    body { font: 15px/1.45 system-ui, sans-serif; max-width: 40rem; margin: 2rem auto; padding: 0 1rem; background: #111; color: #eee; }
    label { display: block; margin: 0.75rem 0 0.25rem; }
    input, button { font: inherit; }
    input[type=text] { width: 100%; padding: 0.4rem 0.5rem; box-sizing: border-box; }
    button { margin-top: 1rem; padding: 0.45rem 0.9rem; cursor: pointer; }
    pre { background: #1c1c1c; padding: 0.75rem; overflow: auto; white-space: pre-wrap; }
    .row { display: flex; gap: 0.5rem; flex-wrap: wrap; }
    .err { color: #f88; }
    .ok { color: #8d8; }
  </style>
</head>
<body>
  <h1>Stim OTA</h1>
  <p>Open for lab testing (no login). Signing fields live in Redis (seeded from env at boot). Upload is optional; MQTT reads Redis on <code>/active</code>.</p>
  <label>Version (newer than device fw_version) — only for a new bin upload</label>
  <input id="version" type="text" placeholder="9.9.9"/>
  <label>Firmware file</label>
  <input id="file" type="file" accept=".bin,.ino.bin,application/octet-stream"/>
  <div class="row">
    <button type="button" id="upload">Upload</button>
    <button type="button" id="offer">Load current offer</button>
    <button type="button" id="pubkey">Download lab public key</button>
  </div>
  <pre id="out"></pre>
  <script>
    const base = '/api/v1/admin/ota';
    const out = document.getElementById('out');
    function show(ok, data) {
      out.className = ok ? 'ok' : 'err';
      out.textContent = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    }
    document.getElementById('upload').onclick = async () => {
      try {
        const version = document.getElementById('version').value.trim();
        const file = document.getElementById('file').files[0];
        if (!version) throw new Error('Version required');
        if (!file) throw new Error('Choose a .bin file');
        const body = new FormData();
        body.append('version', version);
        body.append('firmware', file, file.name);
        const res = await fetch(base + '/stim/firmware', { method: 'POST', body });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || res.statusText);
        show(true, json);
      } catch (e) { show(false, e.message || String(e)); }
    };
    document.getElementById('offer').onclick = async () => {
      try {
        const res = await fetch(base + '/stim/offer');
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || res.statusText);
        show(true, json);
      } catch (e) { show(false, e.message || String(e)); }
    };
    document.getElementById('pubkey').onclick = async () => {
      try {
        const res = await fetch(base + '/stim/lab-public-key');
        const text = await res.text();
        if (!res.ok) throw new Error(text);
        const blob = new Blob([text], { type: 'application/x-pem-file' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'ota-lab-public.pem';
        a.click();
        show(true, text);
      } catch (e) { show(false, e.message || String(e)); }
    };
  </script>
</body>
</html>
`;
