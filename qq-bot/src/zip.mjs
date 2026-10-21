/**
 * 极简 ZIP 读取器 + 写入器。
 *
 * 为什么自己写：Node 没有内置 zip 解析，而走 `child_process` 调 PowerShell 的
 * Expand-Archive 在 DSH 沙箱下会因为管道（named pipe）被拒而 EPERM。
 * 自己解反而更可控：能精确限制条数/体积，也能保证解出来的东西不越界。
 *
 * 只支持表情包场景需要的部分：store(0) 与 deflate(8)。
 * 遇到 ZIP64、加密、不认识的压缩方式会**明确报错**，不静默产出坏数据。
 *
 * ⚠️ 2026-10-11 新增**写入**（用户要的「漫画下载 → 压成 zip」）：`makeZip()`。
 * 与读取器同文件、同一个"只做必要的事"的取舍：**不写 ZIP64、不加密、默认 deflate**，
 * 超过 4GB 或 65535 个条目就明确报错（而不是悄悄产出一个坏包）。
 * 自测里让**写入器产出的包被读取器读回来**（同一套 CRC/解压路径），互相印证。
 */
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';
import { extname } from 'node:path';

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;

/**
 * 解开一个 zip。
 * @returns {Array<{name:string, data?:Buffer, error?:string, dir?:boolean}>}
 */
export function readZip(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error('不是有效的 ZIP（文件太短）');

  // EOCD 在文件末尾，后面最多跟 65535 字节的注释，所以从尾部往前扫
  let eocd = -1;
  const lowerBound = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= lowerBound; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('找不到 ZIP 的中央目录结尾标记（EOCD），可能不是 zip 或被截断了');

  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);

  if (cdOffset === 0xffffffff || count === 0xffff) {
    throw new Error('这是 ZIP64 格式，暂不支持；用普通 zip 重新打包即可');
  }
  if (cdOffset + cdSize > buf.length) throw new Error('中央目录越界，压缩包可能已损坏');

  const entries = [];
  let p = cdOffset;

  for (let i = 0; i < count; i += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CD_SIG) {
      entries.push({ name: `#${i + 1}`, error: '中央目录项损坏' });
      break;
    }
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) {
      entries.push({ name, dir: true });
      continue;
    }
    if (flags & 0x1) {
      entries.push({ name, error: '条目被加密，跳过' });
      continue;
    }
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== LFH_SIG) {
      entries.push({ name, error: '本地文件头损坏' });
      continue;
    }

    // 本地头的 name/extra 长度可能与中央目录不同，必须以本地头为准
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const dataEnd = dataStart + compSize;
    if (dataEnd > buf.length) {
      entries.push({ name, error: '数据越界' });
      continue;
    }

    const raw = buf.subarray(dataStart, dataEnd);
    try {
      if (method === 0) entries.push({ name, data: Buffer.from(raw) });
      else if (method === 8) entries.push({ name, data: inflateRawSync(raw) });
      else entries.push({ name, error: `不支持的压缩方式 ${method}` });
    } catch (err) {
      entries.push({ name, error: `解压失败：${err.message}` });
    }
  }

  return entries;
}

/**
 * 从解开的条目里挑出能当表情包用的图片。
 * 顺手做三件事：丢掉目录与 macOS 元数据、只留图片扩展名、
 * **把文件名压成 basename**——压缩包里的 `../../x.png` 不能变成目录穿越。
 */
export function pickImages(entries, allowedExts, { maxFiles = 200, maxBytes = 8 * 1024 * 1024 } = {}) {  const images = [];
  const skipped = [];

  for (const e of entries) {
    if (e.dir) continue;
    if (e.error) {
      skipped.push(`${e.name}（${e.error}）`);
      continue;
    }
    if (e.name.includes('__MACOSX/') || /(^|\/)\._/.test(e.name)) continue; // macOS 的垃圾文件
    const base = e.name.split(/[\\/]/).pop() ?? '';
    if (!base || base.startsWith('.')) continue;
    const ext = extname(base).toLowerCase();
    if (!allowedExts.has(ext)) {
      skipped.push(`${base}（不支持的格式）`);
      continue;
    }
    if (e.data.length > maxBytes) {
      skipped.push(`${base}（超过 ${Math.round(maxBytes / 1048576)}MB）`);
      continue;
    }
    if (images.length >= maxFiles) {
      skipped.push(`（超过 ${maxFiles} 张上限，后面的没导入）`);
      break;
    }
    images.push({ file: base, data: e.data });
  }

  return { images, skipped };
}

