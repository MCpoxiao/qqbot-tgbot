/**
 * 下载 NapCat 的指定 release 资源。
 * 本机的 curl.exe 与 .NET TLS 是坏的（SEC_E_NO_CREDENTIALS），所以下载也走 Node。
 *
 * 用法：node tools/fetch-napcat.mjs [资源名]
 */
import { createWriteStream, mkdirSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ROOT } from '../src/config.mjs';

const ASSET = process.argv[2] ?? 'NapCat.Shell.zip';
const OUT_DIR = resolve(ROOT, 'napcat');
const OUT_FILE = resolve(OUT_DIR, ASSET);

const MIRRORS = [
  (u) => u,
  (u) => `https://ghfast.top/${u}`,
  (u) => `https://ghproxy.net/${u}`,
  (u) => `https://github.moeyy.xyz/${u}`,
];

async function releaseInfo() {
  const res = await fetch('https://api.github.com/repos/NapNeko/NapCatQQ/releases/latest', {
    headers: { 'user-agent': 'qq-bot-fetch', accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`取 release 失败：HTTP ${res.status}`);
  const j = await res.json();
  const asset = j.assets.find((a) => a.name === ASSET);
  if (!asset) {
    throw new Error(`release ${j.tag_name} 里没有 ${ASSET}；可选：${j.assets.map((a) => a.name).join(', ')}`);
  }
  return { tag: j.tag_name, url: asset.browser_download_url, size: asset.size };
}

async function download(url, dest, expectedSize) {
  const res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'qq-bot-fetch' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  mkdirSync(OUT_DIR, { recursive: true });
  const total = Number(res.headers.get('content-length') ?? expectedSize ?? 0);
  let got = 0;
  let lastPct = -1;
  const body = Readable.fromWeb(res.body);
  body.on('data', (chunk) => {
    got += chunk.length;
    if (total) {
      const pct = Math.floor((got / total) * 100);
      if (pct >= lastPct + 10) {
        lastPct = pct;
        process.stdout.write(`\r  下载中 ${pct}%  ${(got / 1048576).toFixed(1)}MB / ${(total / 1048576).toFixed(1)}MB`);
      }
    }
  });
  await pipeline(body, createWriteStream(dest));
  process.stdout.write('\n');
  return got;
}

async function main() {
  if (existsSync(OUT_FILE) && statSync(OUT_FILE).size > 1024 * 1024) {
    console.log(`已存在，跳过下载：${OUT_FILE} (${(statSync(OUT_FILE).size / 1048576).toFixed(1)}MB)`);
    return;
  }
  const info = await releaseInfo();
  console.log(`NapCat release：${info.tag}`);
  console.log(`目标资源：${ASSET}（${(info.size / 1048576).toFixed(1)}MB）`);

  let lastErr;
  for (const wrap of MIRRORS) {
    const url = wrap(info.url);
    try {
      console.log(`尝试：${url.split('/').slice(0, 3).join('/')} …`);
      const n = await download(url, OUT_FILE, info.size);
      console.log(`✅ 已保存 ${OUT_FILE}（${(n / 1048576).toFixed(1)}MB）`);
      return;
    } catch (err) {
      lastErr = err;
      console.log(`  失败：${err.message}`);
    }
  }
  throw new Error(`所有镜像都失败了，最后一个错误：${lastErr?.message}`);
}

main().catch((err) => {
  console.error(`下载失败：${err.message}`);
  process.exit(1);
});
