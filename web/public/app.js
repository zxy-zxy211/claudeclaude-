/* 银柴火·编导 AI 工作台 —— 前端 */
'use strict';

const $ = (id) => document.getElementById(id);
const LS = 'yinchaihuo.v1';

const state = {
  config: {},
  prompts: {},
  bloggers: [],
  settings: { key: '', model: '', temp: 0.8 },
  files: { draft: [], revise: [], card: [] },
  chats: { draft: null, revise: null, card: null },
  step: 1,
  busy: false,
  currentCard: null,
};

/* ---------- 小工具 ---------- */

function toast(msg, bad) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast' + (bad ? ' bad' : '');
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), 3200);
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* 极简 Markdown → HTML（含表格，够分镜表用） */
function md(src) {
  const inline = (s) =>
    esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/~~([^~]+)~~/g, '<del>$1</del>')
      .replace(/(https?:\/\/[^\s<)]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');

  const lines = String(src).replace(/\r/g, '').split('\n');
  const out = [];
  let i = 0;
  const isRow = (l) => /^\s*\|.*\|\s*$/.test(l);

  while (i < lines.length) {
    const line = lines[i];

    if (/^```/.test(line)) {
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }
    if (isRow(line) && isRow(lines[i + 1] || '') && /^[\s|:-]+$/.test(lines[i + 1])) {
      const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const body = [];
      while (i < lines.length && isRow(lines[i])) body.push(cells(lines[i++]));
      out.push(
        `<table><thead><tr>${head.map((h) => `<th>${inline(h)}</th>`).join('')}</tr></thead><tbody>` +
          body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('') +
          '</tbody></table>'
      );
      continue;
    }
    let m;
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) { out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); i++; continue; }
    if (/^\s*([-*_])\s*\1\s*\1[\s-*_]*$/.test(line)) { out.push('<hr />'); i++; continue; }
    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
      out.push(`<blockquote>${md(buf.join('\n'))}</blockquote>`);
      continue;
    }
    if (/^\s*([-*+]|\d+[.、])\s+/.test(line)) {
      const ordered = /^\s*\d+[.、]/.test(line);
      const items = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.、])\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*+]|\d+[.、])\s+/, ''));
      out.push(`<${ordered ? 'ol' : 'ul'}>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`);
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const para = [];
    const start = i;
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|>|```)/.test(lines[i]) && !/^\s*([-*+]|\d+[.、])\s+/.test(lines[i]) && !isRow(lines[i])) para.push(lines[i++]);
    if (i === start) para.push(lines[i++]); // 保证前进：流式输出里会出现「只有一半的表格行」，不加这行就死循环
    out.push(`<p>${inline(para.join('\n')).replace(/\n/g, '<br />')}</p>`);
  }
  return out.join('\n');
}

