// The chat page served by the Worker: HTML, CSS and the browser script.
// The browser code is written as real functions (so it can be linted and unit-tested)
// and serialized into /app.js.

const REPO = 'https://github.com/viaanshetty3-debug/relay-whatsapp-mcp';

const STARTERS = [
  'How do I set up failover with a standby computer, and how fast is it?',
  'How do I run relay-whatsapp-mcp doctor?',
  'How do I connect Relay to Claude Desktop?',
  'Which of the 37 tools can send or change messages?',
  'What are the security risks of using Relay?',
];

const escapeAttr = s => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

export const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>Relay AI</title>
<meta name="description" content="Ask questions about relay-whatsapp-mcp: setup, failover, the 37 WhatsApp MCP tools and security. Free, no login.">
<link rel="stylesheet" href="/style.css">
</head>
<body>
<header class="top">
  <div>
    <h1>Relay AI <span class="tag">docs assistant</span></h1>
    <p>Ask anything about <a href="${REPO}" target="_blank" rel="noopener">relay-whatsapp-mcp</a>: setup, failover, the 37 tools, security.</p>
  </div>
  <button id="reset" type="button" class="ghost">New chat</button>
</header>
<main id="main">
  <div id="log" aria-live="polite"></div>
  <div id="starters" class="starters">
    <p>Try one of these:</p>
    ${STARTERS.map(q => `<button type="button" class="starter" data-q="${escapeAttr(q)}">${escapeAttr(q)}</button>`).join('\n    ')}
  </div>
</main>
<footer>
  <form id="ask">
    <textarea id="q" rows="1" maxlength="4000" placeholder="Ask about Relay…" aria-label="Your question" required></textarea>
    <button id="send" type="submit">Send</button>
    <button id="stop" type="button" class="ghost" hidden>Stop</button>
  </form>
  <p class="note"><span id="status"></span>Answers are generated from Relay's docs by Cloudflare Workers AI and can be wrong: check the <a href="${REPO}#readme" target="_blank" rel="noopener">README</a>. Your chat is saved only in this browser. Don't paste keys or private messages.</p>