/* ============================ 写入 ============================ */

const EOCD_LEN = 22;
const CD_LEN = 46;
const LFH_LEN = 30;
const MAX_ENTRIES = 0xffff;          // 65535：超过就得 ZIP64，这里明确不支持
const MAX_TOTAL = 0xffffffff;        // 4GB 左右

/** DOS 时间/日期（zip 的时间字段就是这两个 16 位值；不填会显示 1980-01-01）。 */
function dosDateTime(d = new Date()) {
  const year = Math.max(1980, d.getFullYear());
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time: time & 0xffff, date: date & 0xffff };
}

/**
 * 打一个 zip（**内存里**拼，调用方拿到 Buffer 再自己落盘 / 直接上传）。
 *
 * @param {Array<{name:string, data:Buffer|string, compress?:boolean}>} entries
 *        `name` 是包内路径（用 `/` 分隔）；`compress` 默认 true（deflate），
 *        已经压过的内容（jpg/png）压不动多少，但也不会变坏 —— 只是白费一点 CPU。
 * @param {{compress?:boolean, now?:Date}} [opts]
 * @returns {Buffer}
 */
export function makeZip(entries, { compress = true, now = new Date() } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  if (!list.length) throw new Error('没有要打包的东西');
  if (list.length > MAX_ENTRIES) throw new Error(`条目太多（${list.length} > ${MAX_ENTRIES}），需要 ZIP64，暂不支持`);

  const { time, date } = dosDateTime(now);
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const e of list) {
    const name = String(e?.name ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!name) throw new Error('有条目没有名字');
    const raw = Buffer.isBuffer(e?.data) ? e.data : Buffer.from(e?.data ?? '');
    const doCompress = (e?.compress ?? compress) && raw.length > 0;
    const body = doCompress ? deflateRawSync(raw) : raw;
    const method = doCompress ? 8 : 0;
    const sum = crc32(raw) >>> 0;
    const nameBuf = Buffer.from(name, 'utf8');

    const lfh = Buffer.alloc(LFH_LEN);
    lfh.writeUInt32LE(LFH_SIG, 0);
    lfh.writeUInt16LE(20, 4);            // version needed
    lfh.writeUInt16LE(0x0800, 6);        // flags：bit11 = 文件名是 UTF-8
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt16LE(time, 10);
    lfh.writeUInt16LE(date, 12);
    lfh.writeUInt32LE(sum, 14);
    lfh.writeUInt32LE(body.length, 18);
    lfh.writeUInt32LE(raw.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);            // extra len
    locals.push(lfh, nameBuf, body);

    const cd = Buffer.alloc(CD_LEN);
    cd.writeUInt32LE(CD_SIG, 0);
    cd.writeUInt16LE(20, 4);             // version made by
    cd.writeUInt16LE(20, 6);             // version needed
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(sum, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);             // extra len
    cd.writeUInt16LE(0, 32);             // comment len
    cd.writeUInt16LE(0, 34);             // disk number
    cd.writeUInt16LE(0, 36);             // internal attrs
    cd.writeUInt32LE(0, 38);             // external attrs
    cd.writeUInt32LE(offset, 42);        // 本地头偏移
    centrals.push(cd, nameBuf);

    offset += LFH_LEN + nameBuf.length + body.length;
  }

  const localPart = Buffer.concat(locals);
  const centralPart = Buffer.concat(centrals);
  if (localPart.length + centralPart.length > MAX_TOTAL) {
    throw new Error('包太大了（超过 4GB），需要 ZIP64，暂不支持');
  }

  const eocd = Buffer.alloc(EOCD_LEN);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4);                      // 本磁盘号
  eocd.writeUInt16LE(0, 6);                      // 中央目录起始磁盘
  eocd.writeUInt16LE(list.length, 8);            // 本磁盘条目数
  eocd.writeUInt16LE(list.length, 10);           // 总条目数
  eocd.writeUInt32LE(centralPart.length, 12);
  eocd.writeUInt32LE(localPart.length, 16);      // 中央目录偏移 = 本地部分长度
  eocd.writeUInt16LE(0, 20);                     // 注释长度

  return Buffer.concat([localPart, centralPart, eocd]);
}
