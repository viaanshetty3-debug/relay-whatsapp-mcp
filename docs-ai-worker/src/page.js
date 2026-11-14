// The help page served by the Worker: troubleshooting guide + an openable "Ask Relay AI"
// sidebar. Browser code is written as real functions (so it can be linted and unit-tested)
// and serialized into /app.js. The page uses no inline scripts or styles (strict CSP).

export const REPO = 'https://github.com/viaanshetty3-debug/relay-whatsapp-mcp';

const STARTERS = [
  'How do I set up failover with a standby computer, and how fast is it?',
  'How do I run relay-whatsapp-mcp doctor?',
  'How do I connect Relay to Claude Desktop?',
  'Which of the 37 tools can send or change messages?',
  'What are the security risks of using Relay?',
];

// ---------- shared helpers (used on the server and serialized into /app.js) ----------

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// Inline Markdown on text that is ALREADY escaped: `code`, **bold**, *italic*, [text](https://link).
// Code spans are set aside first so bold or links can wrap them.
export function inlineMarkdown(escaped) {
  const codes = [];
  const marked = String(escaped).replace(/\u0000/g, '').replace(/`([^`]+)`/g, (m, code) => '\u0000' + (codes.push(code) - 1) + '\u0000');
  return marked
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)"\u0000]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/\u0000(\d+)\u0000/g, (m, n) => '<code>' + codes[n] + '</code>');
}

// A deliberately small Markdown renderer. Everything is escaped first, so model output
// can never inject HTML or scripts; only the tags created here reach the page.
export function renderMarkdown(src) {
  const out = [];
  const lines = String(src).split('\n');
  const listItem = /^\s*([-*]|\d+\.)\s+/;
  const tableRow = /^\s*\|.*\|\s*$/;
  const cells = row => row.trim().replace(/^\||\|$/g, '').split('|').map(c => inlineMarkdown(escapeHtml(c.trim())));
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      const code = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++]);
      i++;
      out.push('<pre><code>' + escapeHtml(code.join('\n')) + '</code></pre>');
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      const level = Math.min(heading[1].length + 2, 6);
      out.push(`<h${level}>${inlineMarkdown(escapeHtml(heading[2]))}</h${level}>`);
      i++;
      continue;
    }
    if (tableRow.test(line)) {
      const rows = [];
      while (i < lines.length && tableRow.test(lines[i])) rows.push(lines[i++]);
      const body = rows.filter((r, n) => !(n === 1 && /^[\s|:-]+$/.test(r)));
      const [head, ...rest] = body;
      out.push('<div class="table"><table><thead><tr>' + cells(head).map(c => '<th>' + c + '</th>').join('') + '</tr></thead><tbody>' +
        rest.map(r => '<tr>' + cells(r).map(c => '<td>' + c + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>');
      continue;
    }
    if (listItem.test(line)) {
      const tag = /^\s*\d+\./.test(line) ? 'ol' : 'ul';
      const items = [];
      while (i < lines.length && listItem.test(lines[i])) items.push(lines[i++].replace(listItem, ''));
      out.push(`<${tag}>` + items.map(x => '<li>' + inlineMarkdown(escapeHtml(x)) + '</li>').join('') + `</${tag}>`);
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const para = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !/^\s*```/.test(lines[i]) && !/^#{1,4}\s/.test(lines[i]) && !listItem.test(lines[i]) && !tableRow.test(lines[i])) para.push(lines[i++]);
    out.push('<p>' + inlineMarkdown(escapeHtml(para.join('\n'))).replace(/\n/g, '<br>') + '</p>');
  }
  return out.join('');
}

// ---------- page ----------

