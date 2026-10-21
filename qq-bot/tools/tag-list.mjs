/**
 * 生成**标签清单**（2026-10-10 用户：「把有什么标签、哪些实测过给我」）。
 *
 * 单一数据源 = 代码本身（词表）+ **真机实测结果**（探针写出的 JSON）。
 * 手写清单一定会和代码/证据脱节 —— 这个项目已经吃过好几次"文档说做了、代码没做"的账。
 *
 * ## "实测"的证据链
 *
 * 1. `archive/2026-10-10-r18三修/probes/probe-tag-vocab.mjs`
 *    抽查 5 个词（颜射/臀部/口内射精/精液 + 老词白丝回归），带命中数。
 * 2. `archive/2026-10-10-r18三修/probes/probe-vocab-sweep.mjs` **全表 174 组逐个真搜**：
 *    每组先搜 `胡桃 <首选写法>`，0 条再单独搜 `<首选写法>`，并插**对照组**（只搜「胡桃」）；
 *    对照组挂了就中止（否则会把网络故障当成"这个词没用"）。
 *    → `evidence/vocab-sweep-results.json`（本文件读它）
 *    · `strong` = 组合就有图（强证据：这个角色的图真在用这个词）
 *    · `valid`  = 组合 0、单独有图（标签本身有效，只是"胡桃 + 它"暂时没有作品）
 *    · `suspicious` = 两处都 0（写法可疑，要换或删）
 *    ⚠️ 每次只取 `count=5`，所以"命中 5 条"= **≥5 条**（不是精确值）。
 *
 * 跑法（工作区根目录）：`node qq-bot/tools/tag-list.mjs [输出路径]`
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { LOCAL_KNOWN_TAGS } from '../src/pixiv.mjs';
import { ADULT_TAG_GROUPS, ADULT_KNOWN_TAGS, searchTagFor } from '../src/pixiv-tags.mjs';

const OUT = process.argv[2] ?? 'qq-bot/标签清单.md';

/** 抽查那 5 个（人工输入，必须有出处）。 */
const VERIFIED = {
  颜射: { search: '胡桃 顔射', hits: 20, r18: 18, at: '2026-10-10 14:1x', src: 'probe-tag-vocab.mjs' },
  臀部: { search: '胡桃 お尻', hits: 20, r18: 13, at: '2026-10-10 14:1x', src: 'probe-tag-vocab.mjs' },
  口内射精: { search: '胡桃 口内射精', hits: 20, r18: 20, at: '2026-10-10 14:1x', src: 'probe-tag-vocab.mjs' },
  精液: { search: '胡桃 精液', hits: 20, r18: 20, at: '2026-10-10 14:1x', src: 'probe-tag-vocab.mjs' },
  白丝: { search: '白丝 白丝', hits: 20, r18: 15, at: '2026-10-10 14:1x', src: 'probe-tag-vocab.mjs（老词回归）' },
};

/** 全表扫描结果（第二次、也是正式的那次）。 */
const SWEEP_URL = new URL('../../archive/2026-10-10-r18三修/evidence/vocab-sweep-results.json', import.meta.url);
let sweep = null;
if (existsSync(SWEEP_URL)) {
  try {
    sweep = JSON.parse(readFileSync(SWEEP_URL, 'utf8'));
  } catch (err) {
    console.log(`⚠️ 全表结果读不出来（${err.message}）—— 清单里只能标"没实测"`);
  }
}
const SWEEP_BY_FORM = new Map();
for (const row of sweep?.rows ?? []) SWEEP_BY_FORM.set(row.form, row);

