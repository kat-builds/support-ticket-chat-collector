// ==UserScript==
// @name         Conversation Collector for Zendesk & LiveChat
// @namespace    https://katrinaops.com
// @version      2.1.0
// @description  Collect Zendesk tickets and LiveChat transcripts as clean Markdown for QA reviews and AI analysis.
// @author       Katrina Lin
// @homepageURL  https://katrinaops.com
// @downloadURL  https://katrinaops.com/tools/conversation-collector.user.js
// @updateURL    https://katrinaops.com/tools/conversation-collector.user.js
// @match        https://*.zendesk.com/agent/*
// @match        https://*.livechat.com/*
// @match        https://*.livechatinc.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_setClipboard
// @grant        GM_addValueChangeListener
// @run-at       document-idle
// @noframes
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Platform
  // ---------------------------------------------------------------------------

  const HOST = location.hostname;
  const PLATFORM = HOST.endsWith('zendesk.com')
    ? 'zendesk'
    : /(^|\.)livechat(inc)?\.com$/.test(HOST)
      ? 'livechat'
      : null;

  if (!PLATFORM) return;

  const PLATFORM_NAME = { zendesk: 'Zendesk', livechat: 'LiveChat' };
  const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const SHORTCUT = (key) => (IS_MAC ? `⌥⇧${key}` : `Alt+Shift+${key}`);

  // ---------------------------------------------------------------------------
  // Storage
  // ---------------------------------------------------------------------------

  const KEY_ITEMS = 'cc_items_v2';
  const KEY_UI = 'cc_ui_v2';
  const LEGACY_KEY = 'conversation_collector_items';
  const DEFAULT_UI = { open: false, right: 20, bottom: 20, redact: true };

  function getItems() {
    let items = GM_getValue(KEY_ITEMS, null);
    if (items === null) {
      items = GM_getValue(LEGACY_KEY, []); // migrate v1 data once
      GM_setValue(KEY_ITEMS, items);
    }
    return Array.isArray(items) ? items : [];
  }

  function setItems(items) {
    GM_setValue(KEY_ITEMS, items);
    render();
  }

  function getUi() {
    return { ...DEFAULT_UI, ...GM_getValue(KEY_UI, {}) };
  }

  function setUi(patch) {
    GM_setValue(KEY_UI, { ...getUi(), ...patch });
  }

  // ---------------------------------------------------------------------------
  // Text helpers
  // ---------------------------------------------------------------------------

  function cleanText(text) {
    return String(text || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .split('\n')
      .map((line) => line.trim())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function absoluteUrl(href) {
    try {
      return new URL(href, location.href).href;
    } catch {
      return href;
    }
  }

  function isZendeskUiLink(href) {
    return [
      '/agent/tickets/users/',
      '/agent/filters/',
      '/agent/search/',
      '/agent/views/',
      '/admin/',
      '/tickets/tickets/',
      '/agent/tickets/tickets/',
    ].some((part) => href.includes(part));
  }

  function linksToMarkdown(root) {
    root.querySelectorAll('a[href]').forEach((link) => {
      const text = cleanText(link.textContent);
      const raw = link.getAttribute('href');
      const href = raw ? absoluteUrl(raw) : '';
      let output = text;

      if (href && !(PLATFORM === 'zendesk' && isZendeskUiLink(href))) {
        output = text && text !== href ? `[${text}](${href})` : href;
      }
      link.replaceWith(document.createTextNode(output));
    });
  }

  const BLOCK_TAGS = new Set([
    'P', 'DIV', 'LI', 'UL', 'OL', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'TR', 'TABLE', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'BLOCKQUOTE', 'PRE',
  ]);
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'BUTTON']);

  // Layout-aware text extraction (innerText on detached clones loses line breaks)
  function toText(root) {
    if (!root) return '';
    const clone = root.cloneNode(true);
    linksToMarkdown(clone);

    let out = '';
    const walk = (node, inPre) => {
      if (node.nodeType === Node.TEXT_NODE) {
        out += inPre ? node.nodeValue : node.nodeValue.replace(/\s+/g, ' ');
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;

      const tag = node.tagName ? node.tagName.toUpperCase() : '';
      if (SKIP_TAGS.has(tag)) return;
      if (tag === 'BR') {
        out += '\n';
        return;
      }

      const block = BLOCK_TAGS.has(tag);
      if (block) out += '\n';
      if (tag === 'LI') out += '- ';
      node.childNodes.forEach((child) => walk(child, inPre || tag === 'PRE'));
      if (block) out += '\n';
    };

    walk(clone, false);
    return cleanText(out);
  }

  function simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
    }
    return Math.abs(hash).toString(36);
  }

  const isVisible = (el) =>
    !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);

  // ---------------------------------------------------------------------------
  // Masking (basic — always review before sharing)
  // ---------------------------------------------------------------------------

  const URL_RE = /https?:\/\/[^\s)\]]+/g;

  function maskPlain(text) {
    return text
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
      .replace(/\+?\d[\d\s().-]{7,18}\d/g, (match) => {
        const digits = match.replace(/\D/g, '');
        if (digits.length < 9 || digits.length > 15) return match;
        if (/^\d{4}-\d{2}-\d{2}/.test(match)) return match; // ISO dates
        return '[phone]';
      });
  }

  function mask(text) {
    const source = String(text || '');
    let result = '';
    let last = 0;
    for (const match of source.matchAll(URL_RE)) {
      result += maskPlain(source.slice(last, match.index)) + match[0];
      last = match.index + match[0].length;
    }
    return result + maskPlain(source.slice(last));
  }

  // ---------------------------------------------------------------------------
  // Zendesk
  // ---------------------------------------------------------------------------

  function getZendeskTicketId() {
    const match = location.pathname.match(/tickets\/(\d+)/);
    return match ? match[1] : null;
  }

  function getZendeskSubject() {
    const el = document.querySelector('[data-test-id="omni-header-subject"]');
    return cleanText((el && (el.value || el.textContent)) || '');
  }

  function findZendeskConversationRoot() {
    const selectors = [
      '[data-test-id="omni-log-container"]',
      '[data-test-id="ticket-conversation"]',
      '[data-test-id*="conversation"]',
      '[data-test-id*="comments"]',
      '[aria-label*="onversation"]',
    ];

    for (const selector of selectors) {
      for (const el of document.querySelectorAll(selector)) {
        // Agent Workspace keeps other ticket tabs in the DOM — only use the visible one
        if (isVisible(el) && (el.textContent || '').trim().length > 100) return el;
      }
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // LiveChat
  // ---------------------------------------------------------------------------

  function getLiveChatId() {
    const urlMatch = location.href.match(/(TK[A-Z0-9]+)/i);
    if (urlMatch) return urlMatch[1];

    const reaction = document.querySelector('[data-testid*="-reaction"]');
    const idMatch = reaction && (reaction.getAttribute('data-testid') || '').match(/^(TK[A-Z0-9]+)_/i);
    if (idMatch) return idMatch[1];

    return `LC-${simpleHash(location.pathname)}`;
  }

  function findLiveChatSpeakerName(el) {
    let current = el;
    for (let level = 0; level < 8 && current; level++) {
      for (const candidate of current.querySelectorAll('.privacy-masker')) {
        const text = cleanText(candidate.textContent);
        if (
          text &&
          text.length <= 80 &&
          !text.includes('\n') &&
          !/Started -|Archived -|Chat rated/.test(text)
        ) {
          return text;
        }
      }
      current = current.parentElement;
    }
    return '';
  }

  function extractLiveChatAttachment(el) {
    const image = el.querySelector('img[src]');
    if (image && image.src) return `[Image] ${image.src}`;

    const link = el.querySelector('a[href]');
    if (link) return `[Attachment] ${absoluteUrl(link.getAttribute('href'))}`;
    return '';
  }

  function getLiveChatConversation() {
    const elements = document.querySelectorAll(
      [
        '[data-testid="agent-message"]',
        '[data-testid="customer-message"]',
        '[data-testid="agent-attachment"]',
        '[data-testid="customer-attachment"]',
      ].join(',')
    );

    const output = [];
    let lastSpeaker = null;

    for (const el of elements) {
      const testId = el.getAttribute('data-testid') || '';
      const role = testId.startsWith('agent-') ? 'Agent' : testId.startsWith('customer-') ? 'Customer' : 'Unknown';
      const speaker = findLiveChatSpeakerName(el) || role;
      const content = testId.includes('attachment') ? extractLiveChatAttachment(el) : toText(el);

      if (!content) continue;

      if (speaker !== lastSpeaker) {
        if (output.length) output.push('');
        output.push(`**${speaker}** (${role.toLowerCase()}):`);
        lastSpeaker = speaker;
      }
      output.push(content);
    }

    return cleanText(output.join('\n'));
  }

  // ---------------------------------------------------------------------------
  // Context + collecting
  // ---------------------------------------------------------------------------

  function currentContext() {
    if (PLATFORM === 'zendesk') {
      const id = getZendeskTicketId();
      return id ? { id, label: `Ticket #${id}`, title: getZendeskSubject() } : null;
    }
    const id = getLiveChatId();
    return { id, label: `Chat ${id}`, title: '' };
  }

  function getSelectedText() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || !cleanText(selection.toString())) return '';

    const container = document.createElement('div');
    for (let i = 0; i < selection.rangeCount; i++) {
      try {
        container.appendChild(selection.getRangeAt(i).cloneContents());
      } catch {
        /* ignore */
      }
    }
    return toText(container) || cleanText(selection.toString());
  }

  function upsert(item) {
    const items = getItems();
    const index = items.findIndex((x) => x.key === item.key);
    if (index >= 0) items[index] = item;
    else items.push(item);
    setItems(items);
    toast(`${index >= 0 ? 'Updated' : 'Saved'} ${item.label} (${items.length} total)`, 'success');
  }

  function collectConversation() {
    const ctx = currentContext();
    if (!ctx) {
      toast('Open a ticket first, then save it.', 'error');
      return;
    }

    let text = '';
    if (PLATFORM === 'zendesk') {
      text = toText(findZendeskConversationRoot());
    } else {
      text = getLiveChatConversation();
    }

    if (!text) {
      toast('No conversation found here. Select the messages and use Save selected text instead.', 'error');
      return;
    }

    upsert({
      key: `${PLATFORM}-${ctx.id}`,
      type: PLATFORM,
      id: ctx.id,
      label: ctx.label,
      title: ctx.title,
      url: location.href,
      collectedAt: new Date().toISOString(),
      mode: 'full',
      text,
    });
  }

  function collectSelection() {
    const text = getSelectedText();
    if (!text) {
      toast('Select some text on the page first.', 'error');
      return;
    }

    const ctx = currentContext();
    if (!ctx) {
      toast('Open a ticket first, then save the selected text.', 'error');
      return;
    }

    // Excerpts get their own key so they never overwrite a full conversation
    upsert({
      key: `${PLATFORM}-${ctx.id}-sel-${simpleHash(text)}`,
      type: PLATFORM,
      id: ctx.id,
      label: `${ctx.label} (selected text)`,
      title: ctx.title,
      url: location.href,
      collectedAt: new Date().toISOString(),
      mode: 'selected',
      text,
    });
  }

  // ---------------------------------------------------------------------------
  // Export
  // ---------------------------------------------------------------------------

  function buildMarkdown(items, masked) {
    const f = (s) => (masked ? mask(s) : s || '');
    const header = [
      '# Conversation export',
      '',
      `Exported ${new Date().toISOString()}, ${items.length} item(s)${masked ? ', emails and phone numbers masked' : ''}.`,
      '',
    ].join('\n');

    const blocks = items.map((item) =>
      [
        `## ${PLATFORM_NAME[item.type] || item.type}: ${item.label}${item.title ? ` (${f(item.title)})` : ''}`,
        '',
        `- Source: ${item.url}`,
        `- Collected: ${item.collectedAt}`,
        `- Scope: ${item.mode === 'selected' ? 'Selected text' : 'Full conversation'}`,
        '',
        f(item.text),
      ].join('\n')
    );

    return `${header}\n${blocks.join('\n\n---\n\n')}\n`;
  }

  function buildJson(items, masked) {
    const f = (s) => (masked ? mask(s) : s || '');
    return JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        masked,
        items: items.map((item) => ({ ...item, title: f(item.title), text: f(item.text) })),
      },
      null,
      2
    );
  }

  async function copyText(text) {
    if (typeof GM_setClipboard === 'function') {
      GM_setClipboard(text, 'text');
      return true;
    }
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const area = document.createElement('textarea');
      area.value = text;
      Object.assign(area.style, { position: 'fixed', left: '-9999px', top: '0' });
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      return ok;
    }
  }

  function download(filename, content, type) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const today = () => new Date().toISOString().slice(0, 10);

  // ---------------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------------

  const NOUN = PLATFORM === 'zendesk' ? 'ticket' : 'chat';

  const ICONS = {
    expand: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 15l6-6 6 6"/></svg>',
    logo: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h16M4 12h10M4 19h6"/></svg>',
    minimize: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>',
    remove: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  };

  const CSS = `
    :host { all: initial; }
    *, *::before, *::after { box-sizing: border-box; }
    button { font: inherit; color: inherit; }

    .dock, .toast {
      --paper: #ffffff;
      --paper-2: #f5f7f8;
      --ink: #1e2a33;
      --ink-2: #33414c;
      --muted: #66737d;
      --line: #dde3e7;
      --cobalt: #2b59c3;
      --cobalt-2: #2349a3;
      --mark: #ffe58a;
      --ok: #1a7f5a;
      --ok-soft: #e3f4ec;
      --danger: #c2352b;
      --shadow: 0 1px 2px rgba(30,42,51,.08), 0 10px 28px -10px rgba(30,42,51,.28);
      font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      font-size: 13px;
      line-height: 1.45;
      color: var(--ink);
      -webkit-font-smoothing: antialiased;
    }

    .dock { position: fixed; right: 20px; bottom: 20px; z-index: 2147483646; }
    .dock.dragging { user-select: none; }
    .dock:not(.is-open) .panel { display: none; }
    .dock.is-open .launcher { display: none; }

    /* Launcher */
    .launcher {
      display: inline-flex; align-items: stretch;
      border: 1px solid var(--line); border-radius: 12px;
      background: var(--paper); box-shadow: var(--shadow);
      overflow: hidden; cursor: grab;
    }
    .launcher button {
      display: inline-flex; align-items: center; gap: 9px;
      height: 42px; border: 0; background: transparent; color: var(--ink);
      font-weight: 600; cursor: pointer;
    }
    .launcher button:hover:not(:disabled) { background: var(--paper-2); }
    .launcher button:disabled { color: var(--muted); cursor: default; }
    .launcher button:focus-visible { outline: 2px solid var(--cobalt); outline-offset: -2px; }
    .quick { padding: 0 14px 0 9px; }
    .open { padding: 0 10px 0 10px; border-left: 1px solid var(--line) !important; color: var(--muted) !important; }

    .logo {
      width: 24px; height: 24px; flex: none;
      display: grid; place-items: center;
      border-radius: 7px; background: var(--ink); color: #fff;
    }

    /* The one bold element: a highlighter-style count */
    .mark {
      min-width: 24px; height: 22px; padding: 0 7px;
      display: inline-grid; place-items: center;
      border-radius: 5px; background: var(--mark); color: var(--ink);
      font-weight: 700; font-size: 12px; font-variant-numeric: tabular-nums;
      transform: rotate(-2deg);
    }
    .mark.zero { background: var(--paper-2); color: var(--muted); transform: none; }
    .mark.bump { animation: bump .35s ease-out; }
    @keyframes bump { 40% { transform: rotate(-2deg) scale(1.2); } }

    /* Panel */
    .panel {
      width: 340px; max-width: calc(100vw - 16px);
      max-height: min(560px, calc(100vh - 16px));
      display: flex; flex-direction: column;
      background: var(--paper); border: 1px solid var(--line);
      border-radius: 14px; box-shadow: var(--shadow); overflow: hidden;
      animation: open .16s ease-out;
    }
    @keyframes open { from { opacity: 0; transform: translateY(6px); } }

    .head {
      display: flex; align-items: center; justify-content: space-between; gap: 8px;
      padding: 12px 10px 12px 14px; cursor: grab;
    }
    .brand { display: flex; align-items: center; gap: 10px; min-width: 0; }
    .brand-text { min-width: 0; }
    .title { font-weight: 650; font-size: 14px; letter-spacing: -.01em; }
    .context { display: flex; align-items: center; gap: 6px; min-width: 0; font-size: 12px; color: var(--muted); }
    .context-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .status { flex: none; font-size: 11px; font-weight: 600; padding: 0 7px; border-radius: 999px; background: var(--ok-soft); color: var(--ok); }
    .status[hidden] { display: none; }

    .icon-btn {
      width: 28px; height: 28px; flex: none;
      display: grid; place-items: center;
      border: 0; border-radius: 8px; background: transparent; color: var(--muted); cursor: pointer;
    }
    .icon-btn:hover { background: var(--paper-2); color: var(--ink); }

    .actions { display: grid; grid-template-columns: 1fr; gap: 8px; padding: 2px 14px 14px; }

    .btn {
      display: inline-flex; align-items: center; justify-content: center; gap: 8px;
      height: 36px; padding: 0 12px;
      border: 1px solid var(--line); border-radius: 9px;
      background: var(--paper); color: var(--ink);
      font-weight: 550; white-space: nowrap; cursor: pointer;
      transition: background .12s, border-color .12s;
    }
    .btn:hover { background: var(--paper-2); border-color: #c7d0d6; }
    .btn:active { transform: translateY(1px); }
    .btn:disabled { opacity: .45; cursor: not-allowed; transform: none; }
    .btn-primary { background: var(--cobalt); border-color: var(--cobalt); color: #fff; }
    .btn-primary:hover { background: var(--cobalt-2); border-color: var(--cobalt-2); }
    .btn-ink { background: var(--ink); border-color: var(--ink); color: #fff; }
    .btn-ink:hover { background: var(--ink-2); border-color: var(--ink-2); }
    .btn.big { height: 46px; font-size: 14px; font-weight: 600; border-radius: 10px; }
    .alt { min-height: 24px; display: flex; align-items: center; justify-content: center; font-size: 12px; color: var(--muted); }
    .alt [hidden] { display: none; }
    .link-btn.accent { color: var(--cobalt); font-size: 12.5px; }
    .link-btn.accent:hover { color: var(--cobalt-2); text-decoration: underline; }

    kbd { font: 500 10.5px/1 inherit; font-family: inherit; opacity: .7; }

    .btn:focus-visible, .icon-btn:focus-visible,
    .link-btn:focus-visible, .item-title:focus-visible {
      outline: 2px solid var(--cobalt); outline-offset: 2px;
    }

    .list-head {
      display: flex; align-items: center; justify-content: space-between;
      padding: 10px 14px 6px; border-top: 1px solid var(--line);
      font-size: 12px; font-weight: 600; color: var(--ink-2);
    }
    .link-btn {
      border: 0; background: none; padding: 3px 6px; border-radius: 6px;
      font-size: 12px; font-weight: 550; color: var(--muted); cursor: pointer;
    }
    .link-btn:hover:not(:disabled) { color: var(--danger); }
    .link-btn:disabled { opacity: .4; cursor: default; }
    .link-btn.armed { background: var(--danger); color: #fff; }

    .list { list-style: none; margin: 0; padding: 0 8px 8px; overflow-y: auto; flex: 1; min-height: 64px; }
    .item { display: flex; align-items: center; gap: 10px; padding: 7px 6px; border-radius: 9px; }
    .item:hover { background: var(--paper-2); }
    .src {
      width: 28px; height: 28px; flex: none; display: grid; place-items: center;
      border-radius: 7px; font-size: 10.5px; font-weight: 700;
    }
    .src-zendesk { background: #e4efee; color: #0b4a4f; }
    .src-livechat { background: #fdeee3; color: #a4410e; }
    .item-main { flex: 1; min-width: 0; }
    .item-title {
      display: block; color: var(--ink); text-decoration: none; font-weight: 550;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; border-radius: 4px;
    }
    .item-title:hover { text-decoration: underline; }
    .item-meta { font-size: 11.5px; color: var(--muted); }
    .item .icon-btn { opacity: 0; }
    .item:hover .icon-btn, .item .icon-btn:focus-visible { opacity: 1; }

    .empty {
      margin: 2px 6px 6px; padding: 16px 12px;
      border: 1px dashed var(--line); border-radius: 10px;
      color: var(--muted); font-size: 12.5px; text-align: center;
    }

    .foot { display: grid; gap: 10px; padding: 12px 14px 14px; border-top: 1px solid var(--line); background: var(--paper-2); }
    .foot-actions { display: flex; gap: 6px; }
    .foot-actions .btn-ink { flex: 1; }

    .switch { display: flex; align-items: center; gap: 9px; font-size: 12.5px; cursor: pointer; user-select: none; }
    .switch input { position: absolute; opacity: 0; width: 1px; height: 1px; }
    .track { position: relative; width: 30px; height: 18px; flex: none; border-radius: 999px; background: #c3ccd2; transition: background .15s; }
    .track::after {
      content: ''; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px;
      border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.2); transition: transform .15s;
    }
    .switch input:checked + .track { background: var(--ok); }
    .switch input:checked + .track::after { transform: translateX(12px); }
    .switch input:focus-visible + .track { outline: 2px solid var(--cobalt); outline-offset: 2px; }
    .hint { font-size: 11.5px; color: var(--muted); margin-top: -6px; padding-left: 39px; }

    .toast {
      position: fixed; left: 50%; bottom: 24px; z-index: 2147483647;
      display: flex; align-items: center; gap: 9px; max-width: min(460px, calc(100vw - 32px));
      padding: 10px 14px; border-radius: 10px;
      background: var(--ink); color: #fff; box-shadow: var(--shadow);
      opacity: 0; transform: translate(-50%, 8px); pointer-events: none;
      transition: opacity .18s, transform .18s;
    }
    .toast.show { opacity: 1; transform: translate(-50%, 0); }
    .toast .dot { width: 8px; height: 8px; flex: none; border-radius: 50%; background: #9fb0bb; }
    .toast.success .dot { background: #5fd3a2; }
    .toast.error .dot { background: #ff8a80; }

    @media (prefers-reduced-motion: reduce) {
      .panel, .mark.bump { animation: none; }
      .toast, .btn, .track, .track::after { transition: none; }
    }
  `;

  const hostEl = document.createElement('div');
  hostEl.id = 'conversation-collector-root';
  const shadow = hostEl.attachShadow({ mode: 'open' });

  shadow.innerHTML = `
    <style>${CSS}</style>
    <div class="dock">
      <div class="launcher" data-ref="launcher">
        <button class="quick" type="button" data-ref="quickSave" title="Shortcut: ${SHORTCUT('C')}">
          <span class="logo">${ICONS.logo}</span>
          <span data-ref="quickLabel">Save ${NOUN}</span>
        </button>
        <button class="open" type="button" data-ref="openBtn" title="Show saved items and export" aria-label="Show saved items and export">
          <span class="mark" data-ref="launcherCount">0</span>${ICONS.expand}
        </button>
      </div>

      <section class="panel" role="dialog" aria-label="Conversation Collector">
        <header class="head" data-ref="head">
          <div class="brand">
            <span class="logo">${ICONS.logo}</span>
            <div class="brand-text">
              <div class="title">Conversation Collector</div>
              <div class="context">
                <span class="context-label" data-ref="context"></span>
                <span class="status" data-ref="status" hidden>Saved</span>
              </div>
            </div>
          </div>
          <button class="icon-btn" type="button" data-action="minimize" title="Minimize" aria-label="Minimize">${ICONS.minimize}</button>
        </header>

        <div class="actions">
          <button class="btn btn-primary big" type="button" data-action="collect" data-ref="saveBtn" title="Shortcut: ${SHORTCUT('C')}">Save this ${NOUN}</button>
          <div class="alt">
            <button class="link-btn accent" type="button" data-action="selection" data-ref="selectLink" title="Shortcut: ${SHORTCUT('S')}" hidden>Save only the selected text</button>
            <span data-ref="selectTip">To save only part of it, select the text first.</span>
          </div>
        </div>

        <div class="list-head">
          <span>Saved <span class="mark" data-ref="count">0</span></span>
          <button class="link-btn" type="button" data-action="clear" data-ref="clear">Clear all</button>
        </div>
        <ul class="list" data-ref="list"></ul>

        <footer class="foot">
          <label class="switch">
            <input type="checkbox" data-ref="mask">
            <span class="track"></span>
            <span>Mask emails and phone numbers</span>
          </label>
          <div class="hint">Applies to copy and download. Check the output before sharing.</div>
          <div class="foot-actions">
            <button class="btn btn-ink" type="button" data-action="copy">Copy all as Markdown</button>
            <button class="btn" type="button" data-action="md" title="Download Markdown">.md</button>
            <button class="btn" type="button" data-action="json" title="Download JSON">.json</button>
          </div>
        </footer>
      </section>
    </div>
    <div class="toast" data-ref="toast" role="status" aria-live="polite"><span class="dot"></span><span data-ref="toastText"></span></div>
  `;

  const dock = shadow.querySelector('.dock');
  const refs = {};
  shadow.querySelectorAll('[data-ref]').forEach((el) => (refs[el.dataset.ref] = el));

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function timeAgo(iso) {
    const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
    return new Date(iso).toLocaleDateString();
  }

  function formatSize(length) {
    return length < 1000 ? `${length} chars` : `${(length / 1000).toFixed(1)}k chars`;
  }

  // ---- Toast ----
  let toastTimer;
  function toast(message, kind = 'info') {
    refs.toastText.textContent = message;
    refs.toast.className = `toast show ${kind}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (refs.toast.className = `toast ${kind}`), 2400);
  }

  // ---- Position ----
  function placeDock(right, bottom) {
    const rect = dock.getBoundingClientRect();
    const maxRight = Math.max(8, window.innerWidth - rect.width - 8);
    const maxBottom = Math.max(8, window.innerHeight - rect.height - 8);
    const r = Math.min(Math.max(8, right), maxRight);
    const b = Math.min(Math.max(8, bottom), maxBottom);
    dock.style.right = `${r}px`;
    dock.style.bottom = `${b}px`;
    return { right: r, bottom: b };
  }

  function applyPosition() {
    const ui = getUi();
    placeDock(ui.right, ui.bottom);
  }

  let suppressClick = false;

  function enableDrag(handle) {
    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || event.target.closest('[data-action]')) return;

      const rect = dock.getBoundingClientRect();
      const start = {
        x: event.clientX,
        y: event.clientY,
        right: window.innerWidth - rect.right,
        bottom: window.innerHeight - rect.bottom,
      };
      let moved = false;

      const onMove = (e) => {
        const dx = e.clientX - start.x;
        const dy = e.clientY - start.y;
        if (!moved && Math.hypot(dx, dy) < 4) return;
        moved = true;
        dock.classList.add('dragging');
        placeDock(start.right - dx, start.bottom - dy);
      };

      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        dock.classList.remove('dragging');
        if (moved) {
          const r = dock.getBoundingClientRect();
          setUi({ right: window.innerWidth - r.right, bottom: window.innerHeight - r.bottom });
          suppressClick = true;
        }
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    });
  }

  // ---- Render ----
  let lastCount = null;

  function setCountMark(node, count) {
    node.textContent = count;
    node.classList.toggle('zero', count === 0);
    if (lastCount !== null && count > lastCount) {
      node.classList.remove('bump');
      void node.offsetWidth;
      node.classList.add('bump');
    }
  }

  function renderList(items) {
    if (!items.length) {
      const empty = el('li', 'empty', `Nothing saved yet. Open a ${PLATFORM === 'zendesk' ? 'ticket' : 'chat'} and select ${PLATFORM === 'zendesk' ? 'Save this ticket' : 'Save this chat'}.`);
      refs.list.replaceChildren(empty);
      return;
    }

    const rows = [...items].reverse().map((item) => {
      const li = el('li', 'item');
      li.appendChild(el('span', `src src-${item.type}`, item.type === 'zendesk' ? 'ZD' : 'LC'));

      const main = el('div', 'item-main');
      const link = el('a', 'item-title', item.label);
      link.href = item.url;
      link.target = '_blank';
      link.rel = 'noopener';
      if (item.title) link.title = item.title;
      main.appendChild(link);

      const scope = item.mode === 'selected' ? 'Selected text' : 'Full conversation';
      main.appendChild(el('div', 'item-meta', `${scope}, ${formatSize((item.text || '').length)}, ${timeAgo(item.collectedAt)}`));
      li.appendChild(main);

      const remove = el('button', 'icon-btn');
      remove.type = 'button';
      remove.innerHTML = ICONS.remove;
      remove.dataset.action = 'remove';
      remove.dataset.key = item.key;
      remove.title = `Remove ${item.label}`;
      remove.setAttribute('aria-label', `Remove ${item.label}`);
      li.appendChild(remove);

      return li;
    });

    refs.list.replaceChildren(...rows);
  }

  function render() {
    const items = getItems();
    const ui = getUi();

    dock.classList.toggle('is-open', ui.open);
    setCountMark(refs.launcherCount, items.length);
    setCountMark(refs.count, items.length);
    lastCount = items.length;

    const ctx = currentContext();
    refs.context.textContent = ctx ? `${PLATFORM_NAME[PLATFORM]}, ${ctx.label}` : `${PLATFORM_NAME[PLATFORM]}, no ticket open`;
    const saved = !!(ctx && items.some((i) => i.key === `${PLATFORM}-${ctx.id}`));
    refs.status.hidden = !saved;

    // One primary action whose label always says what it will do
    refs.saveBtn.disabled = !ctx;
    refs.saveBtn.textContent = !ctx ? `Open a ${NOUN} to save it` : saved ? `Update saved ${NOUN}` : `Save this ${NOUN}`;
    refs.quickSave.disabled = !ctx;
    refs.quickLabel.textContent = !ctx ? `No ${NOUN} open` : saved ? `Update ${NOUN}` : `Save ${NOUN}`;
    renderSelectionHint();

    refs.mask.checked = !!ui.redact;
    refs.clear.disabled = !items.length;
    shadow.querySelectorAll('[data-action="copy"], [data-action="md"], [data-action="json"]').forEach((b) => {
      b.disabled = !items.length;
    });

    if (ui.open) renderList(items);
    applyPosition();
  }

  // ---- Selection-aware secondary action ----
  let hasSelection = false;

  function renderSelectionHint() {
    refs.selectLink.hidden = !hasSelection;
    refs.selectTip.hidden = hasSelection;
  }

  document.addEventListener('selectionchange', () => {
    const selection = window.getSelection();
    const now = !!(selection && !selection.isCollapsed && selection.toString().trim());
    if (now !== hasSelection) {
      hasSelection = now;
      renderSelectionHint();
    }
  });

  // ---- Clear (two-step confirm, no native dialog) ----
  let clearTimer = null;
  function disarmClear() {
    clearTimeout(clearTimer);
    clearTimer = null;
    refs.clear.classList.remove('armed');
    refs.clear.textContent = 'Clear all';
  }

  // ---- Actions ----
  async function handleAction(action, button) {
    const items = getItems();
    const masked = !!getUi().redact;

    switch (action) {
      case 'minimize':
        setUi({ open: false });
        render();
        refs.openBtn.focus();
        break;
      case 'collect':
        collectConversation();
        break;
      case 'selection':
        collectSelection();
        break;
      case 'remove':
        setItems(items.filter((i) => i.key !== button.dataset.key));
        toast('Removed');
        break;
      case 'clear':
        if (!items.length) return;
        if (!clearTimer) {
          refs.clear.classList.add('armed');
          refs.clear.textContent = `Clear ${items.length}? Click again`;
          clearTimer = setTimeout(disarmClear, 3000);
          return;
        }
        disarmClear();
        setItems([]);
        toast('Cleared all items');
        break;
      case 'copy': {
        const ok = await copyText(buildMarkdown(items, masked));
        toast(ok ? `Copied ${items.length} item(s) as Markdown` : 'Copy failed. Try Download .md instead.', ok ? 'success' : 'error');
        break;
      }
      case 'md':
        download(`conversations-${today()}.md`, buildMarkdown(items, masked), 'text/markdown;charset=utf-8');
        toast(`Downloaded ${items.length} item(s)`, 'success');
        break;
      case 'json':
        download(`conversations-${today()}.json`, buildJson(items, masked), 'application/json');
        toast(`Downloaded ${items.length} item(s)`, 'success');
        break;
    }
  }

  // Keep the page's text selection when clicking panel buttons
  shadow.addEventListener('mousedown', (event) => {
    if (event.target.closest('.panel button')) event.preventDefault();
  });

  shadow.addEventListener('click', (event) => {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    if (button.dataset.action !== 'clear') disarmClear();
    handleAction(button.dataset.action, button);
  });

  function unlessDragged(fn) {
    return () => {
      if (suppressClick) {
        suppressClick = false;
        return;
      }
      fn();
    };
  }

  // Keep page selection when using the launcher too
  refs.launcher.addEventListener('mousedown', (event) => event.preventDefault());

  refs.quickSave.addEventListener('click', unlessDragged(collectConversation));
  refs.openBtn.addEventListener(
    'click',
    unlessDragged(() => {
      setUi({ open: true });
      render();
    })
  );

  refs.mask.addEventListener('change', () => setUi({ redact: refs.mask.checked }));

  enableDrag(refs.launcher);
  enableDrag(refs.head);

  window.addEventListener(
    'keydown',
    (event) => {
      if (!event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey) return;
      if (event.code === 'KeyC') {
        event.preventDefault();
        collectConversation();
      } else if (event.code === 'KeyS') {
        event.preventDefault();
        collectSelection();
      }
    },
    true
  );

  window.addEventListener('resize', applyPosition);

  // Sync count across tabs
  if (typeof GM_addValueChangeListener === 'function') {
    GM_addValueChangeListener(KEY_ITEMS, (_name, _old, _new, remote) => {
      if (remote) render();
    });
  }

  // ---------------------------------------------------------------------------
  // Start — survive SPA navigation and host re-renders
  // ---------------------------------------------------------------------------

  document.documentElement.appendChild(hostEl);
  render();

  let lastHref = location.href;
  let ticks = 0;
  setInterval(() => {
    ticks++;
    if (!document.documentElement.contains(hostEl)) {
      document.documentElement.appendChild(hostEl);
    }
    if (location.href !== lastHref || ticks % 30 === 0) {
      lastHref = location.href;
      render();
    }
  }, 1000);
})();
