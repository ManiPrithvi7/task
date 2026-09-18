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
    pre { background: #1c1c1c; padding: 0.75rem; overflow: auto; white-space: pre-wrap; display: none; }
    .row { display: flex; gap: 0.5rem; flex-wrap: wrap; }
    .card { background: #1c1c1c; padding: 0.75rem 1rem; margin: 1rem 0; border-radius: 6px; }
    .muted { color: #aaa; font-size: 13px; }
    .err { color: #f88; }
    .ok { color: #8d8; }
  </style>
</head>
<body>
  <h1>Stim OTA</h1>
  <p>Open for lab testing (no login). MQTT on <code>/active</code> uses the Redis offer below.</p>
  <div class="card">
    <div class="muted">Current offer (Redis)</div>
    <p>Firmware version: <strong id="cur-version">loading…</strong></p>
    <p>Firmware file: <strong id="cur-file">loading…</strong></p>
  </div>
  <label>Version (newer than device fw_version) — only for a new bin upload</label>
  <input id="version" type="text" placeholder="9.9.9"/>
  <label>Firmware file</label>
  <input id="file" type="file" accept=".bin,.ino.bin,application/octet-stream"/>
  <div class="row">
    <button type="button" id="upload">Upload</button>
    <button type="button" id="offer">Refresh current offer</button>
    <button type="button" id="pubkey">Download lab public key</button>
  </div>
  <pre id="out"></pre>
  <script>
    const base = '/api/v1/admin/ota';
    const out = document.getElementById('out');
    const curVersion = document.getElementById('cur-version');
    const curFile = document.getElementById('cur-file');
    function show(ok, data) {
      out.style.display = 'block';
      out.className = ok ? 'ok' : 'err';
      out.textContent = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    }
    function setCurrent(json) {
      curVersion.textContent = (json && json.version) ? json.version : '—';
      curFile.textContent = (json && json.filename) ? json.filename : '—';
    }
    async function loadOffer() {
      const res = await fetch(base + '/stim/offer');
      const json = await res.json();
      if (!res.ok) {
        setCurrent(null);
        throw new Error(json.error || res.statusText);
      }
      setCurrent(json);
      return json;
    }
    loadOffer().catch(() => setCurrent(null));
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
        setCurrent(json);
        show(true, json);
      } catch (e) { show(false, e.message || String(e)); }
    };
    document.getElementById('offer').onclick = async () => {
      try { await loadOffer(); }
      catch (e) { setCurrent(null); }
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
      } catch (e) { show(false, e.message || String(e)); }
    };
  </script>
</body>
</html>
`;
