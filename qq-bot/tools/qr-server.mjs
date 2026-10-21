/**
 * 二维码实时看板。
 *
 * 解决的具体问题：NapCat 的登录二维码约 2 分钟就过期并换新，
 * 而"我截图 → 发到对话 → 你看到 → 扫"这条链路本身就要花掉大半有效期，
 * 而且聊天里的图片是同一个文件名，会被浏览器缓存住，永远显示第一张。
 *
 * 这个服务做三件事：
 *   1. 每次都绕过缓存读磁盘上最新的 qrcode.png
 *   2. 页面每 4 秒自己换一张，你打开一次就不用管了
 *   3. 顺带探测 3001 端口——它一起来就说明 OneBot 握手成功、登录完成了
 *
 * 用法：node tools/qr-server.mjs   然后浏览器打开 http://127.0.0.1:6180/
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { connect } from 'node:net';
import { resolve } from 'node:path';
import { ROOT } from '../src/config.mjs';

const QR_PATH = resolve(ROOT, 'napcat/shell/cache/qrcode.png');
const PORT = Number(process.env.QR_PORT ?? 6180);
const HOST = '127.0.0.1';

/** 探测某端口是否有人监听——用来判断 OneBot 有没有起来（= 登录成功）。 */
function portOpen(port, timeout = 600) {
  return new Promise((res) => {
    const sock = connect({ port, host: HOST });
    const done = (ok) => {
      sock.destroy();
      res(ok);
    };
    sock.setTimeout(timeout);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

const PAGE = `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>QQ 登录二维码 · 实时</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; background:#0f1115; color:#e6e8ec;
         font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;
         display:flex; flex-direction:column; align-items:center; justify-content:center; gap:22px; padding:32px; }
  h1 { font-size:20px; font-weight:600; margin:0; letter-spacing:.01em; }
  .frame { background:#fff; padding:18px; border-radius:16px; box-shadow:0 10px 40px rgba(0,0,0,.5); line-height:0; }
  img { width:320px; height:320px; image-rendering:pixelated; display:block; }
  .meta { font-size:13.5px; color:#8b93a1; text-align:center; line-height:1.9; }
  .meta b { color:#e6e8ec; font-weight:600; }
  .ok { display:none; background:#12351f; border:1px solid #1f7a45; color:#63e6a0;
        padding:16px 22px; border-radius:12px; font-size:16px; font-weight:600; }
  .ok.show { display:block; }
  .stale { color:#f0b24a; }
  code { background:#1a1f27; padding:2px 7px; border-radius:5px; font-size:12.5px; color:#c9d1d9; }
</style></head>
<body>
  <h1>用手机上的<b>小号</b> QQ 扫这个码</h1>
  <div class="ok" id="ok">✅ 登录成功，OneBot 端口已就绪 —— 可以回去告诉 DSH 了</div>
  <div class="frame"><img id="q" alt="登录二维码"></div>
  <div class="meta">
    二维码生成于 <b id="gen">—</b>，已过去 <b id="age">—</b> 秒<br>
    过期会自动换新，本页 <b>每 4 秒</b>自动重取，看到码变了就扫新的那张<br>
    <span id="hint"></span>
  </div>
<script>
const img = document.getElementById('q');
const gen = document.getElementById('gen'), age = document.getElementById('age');
const hint = document.getElementById('hint'), ok = document.getElementById('ok');
let genAt = null;

function refresh() {
  img.src = '/qr.png?t=' + Date.now();      // 每次都换 URL，绕开浏览器缓存
}
function tickAge() {
  if (genAt === null) return;
  const s = Math.floor((Date.now() - genAt) / 1000);
  age.textContent = s;
  age.className = s > 115 ? 'stale' : '';
  if (s > 130) hint.textContent = '（这张应该已经过期了，等下一张）';
  else hint.textContent = '';
}
async function poll() {
  try {
    const r = await fetch('/status?t=' + Date.now(), { cache: 'no-store' });
    const j = await r.json();
    if (j.qrMtime) {
      const t = new Date(j.qrMtime).getTime();
      if (t !== genAt) { genAt = t; gen.textContent = new Date(t).toLocaleTimeString(); refresh(); }
    }
    if (j.onebotUp) { ok.classList.add('show'); img.style.opacity = .25; }
  } catch (e) { /* 服务没起来就先忽略 */ }
}
refresh();
poll();
setInterval(poll, 4000);
setInterval(tickAge, 500);
</script>
</body></html>`;

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(PAGE);
    return;
  }

  if (url.pathname === '/qr.png') {
    try {
      const buf = await readFile(QR_PATH);
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store, no-cache, must-revalidate' });
      res.end(buf);
    } catch (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('二维码还没生成');
    }
    return;
  }

  if (url.pathname === '/status') {
    let qrMtime = null;
    try {
      qrMtime = statSync(QR_PATH).mtimeMs;
    } catch {
      /* 还没生成 */
    }
    const onebotUp = await portOpen(3001);
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ qrMtime, onebotUp, now: Date.now() }));
    return;
  }

  res.writeHead(404);
  res.end('not found');
});

// 同 panel-server：QR_NO_LISTEN=1 时只加载不监听，方便自测覆盖
if (process.env.QR_NO_LISTEN === '1') {
  console.log('[qr] 已加载（QR_NO_LISTEN=1，未监听）');
} else {
  server.listen(PORT, HOST, () => {
    console.log(`二维码实时看板已启动：http://${HOST}:${PORT}/`);
    console.log('这个页面每 4 秒自动重取二维码，打开一次就不用管了。');
  });
}