/* 字数：优先只数口播稿部分 */
function countWords(text) {
  const clean = (s) =>
    s.replace(/```[\s\S]*?```/g, '')
      .replace(/^\s*\|.*\|\s*$/gm, '')
      .replace(/[#*`>_\-|]/g, '')
      .replace(/\s+/g, '').length;
  const m = text.match(/(?:^|\n)#{1,4}[^\n]*口播[^\n]*\n([\s\S]*?)(?=\n#{1,4}[^\n]*(?:分镜|发布|标题)|$)/);
  const body = m ? m[1] : text;
  const n = clean(body);
  return { n, mins: n / 200, scoped: Boolean(m) };
}

function setWords(badgeId, text, targetMin) {
  const el = $(badgeId);
  if (!el) return;
  const { n, mins, scoped } = countWords(text);
  el.textContent = `${scoped ? '口播' : '全文'} ${n} 字 · ${mins.toFixed(1)} 分钟`;
  el.classList.toggle('over', Boolean(targetMin) && Math.abs(mins - targetMin) > targetMin * 0.15);
}

/* ---------- 接口 ---------- */

async function api(path, opts = {}) {
  const r = await fetch(path, { headers: { 'content-type': 'application/json' }, ...opts });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `${path} ${r.status}`);
  return data;
}

async function streamChat(messages, onDelta) {
  const headers = { 'content-type': 'application/json' };
  if (state.settings.key) headers['x-ark-key'] = state.settings.key;
  const r = await fetch('/api/chat', {
    method: 'POST',
    headers,
    body: JSON.stringify({ messages, model: state.settings.model || undefined, temperature: Number(state.settings.temp) }),
  });
  if (!r.ok || (r.headers.get('content-type') || '').includes('application/json')) {
    const e = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
    throw new Error(e.error + (e.detail ? `\n${e.detail}` : ''));
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let full = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split('\n');
    buf = parts.pop();
    for (const line of parts) {
      const s = line.trim();
      if (!s.startsWith('data:')) continue;
      const payload = s.slice(5).trim();
      if (payload === '[DONE]') continue;
      let j;
      try { j = JSON.parse(payload); } catch { continue; }
      if (j.error) throw new Error(typeof j.error === 'string' ? j.error : JSON.stringify(j.error));
      const d = j.choices && j.choices[0] && (j.choices[0].delta || j.choices[0].message);
      const piece = d && (d.content || '');
      if (piece) { full += piece; onDelta(full); }
    }
  }
  return full;
}

/* ---------- 会话（每个模块一条） ---------- */

function newChat(moduleKey) {
  const p = state.prompts[moduleKey];
  return { messages: [{ role: 'system', content: p ? p.system : '你是银柴火的 AI 编导。' }] };
}

function contentWith(text, files) {
  const imgs = files.filter((f) => f.kind === 'image');
  if (!imgs.length) return text;
  return [{ type: 'text', text }, ...imgs.map((f) => ({ type: 'image_url', image_url: { url: f.data } }))];
}

async function send(moduleKey, { userText, files = [], outId, badgeId, label, targetMin, onDone }) {
  if (state.busy) return toast('还在出稿，等这轮跑完', true);
  if (!state.settings.model && !state.config.serverModel) { show('settings'); return toast('先在设置里填模型', true); }
  state.chats[moduleKey] = state.chats[moduleKey] || newChat(moduleKey);
  const chat = state.chats[moduleKey];
  chat.messages.push({ role: 'user', content: contentWith(userText, files) });

  const out = $(outId);
  out.querySelector('.empty')?.remove();
  if (label) out.insertAdjacentHTML('beforeend', `<div class="turn-sep">${esc(label)}</div>`);
  const block = document.createElement('div');
  block.className = 'md';
  block.innerHTML = '<span class="cursor"></span>';
  out.appendChild(block);
  out.scrollTop = out.scrollHeight;

  state.busy = true;
  document.querySelectorAll('.primary').forEach((b) => (b.disabled = true));
  try {
    const text = await streamChat(chat.messages, (full) => {
      const stick = out.scrollHeight - out.scrollTop - out.clientHeight < 90;
      block.innerHTML = md(full) + '<span class="cursor"></span>';
      if (badgeId) setWords(badgeId, full, targetMin);
      if (stick) out.scrollTop = out.scrollHeight;
    });
    block.innerHTML = md(text);
    chat.messages.push({ role: 'assistant', content: text });
    if (badgeId) setWords(badgeId, text, targetMin);
    onDone && onDone(text);
    return text;
  } catch (e) {
    block.innerHTML = `<blockquote><strong>出错了：</strong>${esc(e.message)}</blockquote>`;
    toast(e.message.split('\n')[0], true);
    chat.messages.pop();
  } finally {
    state.busy = false;
    document.querySelectorAll('.primary').forEach((b) => (b.disabled = false));
  }
}

/* ---------- ⛔确认关 ---------- */

function renderGate(gateId, cfg) {
  const g = $(gateId);
  if (!cfg) { g.hidden = true; g.innerHTML = ''; return; }
  g.hidden = false;
  g.innerHTML = `
    <div class="gate-title">${esc(cfg.title)}</div>
    <div class="gate-row">
      <textarea placeholder="${esc(cfg.placeholder || '要改的地方写这里，写完点右边')}"></textarea>
      <div class="col">
        ${cfg.buttons.map((b, i) => `<button class="${b.primary ? 'primary' : 'ghost'} tiny" data-i="${i}">${esc(b.label)}</button>`).join('')}
      </div>
    </div>`;
  const ta = g.querySelector('textarea');
  g.querySelectorAll('button').forEach((btn) =>
    btn.addEventListener('click', () => {
      const note = ta.value.trim();
      const b = cfg.buttons[Number(btn.dataset.i)];
      if (b.needNote && !note) return toast('先写要改什么', true);
      renderGate(gateId, null);
      b.run(note);
    })
  );
}

/* ---------- 文件 ---------- */

function renderFiles(key, boxId) {
  const box = $(boxId);
  box.innerHTML = state.files[key]
    .map((f, i) => {
      const icon = f.kind === 'image' ? `<img src="${f.data}" alt="" />` : f.busy ? '⏳' : '📄';
      const note = f.busy ? '<i>解析中…</i>' : f.kind === 'text' ? `<i>${f.chars} 字</i>` : '';
      return `<span class="file-chip">${icon}<b>${esc(f.name)}</b>${note}<button data-i="${i}">✕</button></span>`;
    })
    .join('');
  box.querySelectorAll('button').forEach((b) =>
    b.addEventListener('click', () => { state.files[key].splice(Number(b.dataset.i), 1); renderFiles(key, boxId); })
  );
}

const PLAIN = /\.(txt|md|markdown|csv|json)$/i;
const DOCS = /\.(docx|pptx)$/i;
const MAX_CHARS = 200000;

/* PDF：用项目内置的 pdf.js 解析，不连外网 */
let pdfjs = null;
async function pdfToText(file) {
  if (!pdfjs) {
    pdfjs = await import('./vendor/pdfjs/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = 'vendor/pdfjs/pdf.worker.min.mjs';
  }
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    cMapUrl: 'vendor/pdfjs/cmaps/',
    cMapPacked: true,
  }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const tc = await (await doc.getPage(i)).getTextContent();
    pages.push(`【第 ${i} 页】\n` + tc.items.map((it) => (it.str || '') + (it.hasEOL ? '\n' : '')).join(''));
  }
  return pages.join('\n\n').trim();
}

async function toBase64(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 8192) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 8192));
  return btoa(bin);
}