function troubleshootingHtml(guide) {
  if (!guide || !guide.items.length) {
    return `<p class="muted">The troubleshooting guide couldn't be loaded right now. See the <a href="${REPO}#troubleshooting" target="_blank" rel="noopener">README</a>, or ask Relay AI.</p>`;
  }
  const items = guide.items.map((item, n) => `
    <details class="trouble" id="problem-${n + 1}">
      <summary>${inlineMarkdown(escapeHtml(item.symptom))}</summary>
      <div class="fix">${renderMarkdown(item.fix)}</div>
      <button type="button" class="ghost small ask-about" data-symptom="${escapeHtml(item.symptom.replace(/[`*]/g, ''))}">Ask Relay AI about this</button>
    </details>`).join('');
  return `${guide.intro ? `<div class="intro">${renderMarkdown(guide.intro)}</div>` : ''}
    <label class="filter"><span class="sr">Filter problems</span><input id="filter" type="search" placeholder="Filter problems, e.g. 401, QR, Windows…" autocomplete="off"></label>
    <div id="troubles">${items}</div>
    <p id="no-match" class="muted" hidden>No matching problem. <button type="button" class="link" id="ask-filter">Ask Relay AI instead →</button></p>`;
}

export function renderPage(guide) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>Relay Help</title>
<meta name="description" content="Help for relay-whatsapp-mcp: troubleshooting guide and a free AI assistant for setup, failover, the 37 WhatsApp MCP tools and security.">
<link rel="stylesheet" href="/style.css?v=${ASSET_VERSION}">
</head>
<body>
<div class="page">
  <header class="top">
    <a class="brand" href="/">Relay <span>Help</span></a>
    <nav>
      <a href="${REPO}#readme" target="_blank" rel="noopener">Docs</a>
      <a href="https://www.npmjs.com/package/relay-whatsapp-mcp" target="_blank" rel="noopener">npm</a>
      <button type="button" class="open-chat">💬 Ask Relay AI</button>
    </nav>
  </header>
  <main>
    <section class="hero">
      <h1>Get Relay working</h1>
      <p>Relay gives Claude and ChatGPT your WhatsApp as 37 MCP tools. Most problems are solved by the checks below. For anything else, ask Relay AI: it answers from the docs, free, with no login.</p>
      <pre><code>npx relay-whatsapp-mcp doctor    # checks your install and says what to fix</code></pre>
    </section>
    <section id="troubleshooting" aria-labelledby="t-title">
      <h2 id="t-title">Troubleshooting</h2>
      ${troubleshootingHtml(guide)}
    </section>
    <section class="more">
      <h2>Still stuck?</h2>
      <p><button type="button" class="link open-chat">Ask Relay AI</button>, read the <a href="${REPO}#readme" target="_blank" rel="noopener">README</a> and <a href="${REPO}/blob/main/SECURITY.md" target="_blank" rel="noopener">SECURITY.md</a>, or <a href="${REPO}/issues" target="_blank" rel="noopener">open an issue</a> (for security problems, follow SECURITY.md instead).</p>
    </section>
  </main>
</div>

<button type="button" class="fab open-chat" aria-controls="chat">💬 Ask Relay AI</button>

<aside id="chat" class="drawer" aria-label="Relay AI chat" aria-hidden="true">
  <div class="drawer-head">
    <div><strong>Relay AI</strong><span class="muted small-text">Your own private chat</span></div>
    <div class="drawer-actions">
      <button id="reset" type="button" class="ghost small">New chat</button>
      <button id="close-chat" type="button" class="ghost small" aria-label="Close chat">✕</button>
    </div>
  </div>
  <div id="chat-body" class="drawer-body">
    <div id="log" aria-live="polite"></div>
    <div id="starters" class="starters">
      <p class="muted">Ask anything about setup, failover, the 37 tools or security. Try:</p>
      ${STARTERS.map(q => `<button type="button" class="starter" data-q="${escapeHtml(q)}">${escapeHtml(q)}</button>`).join('\n      ')}
    </div>
  </div>
  <div class="drawer-foot">
    <form id="ask">
      <textarea id="q" rows="1" maxlength="4000" placeholder="Ask about Relay…" aria-label="Your question" required></textarea>
      <button id="send" type="submit">Send</button>
      <button id="stop" type="button" class="ghost" hidden>Stop</button>
    </form>
    <p class="note"><span id="status"></span>Answers are generated from Relay's docs by Google Gemini (or the maintainer's own model) and can be wrong. Questions are sent to those services (Google may use free-tier questions to improve its products). Your chat is saved only in this browser. Don't paste keys or private messages.</p>
  </div>
</aside>
<script src="/app.js?v=${ASSET_VERSION}"></script>
</body>
</html>
`;
}

