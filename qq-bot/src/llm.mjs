import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { describeBackend, ROOT } from './config.mjs';
import { TOOL_DEFS, execTool } from './tools.mjs';

export { describeBackend };

/**
 * **请求体的公共部分**（2026-10-12 加，起因是用户报「模型返回空内容」+「输出不完整」）。
 *
 * ## 为什么要显式关掉思考
 * `deepseek-flash` **默认开思考**（官方价格页：支持非思考与思考模式（默认）），
 * 而**思考 token 和正文共用同一个输出预算**。2026-10-12 实测四种情况：
 *
 * | 调用 | 可见正文 | 思考 | finish_reason | 耗时 |
 * | --- | --- | --- | --- | --- |
 * | 默认 | 36 字 | **452 字 / 292 tokens** | stop | 3575ms |
 * | `thinking:{type:'disabled'}` | 25 字 | 0 | stop | **962ms** |
 * | 默认 + `max_tokens:30` | **0 字（空！）** | 58 字（吃光预算） | **length** | 681ms |
 * | 关思考 + `max_tokens:30` | 46 字 | 0 | stop | 1162ms |
 *
 * ⇒ 预算被思考吃掉时**正文一个字都不剩**（当天日志里 3 次「模型返回了空内容」、
 * 1 次写半句就断 —— 都在换上 `deepseek-flash` 之后；10-06~10-11 用 `deepseek-chat`
 * 的 1337 条回复里一次都没有）。关掉思考后**快 4 倍、输出 token 省约 90%**。
 * 她的人设本来也不需要长推理 ⇒ 默认 `disabled`（要开回思考：config 里 `thinking:'enabled'`）。
 *
 * ⚠️ **必须放在模块顶层**：第一版我把它插在 `createToolChat` 函数体内，
 * 结果 `createLLM` 那条路调用时报 `baseParams is not defined`（函数作用域看不见）。
 */
function baseParams(cfg, extra = {}) {
  const ds = cfg.llm.deepseek;
  const thinking = String(ds.thinking ?? 'disabled');
  return { thinking: { type: thinking === 'enabled' ? 'enabled' : 'disabled' }, ...extra };
}

/**
 * 空正文 = 这次调用没产出（多半是预算被思考吃光 / 被截断）→ **抛错，交给 `withRetry` 重试**。
 *
 * 这一步很关键：它让"HTTP 200 但内容是空的"这种**假成功**也走重试，
 * 而不是把空字符串当成正常回复发出去（2026-10-12 就是这样回了 3 次"（模型返回了空内容）"）。
 *
 * ⚠️ **两种情况必须放过**（否则会把正常流程当成失败）：
 *   ① **模型这一轮是在请求调工具**（`tool_calls` 有内容、正文本来就空）—— 自测当场抓到过这个误杀；
 *   ② 已经有可用的正文（自然通过）。
 * 抛出的错要标 `retryable`，因为 `withRetry` 只重试标了可重试的错误（不标就等于不重试，自测也抓到过）。
 */
function assertNotEmpty(text, data, log) {
  const t = String(text ?? '').trim();
  if (t) return t;
  // ① 这一轮是"要调工具"，正文空是正常的
  const msg = data?.choices?.[0]?.message;
  if (Array.isArray(msg?.tool_calls) && msg.tool_calls.length) return '';
  const fin = data?.choices?.[0]?.finish_reason;
  const rt = data?.usage?.completion_tokens_details?.reasoning_tokens;
  log?.warn?.(`模型返回了空内容（finish_reason=${fin}${rt ? `，思考用了 ${rt} tokens` : ''}）→ 重试`);
  const err = new Error(`模型返回空内容（finish_reason=${fin}）`);
  err.retryable = true; // ← 不标这个，withRetry 一次就放弃（自测抓到过）
  throw err;
}

/**
 * 带工具调用的对话 —— 这是"让它真的能做事"的那一层。
 *
 * 循环：把工具声明一起发给模型 → 它要么直接回话、要么要求调工具 →
 * 我们执行、把结果塞回对话 → 再问一轮。最多 maxRounds 轮，防止它无限调下去。
 *
 * `callModel` 可以注入（自测里塞一个假的），所以**整条循环逻辑不联网就能测**——
 * 不然"工具会不会被真的执行"只能靠真去问一次天气来验。
 */