async function readFiles(fileList, key, boxId) {
  for (const file of [...fileList]) {
    if (file.type.startsWith('image/')) {
      const fr = new FileReader();
      fr.onload = () => { state.files[key].push({ name: file.name, kind: 'image', data: fr.result }); renderFiles(key, boxId); };
      fr.readAsDataURL(file);
      continue;
    }
    if (/\.(doc|ppt|xls)$/i.test(file.name)) {
      toast(`${file.name}：老格式读不了，先用 Word/PPT 另存为 .docx / .pptx`, true);
      continue;
    }
    if (!PLAIN.test(file.name) && !DOCS.test(file.name) && !/\.pdf$/i.test(file.name)) {
      toast(`${file.name}：不认识这个格式。图片、PDF、Word(.docx)、PPT(.pptx)、txt 都行。`, true);
      continue;
    }

    const entry = { name: file.name, kind: 'text', data: '', chars: 0, busy: true };
    state.files[key].push(entry);
    renderFiles(key, boxId);

    try {
      let text;
      if (PLAIN.test(file.name)) {
        text = await file.text();
      } else if (/\.pdf$/i.test(file.name)) {
        text = await pdfToText(file);
        if (text.replace(/【第 \d+ 页】|\s/g, '').length < 10) {
          toast(`${file.name}：这份 PDF 里几乎没有文字（多半是扫描件/图片型），建议改用截图。`, true);
        }
      } else {
        const r = await fetch('/api/extract', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: file.name, data: await toBase64(file) }),
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || '解析失败');
        text = data.text;
        if (data.warning) toast(`${file.name}：${data.warning}`, true);
      }
      if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS) + '\n…（太长了，后面截断了）';
      entry.data = text;
      entry.chars = text.replace(/\s/g, '').length;
    } catch (e) {
      toast(`${file.name} 解析失败：${e.message}`, true);
      state.files[key].splice(state.files[key].indexOf(entry), 1);
    } finally {
      entry.busy = false;
      renderFiles(key, boxId);
    }
  }
}