export const PAGE_CSS = `:root {
  --bg: #0d1117; --panel: #161b22; --panel2: #11161d; --border: #30363d; --text: #e6edf3; --muted: #8b949e;
  --accent: #2ea043; --accent-hover: #3fb950; --link: #58a6ff; --user: #1f3a5f; --error: #f85149; --code: #0b0f14;
  --drawer: 440px; color-scheme: dark;
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; }
a { color: var(--link); }
code { font: .88em/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; }
:not(pre) > code { background: var(--code); border: 1px solid var(--border); padding: 0 5px; border-radius: 5px; }
pre { background: var(--code); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; overflow-x: auto; }
.muted { color: var(--muted); }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
button { font: inherit; border-radius: 10px; padding: 9px 16px; border: 1px solid transparent; cursor: pointer; background: var(--accent); color: #fff; font-weight: 600; }
button:hover { background: var(--accent-hover); }
button:disabled { opacity: .5; cursor: default; }
button.ghost { background: transparent; color: var(--text); border-color: var(--border); font-weight: 500; }
button.ghost:hover { border-color: var(--muted); }
button.small { padding: 5px 10px; font-size: .85rem; }
button.link { background: none; border: 0; padding: 0; color: var(--link); font-weight: 500; text-decoration: underline; }
textarea:focus, input:focus, button:focus-visible, summary:focus-visible { outline: 2px solid var(--link); outline-offset: 2px; }

.page { transition: margin-right .2s ease; }
.top { display: flex; align-items: center; justify-content: space-between; gap: 12px; max-width: 920px; margin: 0 auto; padding: 14px 16px; border-bottom: 1px solid var(--border); }
.brand { color: var(--text); text-decoration: none; font-weight: 700; font-size: 1.15rem; }
.brand span { color: var(--muted); font-weight: 500; }
nav { display: flex; align-items: center; gap: 14px; }
nav a { color: var(--muted); text-decoration: none; }
nav a:hover { color: var(--text); }
main { max-width: 920px; margin: 0 auto; padding: 8px 16px 96px; }
.hero h1 { font-size: 1.8rem; margin: 24px 0 8px; }
.hero p { color: var(--muted); max-width: 680px; }
h2 { margin: 36px 0 12px; font-size: 1.3rem; }
.intro p { margin: 0 0 12px; }
.filter input { width: 100%; background: var(--panel); color: var(--text); border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; font: inherit; margin-bottom: 12px; }
.trouble { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; margin-bottom: 8px; }
.trouble summary { cursor: pointer; padding: 12px 14px; font-weight: 600; list-style-position: outside; margin-left: 18px; }
.trouble[open] summary { border-bottom: 1px solid var(--border); }
.trouble .fix { padding: 4px 14px 0; }
.trouble .ask-about { margin: 0 14px 12px; }
.more p { color: var(--muted); }

.fab { position: fixed; right: 20px; bottom: 20px; z-index: 10; border-radius: 999px; padding: 12px 20px; box-shadow: 0 6px 24px rgba(0,0,0,.45); }
body.chat-open .fab { display: none; }
.drawer { position: fixed; top: 0; right: 0; z-index: 20; width: min(var(--drawer), 100vw); height: 100vh; height: 100dvh; display: flex; flex-direction: column;
  background: var(--panel2); border-left: 1px solid var(--border); transform: translateX(100%); visibility: hidden; transition: transform .2s ease, visibility .2s; }
body.chat-open .drawer { transform: none; visibility: visible; }
@media (min-width: 1100px) { body.chat-open .page { margin-right: var(--drawer); } }
@media (max-width: 560px) { nav a { display: none; } .hero h1 { font-size: 1.5rem; } }
.drawer-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 12px 14px; border-bottom: 1px solid var(--border); }
.drawer-head strong { display: block; }
.small-text { font-size: .8rem; }
.drawer-actions { display: flex; gap: 6px; }
.drawer-body { flex: 1; overflow-y: auto; padding: 14px; }
.drawer-foot { border-top: 1px solid var(--border); padding: 10px 14px 12px; }
#log { display: flex; flex-direction: column; gap: 10px; }
.msg { padding: 9px 12px; border-radius: 12px; overflow-wrap: anywhere; }
.msg.user { align-self: flex-end; background: var(--user); white-space: pre-wrap; max-width: 90%; }
.msg.assistant { background: var(--panel); border: 1px solid var(--border); }
.msg.assistant > :first-child { margin-top: 0; } .msg.assistant > :last-child { margin-bottom: 0; }
.msg.pending:empty::after { content: "Thinking…"; color: var(--muted); }
.msg.error { border-color: var(--error); color: var(--error); }
.msg h3, .msg h4, .msg h5, .msg h6 { margin: .8em 0 .3em; font-size: 1rem; }
.msg ul, .msg ol { padding-left: 1.3em; }
.table { overflow-x: auto; }
table { border-collapse: collapse; font-size: .9rem; }
th, td { border: 1px solid var(--border); padding: 5px 8px; text-align: left; vertical-align: top; }
.starters { display: flex; flex-direction: column; gap: 8px; align-items: stretch; }
.starters p { margin: 0 0 4px; }
.starter { text-align: left; background: var(--panel); color: var(--text); border: 1px solid var(--border); font-weight: 500; }
.starter:hover { background: var(--panel); border-color: var(--accent); }
form { display: flex; gap: 8px; align-items: flex-end; }
textarea { flex: 1; resize: none; max-height: 30vh; background: var(--panel); color: var(--text); border: 1px solid var(--border); border-radius: 10px; padding: 9px 12px; font: inherit; }
.note { margin: 8px 0 0; font-size: .75rem; color: var(--muted); }
#status:not(:empty)::after { content: " "; }
`;