export function createToolChat(cfg, { callModel, log = console, maxAttempts = 3 } = {}) {
  const invoke =
    callModel ??
    ((body) =>
      postJson(`${cfg.llm.deepseek.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        timeoutMs: cfg.llm.timeoutMs ?? 60000,
        headers: { authorization: `Bearer ${readApiKey(cfg.llm.deepseek)}` },
        body,
      }));

  return async function run({ system, messages, tools = TOOL_DEFS, maxRounds = 4, onToolCall, toolContext = null }) {
    const convo = system ? [{ role: 'system', content: system }, ...messages] : [...messages];
    const transcript = [];
    let lastText = '';

    for (let round = 0; round < maxRounds; round += 1) {
      /**
       * ⚠️ **重试包在"调用处"，而不是包在默认实现里**（2026-10-11，被自测抓到）：
       * 第一版把 `withRetry` 写在 `invoke` 的默认分支里，结果**注入进来的 `callModel` 绕过了重试**——
       * 那等于"测试里没有重试、生产里才有"，而且以后谁注入一个真实模型调用也会静默丢掉重试。
       * 现在无论走默认还是注入，都过同一套策略。
       */
      const data = await withRetry(
        () =>
          invoke({
            model: cfg.llm.deepseek.model,
            messages: convo,
            tools,
            tool_choice: 'auto',
            ...baseParams(cfg, {
              temperature: cfg.llm.deepseek.temperature,
              max_tokens: cfg.llm.deepseek.maxTokens,
              stream: false,
            }),
          }).then((d) => {
            // ⚠️ **空正文要当失败**：`withRetry` 只重试"抛错"，而空内容是 HTTP 200 的"成功" ✗
            assertNotEmpty(d?.choices?.[0]?.message?.content, d, log);
            return d;
          }),
        { maxAttempts, log, label: '工具对话' },
      );

      const msg = data?.choices?.[0]?.message;
      if (!msg) throw new Error('模型没有返回 message');
      lastText = String(msg.content ?? '').trim();

      const calls = msg.tool_calls ?? [];
      if (calls.length === 0) {
        return { text: lastText, transcript, rounds: round + 1, usage: data?.usage ?? null };
      }

      // 助手这一轮（含 tool_calls）要放回对话，否则工具结果没有对应的调用 ID
      convo.push({ role: 'assistant', content: msg.content ?? '', tool_calls: calls });

      for (const c of calls) {
        const name = c.function?.name;
        let args = {};
        try {
          args = JSON.parse(c.function?.arguments || '{}');
        } catch {
          args = {}; // 模型给的参数不是合法 JSON 时按空参处理，别把这条弄崩
        }
        // 控制类工具要靠 toolContext 过闸（谁发的、是不是私聊、拿哪份配置）；
        // 上下文由 bot.mjs 从 OneBot 事件里现算，模型看不到也改不了它。
        const result = await execTool(name, args, toolContext);
        transcript.push({ name, args, result });
        onToolCall?.({ name, args, result });
        log.info?.(`[tool] ${name}(${JSON.stringify(args)}) -> ${String(result).replace(/\n/g, ' ').slice(0, 120)}`);
        convo.push({ role: 'tool', tool_call_id: c.id, content: result });
      }
    }

    // 轮数用完它还在调工具。
    //
    // **千万别把"轮数用完了"这句内部话发给用户**——真实踩过：问一个真实存在的梗，
    // 它连搜 4 轮（Bing 老返回字典页），用户收到「（工具调用轮数用完了，没得出结论）」。
    // 正确做法是**再问一次、这次不给工具**，让它用手上已有的信息作答——
    // 把"失败"降级成"能答多少答多少"。
    const asked = [...convo];
    const sysAt = asked.findIndex((m) => m.role === 'system');
    const guard =
      '\n\n【重要】工具调用次数已用完：现在**只根据上面已经拿到的信息**回答用户，' +
      '不要再请求调用任何工具。查不到就老实说查不到，别编。';
    if (sysAt >= 0) asked[sysAt] = { ...asked[sysAt], content: asked[sysAt].content + guard };
    else asked.unshift({ role: 'system', content: guard.trim() });

    try {
      const data = await invoke({
        model: cfg.llm.deepseek.model,
        messages: asked,
        ...baseParams(cfg, {
          temperature: cfg.llm.deepseek.temperature,
          max_tokens: cfg.llm.deepseek.maxTokens,
          stream: false,
        }),
      });
      const text = String(data?.choices?.[0]?.message?.content ?? '').trim();
      if (text) return { text, transcript, rounds: maxRounds, exhausted: true, usage: data?.usage ?? null };
    } catch (err) {
      log.warn?.(`工具轮数用完后的兜底回答也失败了：${err.message}`);
    }

    return {
      text: lastText || '我搜了半天没搜着，你换个说法再问我一次吧。',
      transcript,
      rounds: maxRounds,
      exhausted: true,
      usage: null,
    };
  };
}

/**
 * 取密钥：环境变量优先，读不到再试文件。
 * 每次请求都重读，所以往文件里写密钥**不需要重启机器人**。
 * 只返回密钥本身，绝不回显、绝不写日志。
 */
function readApiKey(cfg) {
  const envName = cfg.apiKeyEnv ?? 'DEEPSEEK_API_KEY';
  const fromEnv = process.env[envName];
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();

  const file = cfg.apiKeyFile;
  if (file) {
    const path = isAbsolute(file) ? file : resolve(ROOT, file);
    try {
      const text = readFileSync(path, 'utf8').trim();
      if (text) return text;
    } catch {
      /* 文件不存在就当作没配 */
    }
  }
  return '';
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

async function postJson(url, { headers, body, timeoutMs }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
      err.status = res.status;
      err.retryable = RETRYABLE_STATUS.has(res.status);
      throw err;
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`返回的不是 JSON：${text.slice(0, 200)}`);
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      const e = new Error(`请求超时（${timeoutMs}ms）`);
      e.retryable = true;
      throw e;
    }
    if (err.retryable === undefined) err.retryable = true; // 网络层错误一般可重试
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * **统一的重试策略**（2026-10-11 抽出来，起因是一次真实的丢回复）：
 *
 * 那天 18:30 有一条私聊，日志只有一行 `生成回复失败：fetch failed`，
 * **没有任何重试记录** —— 查下来是：普通对话走 `createLLM`（有 3 次重试 ✓），
 * 而**工具对话**（`createToolChat`，默认开着工具时走的就是它）里的 `invoke` 是**直接 postJson**，
 * **一次都没重试** ✗。于是一次网络抖动就把整条回复丢了（用户只收到「我这边出了点问题」）。
 *
 * 判据沿用 `postJson` 打好的 `err.retryable`：网络层错误、超时、408/429/5xx 都可重试；
 * 4xx 里的"你请求本身有问题"（401/403/400）**不重试**（重试只会浪费时间、还可能触发风控）。
 */
export async function withRetry(fn, { maxAttempts = 3, log = console, label = 'llm' } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= Math.max(1, Number(maxAttempts) || 1); attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!err?.retryable || attempt >= maxAttempts) break;
      const wait = Math.min(1000 * 2 ** (attempt - 1), 8000);
      log.warn?.(`[llm] ${label} 第 ${attempt} 次失败（${err.message}），${wait}ms 后重试`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

/**
 * 视觉调用：把一张图交给模型看。
 *
 * **实测结论**：DeepSeek 的 chat API 虽然对外只宣传文本，但传 `image_url`（data: URL）
 * 能正确识别图片内容——实测三张不同的图能分别读出对应文字、能答出背景色与圆角形状，
 * 而 1×1 纯色图会被如实描述为「纯色、没有图案」。
 * 成本也低：一张 240×240 的图约占 190 个 prompt token。
 *
 * 所以打标签不需要额外装本地视觉模型。
 */
export async function askWithImage(
  cfg,
  { prompt, system, imageBase64, mime = 'image/png', maxTokens = 80, temperature = 0.2 },
) {
  const ds = cfg.llm.deepseek;
  const key = readApiKey(ds);
  if (!key) throw new Error(`没找到 DeepSeek 密钥（$${ds.apiKeyEnv} 或 ${ds.apiKeyFile}）`);

  const userContent = [
    { type: 'text', text: prompt },
    { type: 'image_url', image_url: { url: `data:${mime};base64,${imageBase64}` } },
  ];
  const messages = system
    ? [{ role: 'system', content: system }, { role: 'user', content: userContent }]
    : [{ role: 'user', content: userContent }];

  const data = await postJson(`${ds.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    timeoutMs: cfg.llm.timeoutMs ?? 60000,
    headers: { authorization: `Bearer ${key}` },
    // ⚠️ 识图也带"关思考"：2026-10-12 那天两次识图失败，一次是 60 秒超时（已用缩图解决），
    //    一次是**模型返回空内容** —— 后者同样是思考把预算吃光（`baseParams` 里有实测表）。
    body: { model: ds.model, messages, ...baseParams(cfg, { max_tokens: maxTokens, temperature, stream: false }) },
  });
  assertNotEmpty(data?.choices?.[0]?.message?.content, data, null);

  return {
    text: data?.choices?.[0]?.message?.content ?? '',
    usage: data?.usage ?? null,
    model: data?.model ?? ds.model,
  };
}

/**
 * 统一的模型层。对外只有两个方法：
 *   chat({ system, messages }) -> { text, usage, provider, model }
 *   healthCheck() -> { ok, detail }
 *
 * 换后端只需要改 config.llm.provider，上层业务逻辑不用动。
 */
export function createLLM(cfg, { log = console, maxAttempts = 3 } = {}) {
  // 注意：provider 与超时都在**调用时**读，不在创建时读死。
  // 这样控制面板把 llm.provider 从 echo 切成 deepseek 之后，立刻生效，不用重启。
  const timeout = () => cfg.llm.timeoutMs ?? 60000;

  async function callDeepseek({ system, messages }) {
    const key = readApiKey(cfg.llm.deepseek);
    if (!key) {
      throw new Error(
        `没找到 DeepSeek 密钥：环境变量 ${cfg.llm.deepseek.apiKeyEnv} 与文件 ${cfg.llm.deepseek.apiKeyFile} 都是空的`,
      );
    }
    const url = `${cfg.llm.deepseek.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const data = await postJson(url, {
      timeoutMs: timeout(),
      headers: { authorization: `Bearer ${key}` },
      body: {
        model: cfg.llm.deepseek.model,
        messages: [{ role: 'system', content: system }, ...messages],
        // ⚠️ 带上"关思考"（见 `baseParams` 的说明）—— 这里是**主对话那条路**，
        //    2026-10-12 那 3 次「模型返回了空内容」就是它发出来的。
        ...baseParams(cfg, {
          temperature: cfg.llm.deepseek.temperature,
          max_tokens: cfg.llm.deepseek.maxTokens,
          stream: false,
        }),
      },
    });
    // 空正文当失败（抛错 → 上层的 withRetry 会重试）
    assertNotEmpty(data?.choices?.[0]?.message?.content, data, log);
    return {
      text: data?.choices?.[0]?.message?.content ?? '',
      usage: data?.usage ?? null,
      model: data?.model ?? cfg.llm.deepseek.model,
    };
  }

  async function callOllama({ system, messages }) {
    const url = `${cfg.llm.ollama.baseUrl.replace(/\/+$/, '')}/api/chat`;
    const data = await postJson(url, {
      timeoutMs: timeout(),
      headers: {},
      body: {
        model: cfg.llm.ollama.model,
        messages: [{ role: 'system', content: system }, ...messages],
        stream: false,
        options: {
          temperature: cfg.llm.ollama.temperature,
          num_predict: cfg.llm.ollama.numPredict,
        },
      },
    });
    return {
      text: data?.message?.content ?? '',
      usage: data?.eval_count ? { completion_tokens: data.eval_count } : null,
      model: data?.model ?? cfg.llm.ollama.model,
    };
  }

  async function callEcho({ messages }) {
    const last = messages.at(-1)?.content ?? '';
    return { text: `[echo] 收到：${last}`, usage: null, model: 'echo' };
  }

  const impls = { deepseek: callDeepseek, ollama: callOllama, echo: callEcho };

  return {
    get provider() {
      return cfg.llm.provider;
    },
    describe: () => describeBackend(cfg),
    async chat({ system = cfg.llm.system, messages }) {
      const impl = impls[cfg.llm.provider];
      if (!impl) throw new Error(`未知的 llm.provider: ${cfg.llm.provider}`);
      // 与工具对话共用同一套重试策略（判据/退避/日志都在 withRetry 里）
      const out = await withRetry(() => impl({ system, messages }), { maxAttempts, log, label: '对话' });
      return { ...out, provider: cfg.llm.provider };
    },
    /** 只发一句最短的话，验证后端真的通。 */
    async healthCheck() {
      try {
        const r = await this.chat({ messages: [{ role: 'user', content: '只回复两个字：在的' }] });
        return { ok: true, detail: `${r.provider}/${r.model} -> ${r.text.trim().slice(0, 40)}` };
      } catch (err) {
        return { ok: false, detail: err.message };
      }
    },
  };
}