function textFilesBlock(key) {
  const t = state.files[key].filter((f) => f.kind === 'text');
  if (!t.length) return '';
  return '\n\n' + t.map((f) => `【附件 ${f.name}】\n${f.data}`).join('\n\n');
}

function wireDrop(dropId, pickId, key, boxId) {
  const drop = $(dropId);
  ['dragenter', 'dragover'].forEach((e) => drop.addEventListener(e, (ev) => { ev.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((e) => drop.addEventListener(e, () => drop.classList.remove('over')));
  drop.addEventListener('drop', (ev) => { ev.preventDefault(); readFiles(ev.dataTransfer.files, key, boxId); });
  $(pickId).addEventListener('click', () => {
    const picker = $('filePicker');
    picker.onchange = () => { readFiles(picker.files, key, boxId); picker.value = ''; };
    picker.click();
  });
}

/* ---------- 视图 ---------- */

function show(view) {
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.dataset.view === view));
  if (view === 'sop' && !$('sopDoc').dataset.loaded) loadSop();
}

function setStep(n) {
  state.step = n;
  document.querySelectorAll('#draftSteps .step').forEach((s) => {
    const i = Number(s.dataset.step);
    s.classList.toggle('current', i === n);
    s.classList.toggle('done', i < n);
  });
}

async function loadSop() {
  try {
    const { content } = await api('/api/sop');
    $('sopDoc').innerHTML = md(content);
    $('sopDoc').dataset.loaded = '1';
  } catch (e) { $('sopDoc').textContent = e.message; }
}

/* ---------- 博主卡 ---------- */

function bloggerCard(name) {
  const b = state.bloggers.find((x) => x.name === name);
  return b ? b.content : '';
}

function fillBloggerSelects() {
  const opts = ['<option value="">（不带博主卡）</option>']
    .concat(state.bloggers.filter((b) => !b.template).map((b) => `<option value="${esc(b.name)}">${esc(b.name)}</option>`))
    .join('');
  ['draftBlogger', 'reviseBlogger'].forEach((id) => {
    const keep = $(id).value;
    $(id).innerHTML = opts;
    if (keep) $(id).value = keep;
  });
  $('cardList').innerHTML = state.bloggers
    .map((b) => `<li><button data-name="${esc(b.name)}" class="${state.currentCard === b.name ? 'active' : ''}">${esc(b.name)}${b.template ? ' <small>模板</small>' : `<small>${new Date(b.updated).toLocaleString('zh-CN')}</small>`}</button></li>`)
    .join('') || '<li style="color:var(--text-mute);font-size:12px">还没有卡，用下面「让 AI 建卡」或点 + 新建</li>';
  $('cardList').querySelectorAll('button').forEach((btn) =>
    btn.addEventListener('click', () => {
      state.currentCard = btn.dataset.name;
      $('cardName').value = btn.dataset.name;
      $('cardEditor').value = bloggerCard(btn.dataset.name);
      fillBloggerSelects();
    })
  );
}

async function loadBloggers() {
  try {
    const { bloggers } = await api('/api/bloggers');
    state.bloggers = bloggers;
    fillBloggerSelects();
  } catch (e) { toast(e.message, true); }
}

/* ---------- 模块二：新稿生产 ---------- */

function targetMin() { return Number($('draftMin').value) || 3; }

function workOrder() {
  const card = bloggerCard($('draftBlogger').value);
  const min = targetMin();
  return [
    '【模块二 · 新稿生产 · 标准工单】',
    `博主：${$('draftBlogger').value || '（未指定）'}`,
    `类型：${document.querySelector('#draftType .chip.active').dataset.v}`,
    `本期主题：${$('draftTopic').value.trim() || '（空，你从逐字稿里提，我来审）'}`,
    `时长：${min} 分钟 → 目标 ${Math.round(min * 200)} 字（200 字/分钟）`,
    '',
    '对标链接：',
    $('draftRefs').value.trim() || '（无）',
    '',
    '逐字稿：',
    '"""',
    $('draftScript').value.trim() || '（无逐字稿，按商单资料和对标来）',
    '"""',
    textFilesBlock('draft'),
    card ? `\n博主卡：\n"""\n${card}\n"""` : '\n（这次没给博主卡，风格拿不准的地方先问我，不要自己编。）',
    '',
    '现在执行步骤 1：只出【内容策划案】，出完停下问我确认，不许往下写正文。',
  ].join('\n');
}

function gate1() {
  renderGate('draftGate', {
    title: '⛔ 确认关①：主题和必带点 OK 吗？',
    placeholder: '要改主题 / 加必带点 / 删禁写项，写这里',
    buttons: [
      { label: 'OK，出开头策略', primary: true, run: (note) => step2(note) },
      { label: '按我说的改策划案', needNote: true, run: (note) => reviseStep1(note) },
    ],
  });
}

function step2(note) {
  setStep(2);
  send('draft', {
    userText: [
      note ? `确认，另外：${note}` : '主题和必带点 OK，确认。',
      '执行步骤 2：给 2-3 个开头策略，每个配钩子句（可直接念）+ 结构线（几段、每段干什么、各占多少字）。',
      '开头优先用我逐字稿里的原话，你只顺句，不要重新编漂亮话。出完停下等我选。',
    ].join('\n'),
    outId: 'draftOut',
    label: '你：确认主题 → 要开头策略',
    onDone: gate2,
  });
}

function reviseStep1(note) {
  send('draft', {
    userText: `策划案按这些改，改完重新给我看，仍然不许往下写正文：\n${note}`,
    outId: 'draftOut',
    label: '你：改策划案',
    onDone: gate1,
  });
}

function gate2() {
  renderGate('draftGate', {
    title: '⛔ 确认关②：定开头和结构',
    placeholder: '写「用第2个」，或直接写你要的开头原话 / 结构改动',
    buttons: [
      { label: '按我说的定，出成稿', primary: true, needNote: true, run: (note) => step3(note) },
      { label: '再给我几个开头', run: (note) => send('draft', { userText: `这几个开头都不够劲${note ? '：' + note : ''}。再给 2-3 个，钩子更狠一点，仍然用我原话打底。`, outId: 'draftOut', label: '你：再来几个开头', onDone: gate2 }) },
    ],
  });
}

function step3(note) {
  setStep(3);
  const min = targetMin();
  send('draft', {
    userText: [
      `开头和结构定了：${note}`,
      `执行步骤 3：按定好的结构套四段式出完整成品，一次交齐三样——① 口播稿（纯文案）② 分镜表（镜号|时长|画面|口播|花字）③ 发布文案（标题3个+正文+TAG）。`,
      `严格 200 字/分钟，总时长 ${min} 分钟 ≈ ${Math.round(min * 200)} 字，结尾报一行总字数和折算时长。只交完整成品，不交草稿。`,
    ].join('\n'),
    outId: 'draftOut',
    badgeId: 'draftWords',
    targetMin: min,
    label: '你：定开头 → 要成稿',
    onDone: () =>
      renderGate('draftGate', {
        title: '成稿到手。要继续磨就写在这儿（这一步是你本人润色）',
        placeholder: '例：第二段太书面了，换成他平时的短句；分镜 05 画面改成……',
        buttons: [
          { label: '按这个改', primary: true, needNote: true, run: (n) => send('draft', { userText: `只改我说的这些，别动别处，改完给完整稿：\n${n}`, outId: 'draftOut', badgeId: 'draftWords', targetMin: min, label: '你：润色意见', onDone: () => gate3Again(min) }) },
          { label: '再拆一版观点稿', run: () => send('draft', { userText: '按「一个项目拆多角度」的规则，用同一批素材再出一版观点人设稿（同样交齐三样），角度要和主案例稿明显不同。', outId: 'draftOut', badgeId: 'draftWords', targetMin: min, label: '你：要观点稿版本', onDone: () => gate3Again(min) }) },
        ],
      }),
  });
}

function gate3Again(min) {
  renderGate('draftGate', {
    title: '还要改吗？',
    placeholder: '继续写修改点',
    buttons: [{ label: '按这个改', primary: true, needNote: true, run: (n) => send('draft', { userText: `只改我说的这些，别动别处，改完给完整稿：\n${n}`, outId: 'draftOut', badgeId: 'draftWords', targetMin: min, label: '你：润色意见', onDone: () => gate3Again(min) }) }],
  });
}

/* ---------- 模块三：内容修改 ---------- */

function reviseGo() {
  const notes = $('reviseNotes').value.trim();
  const script = $('reviseText').value.trim();
  const imgs = state.files.revise.filter((f) => f.kind === 'image').length;
  if (!notes && !imgs) return toast('先给修改意见（文字或截图）', true);
  if (!script) return toast('把要改的脚本全文贴进来', true);
  const card = bloggerCard($('reviseBlogger').value);
  state.chats.revise = newChat('revise');
  $('reviseOut').innerHTML = '';
  send('revise', {
    userText: [
      '【模块三 · 内容修改】',
      '修改意见原话：',
      '"""',
      notes || '（见截图）',
      '"""',
      imgs ? `另附 ${imgs} 张意见截图，直接读截图里的原话，不要替我转述。` : '',
      textFilesBlock('revise'),
      card ? `\n博主卡：\n"""\n${card}\n"""` : '',
      $('reviseSingle').checked
        ? '\n注意：这是单段模式。我只贴了要改的那一段，你只改这一段，别动其他任何地方，改完给出与前后文的衔接检查。'
        : '\n按修改六步走：只改被提到的地方，不全盘重写，保留原逻辑和博主原有说话风格。',
      '\n要改的脚本：',
      '"""',
      script,
      '"""',
      '\n输出：① 完整改稿（改动处标【改】）② 逐条核对表（编号|原话意见|改在哪|状态）③ 情绪词单独列出来让我翻译。',
    ].filter(Boolean).join('\n'),
    files: state.files.revise,
    outId: 'reviseOut',
    badgeId: 'reviseWords',
    label: '你：提交改稿工单',
    onDone: () =>
      renderGate('reviseGate', {
        title: '逐条核对过了吗？还有没改到的写这儿',
        placeholder: '例：M3 只改了一半，第二段那句还没动',
        buttons: [{ label: '补改', primary: true, needNote: true, run: (n) => send('revise', { userText: `这些还没到位，补改，其他别动，给完整稿 + 更新核对表：\n${n}`, outId: 'reviseOut', badgeId: 'reviseWords', label: '你：补改指令', onDone: () => renderGate('reviseGate', null) }) }],
      }),
  });
}

/* ---------- 模块一：博主卡 ---------- */

function cardGo() {
  const src = $('cardSource').value.trim();
  if (!src && !state.files.card.length) return toast('先贴作品链接或内容', true);
  state.chats.card = newChat('card');
  const out = $('cardOut');
  out.hidden = false;
  out.innerHTML = '';
  send('card', {
    userText: ['【模块一 · 博主建档】以下是该博主过往 / 对标作品，按技能里的卡片格式建卡。语气和雷区要从原话里抽，不要泛泛形容。', '"""', src || '（见截图）', '"""', textFilesBlock('card')].join('\n'),
    files: state.files.card,
    outId: 'cardOut',
    label: '你：提交作品素材',
    onDone: (text) => {
      $('cardEditor').value = text;
      if (!$('cardName').value.trim()) {
        const m = text.match(/博主名[^\n:：]*[：:]\s*([^\n/|（(]+)/);
        if (m) $('cardName').value = m[1].trim();
      }
      toast('卡已放进编辑器，改完点保存');
    },
  });
}

async function cardSave() {
  const name = $('cardName').value.trim();
  if (!name) return toast('先写博主名', true);
  try {
    const { bloggers } = await api('/api/bloggers', { method: 'POST', body: JSON.stringify({ name, content: $('cardEditor').value }) });
    state.bloggers = bloggers;
    state.currentCard = name;
    fillBloggerSelects();
    toast(`已存 bloggers/${name}.md`);
  } catch (e) { toast(e.message, true); }
}

async function cardDelete() {
  const name = $('cardName').value.trim();
  if (!name || !confirm(`删掉 bloggers/${name}.md？`)) return;
  try {
    const { bloggers } = await api('/api/bloggers', { method: 'DELETE', body: JSON.stringify({ name }) });
    state.bloggers = bloggers;
    state.currentCard = null;
    $('cardName').value = '';
    $('cardEditor').value = '';
    fillBloggerSelects();
    toast('已删除');
  } catch (e) { toast(e.message, true); }
}

/* ---------- 设置 ---------- */

function loadSettings() {
  try { Object.assign(state.settings, JSON.parse(localStorage.getItem(LS) || '{}')); } catch {}
  $('setKey').value = state.settings.key || '';
  $('setModel').value = state.settings.model || '';
  $('setTemp').value = state.settings.temp ?? 0.8;
}

function saveSettings() {
  state.settings = { key: $('setKey').value.trim(), model: $('setModel').value.trim(), temp: Number($('setTemp').value) || 0.8 };
  localStorage.setItem(LS, JSON.stringify(state.settings));
  refreshStatus();
  toast('已保存到这台机器的浏览器');
}

function refreshStatus() {
  const model = state.settings.model || state.config.serverModel;
  const hasKey = state.settings.key || state.config.hasServerKey;
  const el = $('status');
  el.className = 'status' + (hasKey && model ? ' ok' : ' bad');
  $('statusText').textContent = hasKey && model ? `豆包就绪 · ${String(model).slice(0, 22)}` : !hasKey ? '缺 API Key' : '缺模型';
  $('draftModel').textContent = model ? `模型 ${String(model).slice(0, 20)}` : '未配置模型';
  $('setBase').textContent = state.config.baseUrl || '—';
}

/* ---------- 启动 ---------- */

function persistDraft() {
  const keys = ['draftScript', 'draftRefs', 'draftTopic', 'draftMin', 'reviseNotes', 'reviseText'];
  keys.forEach((k) => {
    const saved = localStorage.getItem(LS + '.' + k);
    if (saved !== null && $(k)) $(k).value = saved;
    $(k)?.addEventListener('input', () => localStorage.setItem(LS + '.' + k, $(k).value));
  });
}

function updateCounters() {
  const min = targetMin();
  $('draftTarget').textContent = `${Math.round(min * 200)} 字`;
  $('draftScriptCount').textContent = `${$('draftScript').value.replace(/\s+/g, '').length} 字`;
  $('reviseCount').textContent = `${$('reviseText').value.replace(/\s+/g, '').length} 字`;
}

async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
  } catch {}
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch {}
  ta.remove();
  return ok;
}

