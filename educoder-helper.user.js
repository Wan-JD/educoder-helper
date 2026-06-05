// ==UserScript==
// @name         头歌实践教学平台助手
// @namespace    https://github.com/Wan-JD/educoder-helper
// @version      1.0.4
// @description  解除复制粘贴限制；实训页一键复制/导出代码、测试用例汇总；课堂实验截止提醒
// @author       Wan-JD
// @license      MIT
// @homepageURL  https://github.com/Wan-JD/educoder-helper
// @supportURL   https://github.com/Wan-JD/educoder-helper/issues
// @contributionURL https://ifdian.net/a/jd0512
// @updateURL    https://github.com/Wan-JD/educoder-helper/raw/main/educoder-helper.user.js
// @downloadURL  https://github.com/Wan-JD/educoder-helper/raw/main/educoder-helper.user.js
// @match        *://*.educoder.net/*
// @match        *://data.educoder.net/*
// @connect      data.educoder.net
// @run-at       document-start
// @grant        GM_addStyle
// @grant        GM_setClipboard
// @grant        GM_notification
// ==/UserScript==

(function () {
  'use strict';

  const STORAGE_KEY_INFORM = 'educoder_helper_last_inform_id';
  const HOTKEYS = new Set(['c', 'v', 'x', 'a', 'z', 'y', 's']);

  // ─── 1. 复制/粘贴：在平台脚本之前截断 ─────────────────────
  function installClipboardGuard() {
    const stop = (e) => {
      e.stopImmediatePropagation();
    };

    ['copy', 'cut', 'paste', 'beforecopy', 'beforecut', 'beforepaste', 'selectstart', 'contextmenu'].forEach(
      (type) => document.addEventListener(type, stop, true)
    );

    window.addEventListener(
      'keydown',
      (e) => {
        const mod = e.ctrlKey || e.metaKey;
        if (!mod) return;
        const k = e.key.toLowerCase();
        if (HOTKEYS.has(k)) e.stopImmediatePropagation();
      },
      true
    );

    document.addEventListener(
      'copy',
      (e) => {
        e.stopImmediatePropagation();
        try {
          const text = window.getSelection()?.toString();
          if (!text || !e.clipboardData) return;
          const cur = e.clipboardData.getData('text/plain');
          if (!cur || !cur.trim()) {
            e.clipboardData.setData('text/plain', text);
          }
        } catch (_) {
          /* ignore */
        }
      },
      true
    );
  }

  function patchEditors() {
    document.querySelectorAll('.monaco-editor, .CodeMirror, [class*="editor"]').forEach((root) => {
      root.style.userSelect = 'text';
      root.style.webkitUserSelect = 'text';
    });

    document.querySelectorAll('textarea.inputarea, .monaco-editor textarea').forEach((ta) => {
      ta.removeAttribute('readonly');
      ta.removeAttribute('disabled');
      ta.readOnly = false;
      ta.disabled = false;
    });

    if (window.monaco?.editor) {
      monaco.editor.getEditors().forEach((ed) => {
        try {
          ed.updateOptions({ readOnly: false, domReadOnly: false });
        } catch (_) {
          /* ignore */
        }
      });
    }
  }

  const store = {
    homeworks: [],
    informs: [],
    taskMeta: null,
    repPaths: new Set(),
  };

  function tryParseJson(text) {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  function ingestUrl(url, data) {
    if (!data || data.status < 0) return;

    if (url.includes('homework_commons.json') && data.homework_commons?.rows) {
      store.homeworks = data.homework_commons.rows;
      scheduleHomeworkPanel();
    }

    if (url.includes('/informs.json') && data.informs?.rows) {
      store.informs = data.informs.rows;
      checkNewInforms(data.informs.rows);
    }

    if (url.match(/\/api\/tasks\/[^/]+\.json/) && (data.task || data.data)) {
      store.taskMeta = data.task || data.data;
    }

    if (url.includes('rep_content.json')) {
      const m = url.match(/[?&]path=([^&]+)/);
      if (m) store.repPaths.add(decodeURIComponent(m[1]));
    }
  }

  function hookNetwork() {
    const origFetch = window.fetch;
    window.fetch = async function (...args) {
      const res = await origFetch.apply(this, args);
      const url = String(args[0]);
      if (url.includes('educoder.net/api/')) {
        res
          .clone()
          .json()
          .then((j) => ingestUrl(url, j))
          .catch(() => {});
      }
      return res;
    };

    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (m, url, ...r) {
      this._eduUrl = url;
      return origOpen.call(this, m, url, ...r);
    };
    XMLHttpRequest.prototype.send = function (...args) {
      this.addEventListener('load', function () {
        const url = this._eduUrl || '';
        if (!url.includes('educoder.net/api/')) return;
        const data = tryParseJson(this.responseText);
        if (data) ingestUrl(url, data);
      });
      return origSend.apply(this, args);
    };
  }

  GM_addStyle(`
    #edu-helper-fab {
      position: fixed; right: 18px; bottom: 18px; z-index: 2147483646;
      width: 48px; height: 48px; border-radius: 50%; border: none;
      background: linear-gradient(135deg, #0ea5e9, #6366f1);
      color: #fff; font-size: 20px; box-shadow: 0 4px 18px rgba(14,165,233,.45);
    }
    #edu-helper-fab:hover { transform: scale(1.06); }
    #edu-helper-panel {
      position: fixed; right: 18px; bottom: 76px; z-index: 2147483646;
      width: min(380px, 92vw); max-height: 70vh; overflow: auto;
      background: #0f172a; color: #e2e8f0; border-radius: 12px;
      box-shadow: 0 12px 40px rgba(0,0,0,.35); display: none;
      font: 13px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
    }
    #edu-helper-panel.open { display: block; }
    .edu-hdr { padding: 12px 14px; border-bottom: 1px solid #334155; font-weight: 600; }
    .edu-body { padding: 10px 14px 14px; }
    .edu-btn {
      display: block; width: 100%; margin: 6px 0; padding: 8px 10px;
      border: none; border-radius: 8px; font-size: 13px;
      background: #1e293b; color: #e2e8f0; text-align: left;
    }
    .edu-btn:hover { background: #334155; }
    .edu-btn.primary { background: #2563eb; color: #fff; }
    .edu-btn.primary:hover { background: #1d4ed8; }
    .edu-muted { color: #94a3b8; font-size: 12px; margin: 8px 0; }
    .edu-support { text-align: center; margin-top: 4px; }
    .edu-support a { color: #7dd3fc; text-decoration: none; }
    .edu-support a:hover { text-decoration: underline; }
    .edu-pre {
      background: #020617; border: 1px solid #334155; border-radius: 8px;
      padding: 8px; max-height: 200px; overflow: auto; white-space: pre-wrap;
      word-break: break-all; font: 12px/1.4 ui-monospace, Consolas, monospace;
    }
    .edu-hw-item { padding: 8px 0; border-bottom: 1px solid #1e293b; }
    .edu-hw-item.urgent { color: #fca5a5; }
    .edu-hw-title { font-weight: 500; }
    .edu-toast {
      position: fixed; top: 16px; right: 16px; z-index: 2147483647;
      background: #14532d; color: #bbf7d0; padding: 10px 14px; border-radius: 8px;
      font-size: 13px; box-shadow: 0 4px 12px rgba(0,0,0,.2);
    }
  `);

  function toast(msg, ok = true) {
    const el = document.createElement('div');
    el.className = 'edu-toast';
    if (!ok) el.style.background = '#7f1d1d', el.style.color = '#fecaca';
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2800);
  }

  function getEditorText() {
    if (window.monaco?.editor) {
      const eds = monaco.editor.getEditors();
      if (eds.length) return eds.map((e) => e.getValue()).join('\n\n');
    }
    const ta = document.querySelector('textarea.inputarea') || document.querySelector('.monaco-editor textarea');
    if (ta?.value) return ta.value;
    const view = document.querySelector('.monaco-editor .view-lines');
    if (view) return view.innerText;
    return '';
  }

  function copyText(text) {
    if (!text) {
      toast('没有读到编辑器内容', false);
      return;
    }
    GM_setClipboard(text, { type: 'text/plain' });
    toast('已复制 ' + text.length + ' 字符');
  }

  function extractTestCases() {
    const blocks = [];
    const headings = [...document.querySelectorAll('h3, h4, strong, b, p')];
    headings.forEach((h) => {
      if (!/测试输入/.test(h.textContent)) return;
      const lines = [];
      let el = h.nextElementSibling;
      for (let i = 0; i < 8 && el; i++) {
        if (/预期输出/.test(el.textContent || '')) break;
        const items = el.querySelectorAll ? [...el.querySelectorAll('li')] : [];
        if (items.length) items.forEach((li) => lines.push(li.textContent.trim()));
        else if (el.tagName === 'PRE' || el.tagName === 'CODE') lines.push(el.textContent.trim());
        el = el.nextElementSibling;
      }
      if (lines.length) blocks.push(lines.join('\n'));
    });

    if (!blocks.length) {
      const body = document.body.innerText;
      const parts = body.split(/测试输入[：:]/).slice(1);
      parts.forEach((p) => {
        const chunk = p.split(/预期输出/)[0].trim().slice(0, 800);
        if (chunk) blocks.push(chunk);
      });
    }
    return blocks;
  }

  function showTestCases() {
    const blocks = extractTestCases();
    if (!blocks.length) {
      toast('本页未解析到测试用例', false);
      return;
    }
    const text = blocks.map((b, i) => `=== 测试集 ${i + 1} ===\n${b}`).join('\n\n');
    copyText(text);
    const pre = document.getElementById('edu-helper-pre');
    if (pre) pre.textContent = text;
  }

  function parseTaskContext() {
    const m = location.pathname.match(/\/tasks\/([^/]+)\/(\d+)\/([^/?]+)/);
    if (!m) return null;
    const qs = new URLSearchParams(location.search);
    return {
      courseId: m[1],
      homeworkId: m[2],
      taskSecret: m[3],
      coursesId: qs.get('coursesId') || m[1],
    };
  }

  async function fetchRepFile(ctx, path) {
    const url =
      `https://data.educoder.net/api/tasks/${ctx.taskSecret}/rep_content.json?` +
      `path=${encodeURIComponent(path)}&homework_common_id=${ctx.homeworkId}`;
    const res = await fetch(url, { credentials: 'include' });
    const j = await res.json();
    if (j.status < 0) throw new Error(j.message || 'API 错误');
    return j.content ?? j.data?.content ?? j.rep_content?.content ?? JSON.stringify(j);
  }

  async function exportProjectFiles() {
    const ctx = parseTaskContext();
    if (!ctx) {
      copyText(getEditorText());
      return;
    }

    const paths = [...store.repPaths];
    if (!paths.length) {
      const guess = getEditorText();
      if (guess) {
        copyText(guess);
        return;
      }
      toast('未发现文件列表，请先在编辑器里打开过文件', false);
      return;
    }

    const files = {};
    for (const p of paths) {
      try {
        files[p] = await fetchRepFile(ctx, p);
      } catch (e) {
        files[p] = `/* 拉取失败: ${e.message} */`;
      }
    }

    const bundle = Object.entries(files)
      .map(([p, c]) => `\n/* ========== ${p} ========== */\n${c}`)
      .join('\n');
    copyText(bundle);
    toast('已合并导出 ' + paths.length + ' 个文件到剪贴板');
  }

  let hwPanelScheduled = false;
  function scheduleHomeworkPanel() {
    if (hwPanelScheduled) return;
    hwPanelScheduled = true;
    setTimeout(renderHomeworkHints, 800);
  }

  function renderHomeworkHints() {
    if (!location.pathname.includes('shixun_homework') || !store.homeworks.length) return;

    const host = document.querySelector('.edu-hw-host');
    if (host) host.remove();

    const box = document.createElement('div');
    box.className = 'edu-hw-host';
    box.style.cssText =
      'margin:12px 0;padding:12px 14px;background:#eff6ff;border:1px solid #93c5fd;border-radius:10px;font-size:13px;';
    const now = Date.now();
    const items = store.homeworks
      .map((h) => {
        const end = h.end_time || h.end_at || h.deadline;
        const endMs = end ? new Date(end).getTime() : NaN;
        return { ...h, endMs };
      })
      .filter((h) => !isNaN(h.endMs))
      .sort((a, b) => a.endMs - b.endMs);

    const lines = items.slice(0, 8).map((h) => {
      const title = h.name || h.title || h.homework_name || '未命名';
      const left = h.endMs - now;
      const days = Math.ceil(left / 86400000);
      const urgent = left > 0 && left < 3 * 86400000;
      const status =
        left < 0 ? '已截止' : days <= 1 ? '不足 1 天' : `剩余约 ${days} 天`;
      return `<div class="edu-hw-item${urgent ? ' urgent' : ''}"><span class="edu-hw-title">${esc(
        title
      )}</span> · ${status}</div>`;
    });

    box.innerHTML =
      '<b>📅 实验截止（助手）</b><div style="margin-top:8px">' +
      (lines.join('') || '<span style="color:#64748b">暂无截止数据</span>') +
      '</div>';
    const anchor =
      document.querySelector('[class*="homework"]') ||
      document.querySelector('main') ||
      document.querySelector('.content') ||
      document.body.firstElementChild;
    if (anchor?.parentNode) anchor.parentNode.insertBefore(box, anchor);
  }

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function checkNewInforms(rows) {
    if (!rows?.length || !location.pathname.includes('announcement')) return;
    const latest = rows[0];
    const id = latest.id || latest.inform_id || latest.wid;
    if (!id) return;
    const last = localStorage.getItem(STORAGE_KEY_INFORM);
    if (last === String(id)) return;
    localStorage.setItem(STORAGE_KEY_INFORM, String(id));
    if (last) {
      const title = latest.title || latest.subject || '新公告';
      try {
        GM_notification({ title: '头歌 · 新公告', text: title, timeout: 5000 });
      } catch {
        toast('新公告：' + title);
      }
    }
  }

  function buildFab() {
    if (document.getElementById('edu-helper-fab')) return;

    const fab = document.createElement('button');
    fab.id = 'edu-helper-fab';
    fab.title = '头歌助手';
    fab.textContent = '⚡';

    const panel = document.createElement('div');
    panel.id = 'edu-helper-panel';
    panel.innerHTML = `
      <div class="edu-hdr">头歌助手</div>
      <div class="edu-body">
        <button class="edu-btn primary" data-act="copy">📋 复制当前编辑器全部代码</button>
        <button class="edu-btn" data-act="export">📦 导出关卡文件（剪贴板）</button>
        <button class="edu-btn" data-act="tests">🧪 汇总本页测试用例并复制</button>
        <button class="edu-btn" data-act="patch">🔧 重新解除粘贴限制</button>
        <p class="edu-muted">粘贴仍失败时：先点编辑器内部，再 Ctrl+V；或点「重新解除」。</p>
        <p class="edu-muted edu-support"><a href="https://ifdian.net/a/jd0512" target="_blank" rel="noopener noreferrer">爱发电支持作者</a></p>
        <pre class="edu-pre" id="edu-helper-pre" style="display:none"></pre>
      </div>
    `;

    fab.addEventListener('click', () => panel.classList.toggle('open'));
    panel.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset?.act;
      if (!act) return;
      if (act === 'copy') copyText(getEditorText());
      if (act === 'export') exportProjectFiles();
      if (act === 'tests') {
        showTestCases();
        const pre = document.getElementById('edu-helper-pre');
        if (pre) pre.style.display = 'block';
      }
      if (act === 'patch') {
        patchEditors();
        toast('已重新应用粘贴补丁');
      }
    });

    const mount = () => {
      document.body.appendChild(fab);
      document.body.appendChild(panel);
    };
    if (document.body) mount();
    else document.addEventListener('DOMContentLoaded', mount);
  }

  installClipboardGuard();
  hookNetwork();

  const boot = () => {
    buildFab();
    patchEditors();
    setInterval(patchEditors, 2000);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
