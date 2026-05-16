import fs from 'fs-extra';
const ANSI_RE = /\x1B\[[0-9;]*[A-Za-z]|\x1B\][^\x07]*\x07|\x1B[()][AB012]/g;
export function stripAnsi(str) { return typeof str === 'string' ? str.replace(ANSI_RE, '') : str; }
export async function tryReadJson(filePath) {
  try {
    return await fs.readJson(filePath);
  } catch {
    return null;
  }
}
export async function safeReaddir(dir) {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}
export function buildPlaceholderHtml(version) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>SFDT Dashboard</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
         background:#f3f3f3;display:flex;align-items:center;
         justify-content:center;min-height:100vh}
    .card{background:#fff;border-radius:8px;padding:40px 48px;
          max-width:500px;width:100%;box-shadow:0 2px 8px rgba(0,0,0,.1);
          border-top:4px solid #0176d3}
    h1{font-size:22px;color:#032d60;margin-bottom:8px}
    p{color:#706e6b;font-size:14px;line-height:1.6;margin-bottom:16px}
    code{background:#f3f3f3;padding:2px 6px;border-radius:4px;
         font-family:monospace;font-size:13px;color:#032d60}
    pre{background:#032d60;color:#fff;padding:16px 20px;border-radius:6px;
        font-size:13px;overflow-x:auto;margin-bottom:16px}
    .version{color:#919191;font-size:12px;margin-top:24px}
  </style>
</head>
<body>
  <div class="card">
    <h1>SFDT Dashboard — Build Required</h1>
    <p>The GUI hasn't been compiled yet. Run these commands from the
       <code>sfdt</code> package root to build it:</p>
    <pre>cd gui
npm install
npm run build</pre>
    <p>Or use the convenience script from the package root:</p>
    <pre>npm run build:gui</pre>
    <p>Then restart <code>sfdt ui</code> and refresh this page.</p>
    <p class="version">sfdt v${version}</p>
  </div>
</body>
</html>`;
}
