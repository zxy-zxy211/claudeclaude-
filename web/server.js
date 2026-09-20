#!/usr/bin/env node
/**
 * 银柴火·编导 AI 工作台
 * 零依赖本地服务：静态站点 + 豆包（火山方舟）接口代理 + 博主卡读写。
 * 提示词不在这里硬编码，统一从 .claude/skills/ 读，网页和 Claude 技能同源。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(__dirname, 'public');
const SKILLS = path.join(ROOT, '.claude', 'skills');
const BLOGGERS = path.join(ROOT, 'bloggers');

loadEnv(path.join(ROOT, '.env'));
loadEnv(path.join(__dirname, '.env'));

const PORT = Number(process.env.PORT || 5173);
const ARK_BASE = (process.env.ARK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3').replace(/\/$/, '');
const ARK_MODEL = process.env.ARK_MODEL || '';

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

/* ---------- 提示词：从技能文件拼 ---------- */

function stripFrontmatter(md) {
  return md.startsWith('---') ? md.replace(/^---[\s\S]*?\n---\n?/, '') : md;
}

function readSkill(name, withRefs) {
  const dir = path.join(SKILLS, name);
  const file = path.join(dir, 'SKILL.md');
  if (!fs.existsSync(file)) return '';
  let out = stripFrontmatter(fs.readFileSync(file, 'utf8')).trim();
  const refDir = path.join(dir, 'references');
  if (withRefs && fs.existsSync(refDir)) {
    for (const f of fs.readdirSync(refDir).filter((f) => f.endsWith('.md')).sort()) {
      out += `\n\n---\n\n# 附：${f}\n\n${fs.readFileSync(path.join(refDir, f), 'utf8').trim()}`;
    }
  }
  return out;
}

const WEB_NOTE = [
  '',
  '---',
  '',
  '# 运行环境补充（网页工作台）',
  '- 你在网页工作台里跑，不能读写文件。需要落库时，直接把要存档的内容完整输出，由本人复制。',
  '- 用中文回答。输出用 Markdown，表格就用 Markdown 表格。',
  '- 到⛔确认关必须停下等本人确认，不许自己往下写。',
].join('\n');

function buildPrompts() {
  return {
    card: { title: '博主建档', skill: 'blogger-card', system: readSkill('blogger-card', false) + WEB_NOTE },
    draft: { title: '新稿生产', skill: 'script-draft', system: readSkill('script-draft', true) + WEB_NOTE },
    revise: { title: '内容修改', skill: 'script-revise', system: readSkill('script-revise', false) + WEB_NOTE },
  };
}

/* ---------- 工具 ---------- */

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8', '.ico': 'image/x-icon', '.bcmap': 'application/octet-stream', '.txt': 'text/plain; charset=utf-8' };

function json(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(s) });
  res.end(s);
}