/** 从源码里把分组注释（`/* ── 分类 ── *​/`）抠出来，让清单也带分类。 */
function sectionsFromSource() {
  const src = readFileSync(new URL('../src/pixiv-tags.mjs', import.meta.url), 'utf8').split('\n');
  const out = [];
  let section = '（未分类）';
  for (const line of src) {
    // ⚠️ 只数到 ADULT_TAG_GROUPS 用完为止 —— 文件里**后面还有** `WORK_TAG_GROUPS`，
    //    它每一行也以 `['` 开头；不设这个上限就会把作品名那些组也算进来、分类整体错位
    //    （2026-10-10 17:3x 实测：源码数到 196 组、实际 183 组）。
    if (out.length >= ADULT_TAG_GROUPS.length) break;
    const m = line.match(/\/\*[^\n]*──\s*([^─]+?)\s*──/);
    if (m) {
      section = m[1].replace(/（.*?）|\(.*?\)/g, '').trim() || section;
      continue;
    }
    if (/^\s*\[\s*'/.test(line)) out.push(section);
  }
  return out;
}

const sections = sectionsFromSource();
const sectionOf = (i) => sections[i] ?? '（未分类）';

/** 这一组实测到没有：返回 `{ mark, text }`。 */
function testedOf(form) {
  const row = SWEEP_BY_FORM.get(form);
  if (row) {
    if (row.verdict === 'strong') return { mark: '✅', text: `组合 ${row.combined} 条` };
    if (row.verdict === 'valid') return { mark: '○', text: `单独 ${row.solo} 条` };
    if (row.verdict === 'suspicious') return { mark: '✗', text: '两处都 0' };
    return { mark: '？', text: '网络中断未判定' };
  }
  if (VERIFIED[form]) return { mark: '✅', text: `${VERIFIED[form].hits} 条（抽查）` };
  return { mark: '—', text: '未实测' };
}

const sweepRows = sweep?.rows ?? [];
const strong = sweepRows.filter((r) => r.verdict === 'strong');
const valid = sweepRows.filter((r) => r.verdict === 'valid');
const suspicious = sweepRows.filter((r) => r.verdict === 'suspicious');
const testedForms = ADULT_TAG_GROUPS.map((g) => g[0]).filter((f) => SWEEP_BY_FORM.has(f));

const lines = [];
lines.push('# 标签清单（小笛 · 找图）');
lines.push('');
lines.push('> 本文件由 `qq-bot/tools/tag-list.mjs` 生成（**别手改**；改词表或跑完探针后重跑即可）。');
lines.push(`> 生成时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
lines.push('');
lines.push('## 概览');
lines.push('');
lines.push('| 项 | 数量 |');
lines.push('| --- | --- |');
lines.push(`| 老词表 \`LOCAL_KNOWN_TAGS\`（2026-10-10 之前就在用的） | ${LOCAL_KNOWN_TAGS.length} |`);
lines.push(`| R-18 题材词表 \`ADULT_TAG_GROUPS\` | ${ADULT_TAG_GROUPS.length} 组 / ${ADULT_KNOWN_TAGS.length} 个写法 |`);
lines.push(`| **题材词表里真机搜过的组** | **${testedForms.length} / ${ADULT_TAG_GROUPS.length}** |`);
lines.push('');
if (sweep) {
  lines.push(`**全表实测结论**（${String(sweep.at ?? '').slice(0, 16)}，对照组 = 只搜「胡桃」）：`);
  lines.push('');
  lines.push('| 判定 | 组数 | 含义 |');
  lines.push('| --- | --- | --- |');
  lines.push(`| ✅ 强证据 | ${strong.length} | 跟角色组合搜就有图 → 这个词确实被这个角色的作品在用 |`);
  lines.push(`| ○ 标签有效 | ${valid.length} | 组合 0 条、单独搜有图 → 标签本身没问题，只是"胡桃 + 它"暂时没有作品 |`);
  lines.push(`| ✗ 可疑写法 | ${suspicious.length} | 两处都 0 → 要换写法或删（**这次是 0**） |`);
  lines.push('');
  const ones = sweepRows.filter((r) => r.combined === 1).map((r) => r.form);
  const minHits = Math.min(...sweepRows.filter((r) => r.combined > 0).map((r) => r.combined));
  lines.push(`- **命中最少**：组合搜索最少的一次是 **${minHits} 条**（${ones.join(' / ')}）；其余多为 ${Math.max(...sweepRows.map((r) => r.combined))} 条。`);
  lines.push('- ⚠️ 每次只取 `count=5`，所以"5 条"= **≥5 条**，不是精确条数。');
  if (valid.length) {
    lines.push(`- ○ 那 ${valid.length} 个（组合为 0、单独有图）：${valid.map((r) => r.form).join(' / ')}`);
  }
  lines.push('');
}
lines.push('**"实测"的定义**：真的在 pixiv 上搜过一次、看回了几条（探针在 `archive/2026-10-10-r18三修/probes/`）。');
lines.push('没标 `✅/○` 的**不代表不能用**，只代表没有真机证据；它们过了结构性检查：');
lines.push('裸词认得出来 / 搜索写法=组内第一项 / 与老表不相交 / 同写法不重复 / 不含未成年标签。');
lines.push('');

lines.push('## 抽查（带 R-18 条数的细账）');
lines.push('');
lines.push('| 用户可能写的词 | 实际搜索词 | 命中 | 其中 R-18 | 时间 | 出处 |');
lines.push('| --- | --- | --- | --- | --- | --- |');
for (const [k, v] of Object.entries(VERIFIED)) {
  lines.push(`| ${k} | \`${v.search}\` | ${v.hits} 条 | ${v.r18} 条 | ${v.at} | \`${v.src}\` |`);
}
lines.push('');

lines.push(`## R-18 题材词表（${ADULT_TAG_GROUPS.length} 组）`);
lines.push('');
lines.push('> 一组 = 同义词。**第一个是搜出去用的写法**，其余用于识别中文/英文写法和比对作品标签。');
lines.push('> 实测列：`✅ 组合 N 条` = 跟「胡桃」组合就有图；`○ 单独 N 条` = 只单独搜有图；`—` = 没实测。');
lines.push('');
let lastSection = '';
ADULT_TAG_GROUPS.forEach((group, i) => {
  const sec = sectionOf(i);
  if (sec !== lastSection) {
    lines.push('');
    lines.push(`### ${sec}`);
    lines.push('');
    lines.push('| # | 搜索写法 | 同义写法（识别+匹配用） | 实测 |');
    lines.push('| --- | --- | --- | --- |');
    lastSection = sec;
  }
  const t = testedOf(group[0]);
  const aliases = group.slice(1).join(' / ') || '—';
  lines.push(`| ${i + 1} | \`${searchTagFor(group[0])}\` | ${aliases} | ${t.mark} ${t.text} |`);
});
lines.push('');

lines.push(`## 老词表（${LOCAL_KNOWN_TAGS.length} 个，2026-10-10 之前就在用）`);
lines.push('');
lines.push('> 这一批**原样未动**（只按用户要求恢复/保留过其中的词）；只有"白丝"做过真机回归。');
lines.push('> 同一批里的词若**同时出现在题材词表**里会破坏老行为，所以自测断言钉着"两表不相交"。');
lines.push('');
for (let i = 0; i < LOCAL_KNOWN_TAGS.length; i += 8) {
  const row = LOCAL_KNOWN_TAGS.slice(i, i + 8)
    .map((t) => (VERIFIED[t] ? `**${t}** ✅` : t))
    .join(' · ');
  lines.push(`- ${row}`);
}
lines.push('');
lines.push('## 边界（2026-10-10 用户拍板，写进断言了）');
lines.push('');
lines.push('- **不收**以未成年人为对象的性化标签：`幼女/幼児/幼児退行/幼児体型/ロリ/ロリコン/ロリ巨乳/ロリ体型/');
lines.push('  ぺド/ペド/JS/JC/JK娘/児童/ちびっ子/ラブリーロリ` —— 加进去自测会红。');
lines.push('  （老词表里的 `幼女/萝莉/正太` 是**他原有的词**，按他要求保留，不属于"我新增"。）');
lines.push('- **兽耳类与兽尾保留**（`兽耳/猫耳/兔耳/狐耳/犬耳`、`尻尾/尾巴/しっぽ`）；**人外与兽人/怪物已删**（`人外/異種姦/モンスター娘/オーク/ゴブリン`）。');
lines.push('- **纯体型词加、含 `ロリ/幼女/JS/JC/ロリコン` 的词不加**；**反义词不许同组**（同组=同义）。');
lines.push('- 技术事实：词表只管「**裸词**认不认」——`【】` 里写什么都算标签，不受词表校验。');
lines.push('');

writeFileSync(OUT, lines.join('\n'), 'utf8');
console.log(`已写出 ${OUT}`);
console.log(`  老词表 ${LOCAL_KNOWN_TAGS.length}；题材词表 ${ADULT_TAG_GROUPS.length} 组 / ${ADULT_KNOWN_TAGS.length} 写法`);
console.log(
  `  全表实测：✅ ${strong.length} / ○ ${valid.length} / ✗ ${suspicious.length}` +
    (sweep ? `（结果文件：${sweep.at?.slice(0, 16)}）` : '（没找到全表结果文件）'),
);
if (sections.length !== ADULT_TAG_GROUPS.length) {
  console.log(`  ⚠️ 分类解析对不上（源码里数到 ${sections.length} 组、实际 ${ADULT_TAG_GROUPS.length} 组）—— 分类可能错位`);
}