</footer>
<script src="/app.js"></script>
</body>
</html>
`;

export const PAGE_CSS = `:root {
  --bg: #0d1117; --panel: #161b22; --border: #30363d; --text: #e6edf3; --muted: #8b949e;
  --accent: #2ea043; --accent-hover: #3fb950; --user: #1f3a5f; --error: #f85149; --code: #0b0f14;
  color-scheme: dark;
}
* { box-sizing: border-box; }
html, body { height: 100%; }
body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; display: flex; flex-direction: column; }
a { color: #58a6ff; }
.top { display: flex; gap: 12px; align-items: center; justify-content: space-between; padding: 14px 16px; border-bottom: 1px solid var(--border); max-width: 860px; width: 100%; margin: 0 auto; }
.top h1 { margin: 0; font-size: 1.25rem; }
.top p { margin: 2px 0 0; color: var(--muted); font-size: .92rem; }
.tag { font-size: .7rem; font-weight: 500; color: var(--muted); border: 1px solid var(--border); border-radius: 999px; padding: 1px 8px; vertical-align: middle; }
main { flex: 1; overflow-y: auto; width: 100%; max-width: 860px; margin: 0 auto; padding: 16px; }
#log { display: flex; flex-direction: column; gap: 12px; }
.msg { padding: 10px 14px; border-radius: 12px; max-width: 100%; overflow-wrap: anywhere; }
.msg.user { align-self: flex-end; background: var(--user); white-space: pre-wrap; max-width: 85%; }
.msg.assistant { background: var(--panel); border: 1px solid var(--border); }
.msg.assistant > :first-child { margin-top: 0; } .msg.assistant > :last-child { margin-bottom: 0; }
.msg.pending:empty::after { content: "Thinking…"; color: var(--muted); }
.msg.error { border-color: var(--error); color: var(--error); }
.msg pre { background: var(--code); border: 1px solid var(--border); border-radius: 8px; padding: 10px; overflow-x: auto; }
.msg code { font: .88em/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; }
.msg :not(pre) > code { background: var(--code); padding: 1px 5px; border-radius: 5px; }
.msg h3, .msg h4, .msg h5, .msg h6 { margin: .8em 0 .3em; font-size: 1rem; }
.msg ul, .msg ol { padding-left: 1.3em; }
.starters { display: flex; flex-direction: column; gap: 8px; align-items: flex-start; }
.starters p { margin: 0 0 4px; color: var(--muted); }
.starter { text-align: left; background: var(--panel); color: var(--text); border: 1px solid var(--border); border-radius: 10px; padding: 8px 12px; font: inherit; cursor: pointer; }
.starter:hover { border-color: var(--accent); }
footer { border-top: 1px solid var(--border); width: 100%; max-width: 860px; margin: 0 auto; padding: 12px 16px 14px; }
form { display: flex; gap: 8px; align-items: flex-end; }
textarea { flex: 1; resize: none; max-height: 40vh; background: var(--panel); color: var(--text); border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; font: inherit; }
textarea:focus, button:focus-visible { outline: 2px solid #58a6ff; outline-offset: 1px; }
button { font: inherit; border-radius: 10px; padding: 10px 16px; border: 1px solid transparent; cursor: pointer; background: var(--accent); color: #fff; font-weight: 600; }
button:hover { background: var(--accent-hover); }
button:disabled { opacity: .5; cursor: default; }
button.ghost { background: transparent; color: var(--text); border-color: var(--border); font-weight: 500; }
button.ghost:hover { border-color: var(--muted); }
.note { margin: 8px 0 0; font-size: .8rem; color: var(--muted); }
#status:not(:empty)::after { content: " "; }
@media (max-width: 560px) { .top p { display: none; } .msg.user { max-width: 92%; } }
`;

// ---------- browser code (serialized into /app.js) ----------

export function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// Inline Markdown on text that is ALREADY escaped: `code`, **bold**, [text](https://link).
export function inlineMarkdown(escaped) {
  return escaped.split(/(`[^`]+`)/).map((part, i) => {
    if (i % 2) return '<code>' + part.slice(1, -1) + '</code>';
    return part
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)"]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  }).join('');
}

// A deliberately small Markdown renderer. Everything is escaped first, so model output
// can never inject HTML or scripts; only the tags created here reach the page.
export function renderMarkdown(src) {
  const out = [];
  const lines = String(src).split('\n');
  const listItem = /^\s*([-*]|\d+\.)\s+/;
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
    while (i < lines.length && lines[i].trim() && !/^\s*```/.test(lines[i]) && !/^#{1,4}\s/.test(lines[i]) && !listItem.test(lines[i])) para.push(lines[i++]);
    out.push('<p>' + inlineMarkdown(escapeHtml(para.join('\n'))).replace(/\n/g, '<br>') + '</p>');
  }
  return out.join('');
}

export function client() {
  const STORE = 'relay-ai-chat-v1';
  const $ = id => document.getElementById(id);
  const log = $('log'), form = $('ask'), q = $('q'), send = $('send'), stop = $('stop'), status = $('status'), starters = $('starters'), main = $('main');
  let controller = null;

  const load = () => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE));
      return Array.isArray(saved) ? saved.filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string') : [];
    } catch { return []; }
  };
  const save = () => { try { localStorage.setItem(STORE, JSON.stringify(messages.slice(-40))); } catch { /* private mode: chat still works */ } };
  let messages = load();

  const scroll = () => { main.scrollTop = main.scrollHeight; };
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
  function grow() { q.style.height = 'auto'; q.style.height = q.scrollHeight + 'px'; }

  async function ask(text) {
    text = text.trim();
    if (!text || controller) return;
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
      const left = res.headers.get('X-RateLimit-Remaining');
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
      status.textContent = left !== null ? left + ' free question' + (left === '1' ? '' : 's') + ' left for your network right now.' : '';
    } catch (error) {
      if (error.name === 'AbortError' && answer) {
        answer += '\n\n(stopped)';
        out.innerHTML = renderMarkdown(answer);
        messages.push({ role: 'assistant', content: answer });
      } else {
        messages.pop(); // the question was not answered; let the visitor send it again
        out.classList.add('error');
        out.textContent = error.name === 'AbortError' ? 'Stopped.' : error.message;
        if (!q.value) { q.value = text; grow(); }
      }
      save();
    } finally {
      out.classList.remove('pending');
      controller = null;
      busy(false);
      q.focus();
    }
  }

  form.addEventListener('submit', e => { e.preventDefault(); ask(q.value); });
  q.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); ask(q.value); } });
  q.addEventListener('input', grow);
  stop.addEventListener('click', () => controller?.abort());
  $('reset').addEventListener('click', () => {
    controller?.abort();
    messages = [];
    try { localStorage.removeItem(STORE); } catch { /* ignore */ }
    status.textContent = '';
    renderAll();
    q.focus();
  });
  for (const b of starters.querySelectorAll('.starter')) b.addEventListener('click', () => ask(b.dataset.q));
  renderAll();
}

export const PAGE_JS = `'use strict';
${escapeHtml.toString()}
${inlineMarkdown.toString()}
${renderMarkdown.toString()}
(${client.toString()})();
`;