// ---------- browser code (serialized into /app.js) ----------

export function client() {
  const STORE = 'relay-ai-chat-v1';
  const OPEN = 'relay-ai-open';
  const $ = id => document.getElementById(id);
  const log = $('log'), form = $('ask'), q = $('q'), send = $('send'), stop = $('stop'), status = $('status');
  const starters = $('starters'), body = $('chat-body'), drawer = $('chat');
  let controller = null;

  const read = key => { try { return localStorage.getItem(key); } catch { return null; } };
  const write = (key, value) => { try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* private mode */ } };
  const load = () => {
    try {
      const saved = JSON.parse(read(STORE));
      return Array.isArray(saved) ? saved.filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string') : [];
    } catch { return []; }
  };
  let messages = load();
  const save = () => write(STORE, JSON.stringify(messages.slice(-40)));

  // ----- sidebar -----
  function setOpen(open, focus = true) {
    document.body.classList.toggle('chat-open', open);
    drawer.setAttribute('aria-hidden', String(!open));
    write(OPEN, open ? '1' : null);
    if (open && focus) q.focus();
  }
  for (const b of document.querySelectorAll('.open-chat')) b.addEventListener('click', () => setOpen(true));
  $('close-chat').addEventListener('click', () => setOpen(false));
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && document.body.classList.contains('chat-open')) setOpen(false); });

  // ----- chat -----
  const scroll = () => { body.scrollTop = body.scrollHeight; };
  function bubble(role, text) {
    const div = document.createElement('div');
    div.className = 'msg ' + role;
    if (role === 'user') div.textContent = text; else div.innerHTML = renderMarkdown(text);
    log.append(div);
    scroll();
    return div;
  }
  function renderAll() {
    log.replaceChildren();
    for (const m of messages) bubble(m.role, m.content);
    starters.hidden = messages.length > 0;
  }
  function busy(on) { send.disabled = on; stop.hidden = !on; }
  function grow() { q.style.height = 'auto'; q.style.height = Math.min(q.scrollHeight, 240) + 'px'; }

  async function ask(text) {
    text = String(text || '').trim();
    if (!text || controller) return;
    setOpen(true, false);
    messages.push({ role: 'user', content: text });
    save();
    bubble('user', text);
    starters.hidden = true;
    q.value = '';
    grow();
    const out = bubble('assistant', '');
    out.classList.add('pending');
    controller = new AbortController();
    busy(true);
    let answer = '';
    try {
      const res = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages }), signal: controller.signal });
      if (!res.ok) {
        let message = 'Request failed (HTTP ' + res.status + ').';
        try { message = (await res.json()).error || message; } catch { /* not JSON */ }
        throw new Error(message);
      }
      const mode = res.headers.get('X-Relay-Mode');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let n;
        while ((n = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, n).trim();
          buffer = buffer.slice(n + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') continue;
          let chunk = '';
          try { const j = JSON.parse(data); chunk = j.response ?? j.choices?.[0]?.delta?.content ?? ''; } catch { /* keep-alive or partial line */ }
          if (chunk) { answer += chunk; out.innerHTML = renderMarkdown(answer); scroll(); }
        }
      }
      if (!answer.trim()) throw new Error('The assistant returned an empty answer. Please try again.');
      messages.push({ role: 'assistant', content: answer });
      save();
      status.textContent = mode === 'docs' ? 'AI answers are paused, so this answer is from a docs search.' : '';
    } catch (error) {
      if (error.name === 'AbortError' && answer) {
        answer += '\n\n(stopped)';
        out.innerHTML = renderMarkdown(answer);
        messages.push({ role: 'assistant', content: answer });
      } else {
        messages.pop(); // not answered; let the visitor send it again
        out.classList.add('error');
        out.textContent = error.name === 'AbortError' ? 'Stopped.' : error.message;
        if (!q.value) { q.value = text; grow(); }
      }
      save();
    } finally {
      out.classList.remove('pending');
      controller = null;
      busy(false);
      if (document.body.classList.contains('chat-open')) q.focus();
    }
  }

  form.addEventListener('submit', e => { e.preventDefault(); ask(q.value); });
  q.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); ask(q.value); } });
  q.addEventListener('input', grow);
  stop.addEventListener('click', () => controller?.abort());
  $('reset').addEventListener('click', () => {
    controller?.abort();
    messages = [];
    write(STORE, null);
    status.textContent = '';
    renderAll();
    q.focus();
  });
  for (const b of starters.querySelectorAll('.starter')) b.addEventListener('click', () => ask(b.dataset.q));

  // ----- troubleshooting -----
  for (const b of document.querySelectorAll('.ask-about')) {
    b.addEventListener('click', () => ask('I\'m seeing this problem: "' + b.dataset.symptom + '". What causes it and how do I fix it?'));
  }
  const filter = $('filter');
  if (filter) {
    const items = [...document.querySelectorAll('.trouble')];
    filter.addEventListener('input', () => {
      const words = filter.value.toLowerCase().split(/\s+/).filter(Boolean);
      let shown = 0;
      for (const item of items) {
        const match = words.every(w => item.textContent.toLowerCase().includes(w));
        item.hidden = !match;
        if (match) shown++;
      }
      $('no-match').hidden = shown > 0;
    });
    $('ask-filter').addEventListener('click', () => ask(filter.value || 'I have a problem with Relay.'));
  }

  renderAll();
  if (read(OPEN) === '1' || location.hash === '#ask') setOpen(true, false);
}

// Bundlers (esbuild with keepNames, as Wrangler uses) can insert __name(...) calls into
// these functions; define it so the serialized code runs in the browser either way.
export const PAGE_JS = `'use strict';
var __name = (target) => target;
${escapeHtml.toString()}
${inlineMarkdown.toString()}
${renderMarkdown.toString()}
(${client.toString()})();
`;

// Changes whenever the script or styles change, so browsers never mix an old /app.js with a new page.
function fnv1a(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}
export const ASSET_VERSION = fnv1a(PAGE_JS + PAGE_CSS);