function readBody(req, limitMb = 40) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limitMb * 1024 * 1024) { reject(new Error('请求体过大（>' + limitMb + 'MB）')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (e) { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

function safeName(name) {
  const base = path.basename(String(name || '').replace(/\.md$/i, '')).replace(/[\\/:*?"<>|]/g, '').trim();
  if (!base || base.startsWith('.')) throw new Error('文件名不合法');
  return base + '.md';
}

/* ---------- 博主卡 ---------- */

function listBloggers() {
  if (!fs.existsSync(BLOGGERS)) return [];
  return fs.readdirSync(BLOGGERS)
    .filter((f) => f.endsWith('.md') && f !== 'README.md')
    .map((f) => ({
      name: f.replace(/\.md$/, ''),
      template: f.startsWith('_'),
      content: fs.readFileSync(path.join(BLOGGERS, f), 'utf8'),
      updated: fs.statSync(path.join(BLOGGERS, f)).mtime.toISOString(),
    }))
    .sort((a, b) => Number(a.template) - Number(b.template) || a.name.localeCompare(b.name, 'zh'));
}


/* ---------- 文档解析：docx / pptx（自己解 zip，不装依赖） ---------- */

const zlib = require('zlib');

/** 按名字条件取出 zip 里的文件，返回 [{name, data}] */
function unzip(buf, match) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 70000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('文件打不开（不是有效的 docx/pptx）');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count && off + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    if (match(name)) {
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const start = localOff + 30 + lNameLen + lExtraLen;
      const raw = buf.subarray(start, start + compSize);
      try {
        out.push({ name, data: method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw) });
      } catch (e) {
        // 单个条目解不开就跳过，别让整份文件失败
      }
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function xmlToText(xml, paraTag) {
  return xml
    .replace(new RegExp(`<${paraTag}[^>]*/>`, 'g'), '\n')
    .replace(new RegExp(`</${paraTag}>`, 'g'), '\n')
    .replace(/<(w|a):tab[^>]*\/>/g, '\t')
    .replace(/<(w|a):br[^>]*\/>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function docToText(name, buf) {
  const ext = (name.match(/\.([a-z0-9]+)$/i) || [, ''])[1].toLowerCase();
  if (ext === 'docx') {
    const parts = unzip(buf, (n) => n === 'word/document.xml');
    if (!parts.length) throw new Error('这份 .docx 里没找到正文');
    return xmlToText(parts[0].data.toString('utf8'), 'w:p');
  }
  if (ext === 'pptx') {
    const slides = unzip(buf, (n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a, b) => Number(a.name.match(/\d+/)[0]) - Number(b.name.match(/\d+/)[0]));
    if (!slides.length) throw new Error('这份 .pptx 里没找到幻灯片');
    return slides.map((s, i) => `【第 ${i + 1} 页】\n${xmlToText(s.data.toString('utf8'), 'a:p')}`).join('\n\n');
  }
  throw new Error('只认 .docx 和 .pptx（老的 .doc/.ppt 请先另存为新格式）');
}

/* ---------- 豆包代理 ---------- */

async function proxyChat(req, res, body) {
  const key = req.headers['x-ark-key'] || process.env.ARK_API_KEY;
  if (!key) return json(res, 400, { error: '没有 API Key：在 web/.env 里设 ARK_API_KEY，或在网页「设置」里填。' });
  const model = body.model || ARK_MODEL;
  if (!model) return json(res, 400, { error: '没有模型：在 web/.env 里设 ARK_MODEL（模型名或 ep- 接入点 ID），或在「设置」里填。' });

  const payload = {
    model,
    messages: body.messages || [],
    stream: true,
    temperature: typeof body.temperature === 'number' ? body.temperature : 0.8,
  };
  if (body.max_tokens) payload.max_tokens = body.max_tokens;
  if (body.thinking) payload.thinking = body.thinking;

  let upstream;
  try {
    upstream = await fetch(`${ARK_BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    return json(res, 502, { error: '连不上方舟接口：' + e.message });
  }

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => '');
    const hint =
      upstream.status === 401 || upstream.status === 403
        ? 'API Key 不对或没权限：回控制台把 Key 重新复制一遍（别漏字符），确认用的是方舟的 Key。'
        : upstream.status === 404
          ? `找不到模型「${model}」：确认这个模型在控制台已开通，或改用 ep- 开头的接入点 ID。`
          : upstream.status === 429
            ? '调用太频繁或额度用完了：等一下再试，或去控制台看额度。'
            : `方舟返回 ${upstream.status}`;
    return json(res, upstream.status, { error: hint, detail: text.slice(0, 2000) });
  }

  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  const reader = upstream.body.getReader();
  req.on('close', () => reader.cancel().catch(() => {}));
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  } catch (e) {
    res.write(`\ndata: ${JSON.stringify({ error: '流中断：' + e.message })}\n\n`);
  }
  res.end();
}

/* ---------- 路由 ---------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;
  try {
    if (p === '/api/config' && req.method === 'GET') {
      return json(res, 200, { hasServerKey: Boolean(process.env.ARK_API_KEY), serverModel: ARK_MODEL, baseUrl: ARK_BASE });
    }
    if (p === '/api/prompts' && req.method === 'GET') return json(res, 200, buildPrompts());
    if (p === '/api/sop' && req.method === 'GET') {
      const file = path.join(ROOT, 'docs', 'SOP.md');
      return json(res, 200, { content: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '# 还没有 docs/SOP.md' });
    }
    if (p === '/api/bloggers' && req.method === 'GET') return json(res, 200, { bloggers: listBloggers() });
    if (p === '/api/bloggers' && req.method === 'POST') {
      const body = await readBody(req, 4);
      const file = path.join(BLOGGERS, safeName(body.name));
      fs.mkdirSync(BLOGGERS, { recursive: true });
      fs.writeFileSync(file, String(body.content || ''), 'utf8');
      return json(res, 200, { ok: true, bloggers: listBloggers() });
    }
    if (p === '/api/bloggers' && req.method === 'DELETE') {
      const body = await readBody(req, 1);
      const file = path.join(BLOGGERS, safeName(body.name));
      if (fs.existsSync(file)) fs.unlinkSync(file);
      return json(res, 200, { ok: true, bloggers: listBloggers() });
    }
    if (p === '/api/extract' && req.method === 'POST') {
      const body = await readBody(req, 40);
      const buf = Buffer.from(String(body.data || ''), 'base64');
      if (!buf.length) return json(res, 400, { error: '文件是空的' });
      const text = docToText(String(body.name || ''), buf);
      if (text.replace(/\s/g, '').length < 10) {
        return json(res, 200, { text, warning: '几乎没提取到文字 —— 这份文件里多半是图片/扫描件，直接截图拖进来更靠谱。' });
      }
      return json(res, 200, { text });
    }
    if (p === '/api/chat' && req.method === 'POST') return proxyChat(req, res, await readBody(req));

    // 静态
    let rel;
    try { rel = decodeURIComponent(p === '/' ? 'index.html' : p.replace(/^\/+/, '')); }
    catch { rel = p.replace(/^\/+/, ''); } // 路径里可能有中文，要解码
    const file = path.join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('404');
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    return fs.createReadStream(file).pipe(res);
  } catch (e) {
    if (!res.headersSent) return json(res, 400, { error: e.message });
    res.end();
  }
});

/* 端口被占就往后顺延，最多试 6 个；起来后自动开浏览器（OPEN=0 可关） */
server.on('listening', () => {
  const url = `http://localhost:${server.address().port}`;
  console.log(`\n  银柴火·编导 AI 工作台  →  ${url}`);
  console.log(`  方舟地址: ${ARK_BASE}`);
  console.log(`  API Key : ${process.env.ARK_API_KEY ? '已从 .env 读到' : '未配置（在网页「设置」里填也行）'}`);
  console.log(`  模型    : ${ARK_MODEL || '未配置（在网页「设置」里填也行）'}`);
  console.log(`\n  关掉这个窗口就等于关掉工作台。\n`);
  if (process.env.OPEN === '0') return;
  // Windows 走 cmd /c start（不用 shell:true，否则 Node 22 会报 DEP0190 警告）
  const [cmd, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]];
  try {
    const child = require('child_process').spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => console.log('  （没能自动开浏览器，手动打开上面那个地址就行）'));
    child.unref();
  } catch {}
});

function start(port, tries = 0) {
  server.once('error', (e) => {
    if (e.code === 'EADDRINUSE' && tries < 5) {
      console.log(`  端口 ${port} 被占用了，换 ${port + 1} 试试…`);
      return start(port + 1, tries + 1);
    }
    console.error('\n  启动失败：' + e.message + '\n');
    process.exit(1);
  });
  server.listen(port);
}

start(PORT);