function download(id, name) {
  const text = $(id).innerText;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function init() {
  loadSettings();
  document.documentElement.dataset.theme = localStorage.getItem(LS + '.theme') || 'dark';

  $('nav').addEventListener('click', (e) => { const b = e.target.closest('.nav-item'); if (b) show(b.dataset.view); });
  document.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => show(b.dataset.goto)));
  $('themeToggle').addEventListener('click', () => {
    const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = t;
    localStorage.setItem(LS + '.theme', t);
  });

  $('draftType').addEventListener('click', (e) => {
    const c = e.target.closest('.chip');
    if (!c) return;
    document.querySelectorAll('#draftType .chip').forEach((x) => x.classList.toggle('active', x === c));
  });
  ['draftMin', 'draftScript', 'reviseText'].forEach((id) => $(id).addEventListener('input', updateCounters));
  updateCounters();

  wireDrop('draftDrop', 'draftPick', 'draft', 'draftFiles');
  wireDrop('reviseDrop', 'revisePick', 'revise', 'reviseFiles');
  wireDrop('cardDrop', 'cardPick', 'card', 'cardFiles');

  $('draftGo').addEventListener('click', () => {
    if (!$('draftScript').value.trim() && !state.files.draft.length) return toast('先给逐字稿或商单资料', true);
    state.chats.draft = newChat('draft');
    $('draftOut').innerHTML = '';
    renderGate('draftGate', null);
    setStep(1);
    send('draft', { userText: workOrder(), files: state.files.draft, outId: 'draftOut', label: '你：提交工单', onDone: gate1 });
  });
  $('draftReset').addEventListener('click', () => {
    state.chats.draft = null;
    state.files.draft = [];
    renderFiles('draft', 'draftFiles');
    $('draftOut').innerHTML = '<div class="empty">左边填完工单，点「出内容策划案」。</div>';
    renderGate('draftGate', null);
    setStep(1);
  });

  $('reviseGo').addEventListener('click', reviseGo);
  $('reviseReset').addEventListener('click', () => {
    state.chats.revise = null;
    state.files.revise = [];
    renderFiles('revise', 'reviseFiles');
    $('reviseNotes').value = $('reviseText').value = '';
    $('reviseOut').innerHTML = '<div class="empty">改完会带一张逐条核对表。</div>';
    renderGate('reviseGate', null);
  });

  $('cardGo').addEventListener('click', cardGo);
  $('cardSave').addEventListener('click', cardSave);
  $('cardDelete').addEventListener('click', cardDelete);
  $('cardNew').addEventListener('click', () => {
    state.currentCard = null;
    $('cardName').value = '';
    const tpl = state.bloggers.find((b) => b.name === '_template');
    $('cardEditor').value = tpl ? tpl.content : '# 博主卡 · \n';
    fillBloggerSelects();
  });

  $('setSave').addEventListener('click', saveSettings);
  $('setTest').addEventListener('click', async () => {
    saveSettings();
    $('setOut').textContent = '连接中…';
    try {
      const t = await streamChat([{ role: 'user', content: '只回四个字：连接正常' }], (f) => ($('setOut').textContent = f));
      $('setOut').textContent = `✅ 通了，豆包回：${t.trim()}`;
    } catch (e) { $('setOut').textContent = `❌ ${e.message}`; }
  });

  document.querySelectorAll('[data-copy]').forEach((b) =>
    b.addEventListener('click', async () => {
      const ok = await copyText($(b.dataset.copy).innerText);
      toast(ok ? '已复制，可以直接粘进飞书' : '浏览器不给复制，手动选中吧', !ok);
    })
  );
  document.querySelectorAll('[data-save]').forEach((b) =>
    b.addEventListener('click', () => download(b.dataset.save, `银柴火-${new Date().toISOString().slice(0, 10)}.md`))
  );

  persistDraft();
  updateCounters();

  try { state.config = await api('/api/config'); } catch {}
  try { state.prompts = await api('/api/prompts'); } catch (e) { toast('读不到技能提示词：' + e.message, true); }
  refreshStatus();
  await loadBloggers();
}

init();
