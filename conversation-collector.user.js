// ==UserScript==
// @name         Conversation Collector for Zendesk & LiveChat
// @namespace    https://katrinaops.com
// @version      2.2.3
// @description  Collect Zendesk tickets and LiveChat / Text.com transcripts as clean Markdown for QA reviews and AI analysis.
// @author       Katrina Lin
// @homepageURL  https://katrinaops.com
// @downloadURL  https://katrinaops.com/tools/conversation-collector.user.js
// @updateURL    https://katrinaops.com/tools/conversation-collector.user.js
// @match        https://*.zendesk.com/agent/*
// @match        https://*.livechat.com/*
// @match        https://*.livechatinc.com/*
// @match        https://*.text.com/*
// @match        https://text.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_setClipboard
// @grant        GM_addValueChangeListener
// @run-at       document-idle
// @noframes
// @license      MIT
// ==/UserScript==

(function () {
	"use strict";

	// ===========================================================================
	// PLATFORM
	// ===========================================================================

	const HOST = location.hostname;

	const PLATFORM = HOST.endsWith("zendesk.com")
		? "zendesk"
		: /(^|\.)(livechat(inc)?|text)\.com$/.test(HOST)
			? "livechat"
			: null;

	if (!PLATFORM) return;

	const PLATFORM_NAME = {
		zendesk: "Zendesk",
		livechat: "LiveChat",
	};

	const IS_MAC = /Mac|iPhone|iPad/.test(
		navigator.platform || navigator.userAgent,
	);

	const SHORTCUT = (key) => (IS_MAC ? `⌥⇧${key}` : `Alt+Shift+${key}`);

	const NOUN = PLATFORM === "zendesk" ? "ticket" : "chat";

	// ===========================================================================
	// STORAGE
	// ===========================================================================

	const KEY_ITEMS = "cc_items_v2";
	const KEY_UI = "cc_ui_v2";
	const KEY_DAY = "cc_items_day_v2";

	const LEGACY_KEY = "conversation_collector_items";

	const DEFAULT_UI = {
		open: false,
		left: 20,
		top: 20,
		redact: true,
	};

	function localDayKey() {
		const now = new Date();

		const year = now.getFullYear();

		const month = String(now.getMonth() + 1).padStart(2, "0");

		const day = String(now.getDate()).padStart(2, "0");

		return `${year}-${month}-${day}`;
	}

	function clearExpiredItems() {
		const today = localDayKey();

		const storedDay = GM_getValue(KEY_DAY, null);

		if (!storedDay) {
			GM_setValue(KEY_DAY, today);

			return;
		}

		if (storedDay !== today) {
			GM_setValue(KEY_ITEMS, []);

			GM_setValue(KEY_DAY, today);
		}
	}

	function getItems() {
		clearExpiredItems();

		let items = GM_getValue(KEY_ITEMS, null);

		if (items === null) {
			items = GM_getValue(LEGACY_KEY, []);

			GM_setValue(KEY_ITEMS, items);

			GM_setValue(KEY_DAY, localDayKey());
		}

		return Array.isArray(items) ? items : [];
	}

	function setItems(items) {
		GM_setValue(KEY_ITEMS, items);

		GM_setValue(KEY_DAY, localDayKey());

		render();
	}

	function getUi() {
		return {
			...DEFAULT_UI,
			...GM_getValue(KEY_UI, {}),
		};
	}

	function setUi(patch) {
		GM_setValue(KEY_UI, {
			...getUi(),
			...patch,
		});
	}

	// ===========================================================================
	// TEXT HELPERS
	// ===========================================================================

	function cleanText(text) {
		return String(text || "")
			.replace(/\u00a0/g, " ")
			.replace(/[ \t]+/g, " ")
			.split("\n")
			.map((line) => line.trim())
			.join("\n")
			.replace(/\n{3,}/g, "\n\n")
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
			"/agent/tickets/users/",
			"/agent/filters/",
			"/agent/search/",
			"/agent/views/",
			"/admin/",
			"/tickets/tickets/",
			"/agent/tickets/tickets/",
		].some((part) => href.includes(part));
	}

	function linksToMarkdown(root) {
		root.querySelectorAll("a[href]").forEach((link) => {
			const text = cleanText(link.textContent);

			const raw = link.getAttribute("href");

			const href = raw ? absoluteUrl(raw) : "";

			let output = text;

			if (href && !(PLATFORM === "zendesk" && isZendeskUiLink(href))) {
				output = text && text !== href ? `[${text}](${href})` : href;
			}

			link.replaceWith(document.createTextNode(output));
		});
	}

	const BLOCK_TAGS = new Set([
		"P",
		"DIV",
		"LI",
		"UL",
		"OL",
		"H1",
		"H2",
		"H3",
		"H4",
		"H5",
		"H6",
		"TR",
		"TABLE",
		"SECTION",
		"ARTICLE",
		"HEADER",
		"FOOTER",
		"BLOCKQUOTE",
		"PRE",
	]);

	const SKIP_TAGS = new Set([
		"SCRIPT",
		"STYLE",
		"NOSCRIPT",
		"TEMPLATE",
		"SVG",
		"BUTTON",
	]);

	function toText(root) {
		if (!root) return "";

		const clone = root.cloneNode(true);

		linksToMarkdown(clone);

		let out = "";

		const walk = (node, inPre) => {
			if (node.nodeType === Node.TEXT_NODE) {
				out += inPre ? node.nodeValue : node.nodeValue.replace(/\s+/g, " ");

				return;
			}

			if (
				node.nodeType !== Node.ELEMENT_NODE &&
				node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE
			) {
				return;
			}

			const tag = node.tagName ? node.tagName.toUpperCase() : "";

			if (SKIP_TAGS.has(tag)) {
				return;
			}

			if (tag === "BR") {
				out += "\n";
				return;
			}

			const block = BLOCK_TAGS.has(tag);

			if (block) {
				out += "\n";
			}

			if (tag === "LI") {
				out += "- ";
			}

			node.childNodes.forEach((child) => walk(child, inPre || tag === "PRE"));

			if (block) {
				out += "\n";
			}
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

	const isVisible = (element) =>
		!!(
			element.offsetWidth ||
			element.offsetHeight ||
			element.getClientRects().length
		);

	// ===========================================================================
	// MASKING
	// ===========================================================================

	const URL_RE = /https?:\/\/[^\s)\]]+/g;

	function maskPlain(text) {
		return text
			.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
			.replace(/\+?\d[\d\s().-]{7,18}\d/g, (match) => {
				const digits = match.replace(/\D/g, "");

				if (digits.length < 9 || digits.length > 15) {
					return match;
				}

				if (/^\d{4}-\d{2}-\d{2}/.test(match)) {
					return match;
				}

				return "[phone]";
			});
	}

	function mask(text) {
		const source = String(text || "");

		let result = "";
		let last = 0;

		for (const match of source.matchAll(URL_RE)) {
			result += maskPlain(source.slice(last, match.index)) + match[0];

			last = match.index + match[0].length;
		}

		return result + maskPlain(source.slice(last));
	}

	// ===========================================================================
	// ZENDESK
	// ===========================================================================

	function getZendeskTicketId() {
		const match = location.pathname.match(/tickets\/(\d+)/);

		return match ? match[1] : null;
	}

	function getZendeskSubject() {
		const element = document.querySelector(
			'[data-test-id="omni-header-subject"]',
		);

		return cleanText((element && (element.value || element.textContent)) || "");
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
			for (const element of document.querySelectorAll(selector)) {
				if (
					isVisible(element) &&
					(element.textContent || "").trim().length > 100
				) {
					return element;
				}
			}
		}

		return null;
	}

	// ===========================================================================
	// LIVECHAT & TEXT.COM
	// ===========================================================================

	function getLiveChatId() {
		// 1. Path segment under /chats, /archives, /tickets
		const pathMatch = location.pathname.match(
			/(?:chats|archives|tickets)\/(?:[0-9]+\/)?([A-Za-z0-9_-]+)/i,
		);

		if (
			pathMatch &&
			pathMatch[1] &&
			!/^(chats|archives|tickets|all|unread|mine|trash)$/i.test(pathMatch[1])
		) {
			return pathMatch[1];
		}

		// 2. Query parameters
		try {
			const searchParams = new URLSearchParams(location.search);
			const queryId =
				searchParams.get("chat") ||
				searchParams.get("id") ||
				searchParams.get("chat_id");

			if (queryId) {
				return queryId;
			}
		} catch {
			/* ignore */
		}

		// 3. Ticket pattern in URL
		const urlMatch = location.href.match(/(TK[A-Z0-9]+)/i);

		if (urlMatch) {
			return urlMatch[1];
		}

		// 4. Reaction data-testid
		const reaction = document.querySelector('[data-testid*="-reaction"]');

		const idMatch =
			reaction &&
			(reaction.getAttribute("data-testid") || "").match(/^(TK[A-Z0-9]+)_/i);

		if (idMatch) {
			return idMatch[1];
		}

		return `LC-${simpleHash(location.pathname)}`;
	}

	function getLiveChatTitle() {
		const groups = document.querySelectorAll(
			'[data-testid="message-bubble-group"]',
		);

		for (const group of groups) {
			const cls = group.getAttribute("class") || "";

			if (!cls.includes("message-bubble-group--right")) {
				const headerName = group.querySelector(
					'[class*="message-bubble-group__content__header__name"]',
				);

				if (headerName) {
					const text = cleanText(headerName.textContent);

					if (text && !/^(Agent|Customer|Visitor)$/i.test(text)) {
						return text;
					}
				}

				const profile = group.querySelector('[aria-label*="profile"]');

				if (profile) {
					const match = (
						profile.getAttribute("aria-label") || ""
					).match(/View\s+(.+?)'s\s+profile/i);

					if (match && match[1]) {
						return cleanText(match[1]);
					}
				}
			}
		}

		return "";
	}

	function findLiveChatSpeakerName(element) {
		let current = element;

		for (let level = 0; level < 8 && current; level++) {
			for (const candidate of current.querySelectorAll(".privacy-masker")) {
				const text = cleanText(candidate.textContent);

				if (
					text &&
					text.length <= 80 &&
					!text.includes("\n") &&
					!/Started -|Archived -|Chat rated/.test(text)
				) {
					return text;
				}
			}

			current = current.parentElement;
		}

		return "";
	}

	function extractLiveChatAttachment(element) {
		const image =
			element.querySelector('img[src]:not([class*="avatar"])') ||
			(element.tagName === "IMG" ? element : null);

		if (image && image.src) {
			return `[Image] ${image.src}`;
		}

		const link =
			element.querySelector("a[href]") ||
			(element.tagName === "A" ? element : null);

		if (link) {
			return `[Attachment] ${absoluteUrl(link.getAttribute("href"))}`;
		}

		return "";
	}

	function getLiveChatConversation() {
		// 1. Text.com / new LiveChat feed interface
		const chatFeed = document.querySelector(
			'[data-testid="chat-feed"], [class*="chat-feed"]',
		);

		const bubbleGroups = (chatFeed || document).querySelectorAll(
			'[data-testid="message-bubble-group"]',
		);

		if (bubbleGroups.length > 0) {
			const output = [];
			let lastSpeaker = null;

			for (const group of bubbleGroups) {
				const groupClass = group.getAttribute("class") || "";
				const hasAgentBubble = !!group.querySelector(
					'[class*="message-bubble--agent"]',
				);
				const hasUserBubble = !!group.querySelector(
					'[class*="message-bubble--user"]',
				);
				const isAgent =
					groupClass.includes("message-bubble-group--right") ||
					(hasAgentBubble && !hasUserBubble);
				const role = isAgent ? "Agent" : "Customer";

				let speaker = "";
				const headerNameEl = group.querySelector(
					'[class*="message-bubble-group__content__header__name"]',
				);

				if (headerNameEl) {
					speaker = cleanText(headerNameEl.textContent);
				}

				if (!speaker) {
					const profileTrigger = group.querySelector(
						'[aria-label*="profile"]',
					);

					if (profileTrigger) {
						const match = (
							profileTrigger.getAttribute("aria-label") || ""
						).match(/View\s+(.+?)'s\s+profile/i);

						if (match) {
							speaker = cleanText(match[1]);
						}
					}
				}

				if (!speaker) {
					const avatarImg = group.querySelector('img[alt]:not([alt=""])');

					if (avatarImg) {
						speaker = cleanText(avatarImg.getAttribute("alt"));
					}
				}

				if (!speaker) {
					speaker = role;
				}

				const bubbles = group.querySelectorAll('[data-testid="bubble-core"]');
				const bubbleList = bubbles.length > 0 ? bubbles : [group];

				for (const bubble of bubbleList) {
					let content = "";

					const textEl = bubble.querySelector(
						'[class*="message-bubble__text"]',
					);

					if (textEl) {
						content = toText(textEl);
					} else {
						const attachment = bubble.querySelector(
							'img:not([class*="avatar"]), a[href], [data-testid*="attachment"], [class*="attachment"]',
						);

						if (attachment) {
							content = extractLiveChatAttachment(attachment);
						} else {
							const clone = bubble.cloneNode(true);

							clone
								.querySelectorAll(
									'[class*="message-bubble__footer"], [data-testid="message-bubble-actions"], [class*="avatar"], button',
								)
								.forEach((node) => node.remove());

							content = toText(clone);
						}
					}

					const extraAttachment = bubble.querySelector(
						'img:not([class*="avatar"]), a[href]',
					);

					if (
						extraAttachment &&
						textEl &&
						!textEl.contains(extraAttachment)
					) {
						const attText = extractLiveChatAttachment(extraAttachment);

						if (attText) {
							content = content ? `${content}\n${attText}` : attText;
						}
					}

					content = cleanText(content);

					if (!content) {
						continue;
					}

					if (speaker !== lastSpeaker) {
						if (output.length) {
							output.push("");
						}

						output.push(`**${speaker}** (${role.toLowerCase()}):`);

						lastSpeaker = speaker;
					}

					output.push(content);
				}
			}

			const result = cleanText(output.join("\n"));

			if (result) {
				return result;
			}
		}

		// 2. Fallback to Legacy LiveChat interface
		const elements = document.querySelectorAll(
			[
				'[data-testid="agent-message"]',
				'[data-testid="customer-message"]',
				'[data-testid="agent-attachment"]',
				'[data-testid="customer-attachment"]',
			].join(","),
		);

		const output = [];
		let lastSpeaker = null;

		for (const element of elements) {
			const testId = element.getAttribute("data-testid") || "";

			const role = testId.startsWith("agent-")
				? "Agent"
				: testId.startsWith("customer-")
					? "Customer"
					: "Unknown";

			const speaker = findLiveChatSpeakerName(element) || role;

			const content = testId.includes("attachment")
				? extractLiveChatAttachment(element)
				: toText(element);

			if (!content) {
				continue;
			}

			if (speaker !== lastSpeaker) {
				if (output.length) {
					output.push("");
				}

				output.push(`**${speaker}** (${role.toLowerCase()}):`);

				lastSpeaker = speaker;
			}

			output.push(content);
		}

		return cleanText(output.join("\n"));
	}

	// ===========================================================================
	// CURRENT CONTEXT
	// ===========================================================================

	function currentContext() {
		if (PLATFORM === "zendesk") {
			const id = getZendeskTicketId();

			return id
				? {
						id,
						label: `Ticket #${id}`,
						title: getZendeskSubject(),
					}
				: null;
		}

		const id = getLiveChatId();

		return {
			id,
			label: `Chat ${id}`,
			title: getLiveChatTitle(),
		};
	}

	function getSelectedText() {
		const selection = window.getSelection();

		if (
			!selection ||
			selection.rangeCount === 0 ||
			!cleanText(selection.toString())
		) {
			return "";
		}

		const container = document.createElement("div");

		for (let i = 0; i < selection.rangeCount; i++) {
			try {
				container.appendChild(selection.getRangeAt(i).cloneContents());
			} catch {
				// Ignore selection cloning errors.
			}
		}

		return toText(container) || cleanText(selection.toString());
	}

	// ===========================================================================
	// SAVE
	// ===========================================================================

	function upsert(item) {
		const items = getItems();

		const index = items.findIndex((existing) => existing.key === item.key);

		if (index >= 0) {
			items[index] = item;
		} else {
			items.push(item);
		}

		setItems(items);

		toast(
			`${
				index >= 0 ? "Updated" : "Saved"
			} ${item.label} (${items.length} total)`,
			"success",
		);
	}

	function collectConversation() {
		const ctx = currentContext();

		if (!ctx) {
			toast(
				PLATFORM === "zendesk" ? "Open a ticket first." : "Open a chat first.",
				"error",
			);

			return;
		}

		let text = "";

		if (PLATFORM === "zendesk") {
			text = toText(findZendeskConversationRoot());
		} else {
			text = getLiveChatConversation();
		}

		if (!text) {
			toast(
				"No conversation found here. Select the messages and use Save selected text instead.",
				"error",
			);

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
			mode: "full",
			text,
		});
	}

	function collectSelection() {
		const text = getSelectedText();

		if (!text) {
			toast("Select some text on the page first.", "error");

			return;
		}

		const ctx = currentContext();

		if (!ctx) {
			toast("Open a ticket or chat first.", "error");

			return;
		}

		upsert({
			key: `${PLATFORM}-${ctx.id}-sel-${simpleHash(text)}`,
			type: PLATFORM,
			id: ctx.id,
			label: `${ctx.label} (selected text)`,
			title: ctx.title,
			url: location.href,
			collectedAt: new Date().toISOString(),
			mode: "selected",
			text,
		});
	}

	// ===========================================================================
	// EXPORT
	// ===========================================================================

	function buildMarkdown(items, masked) {
		const format = (text) => (masked ? mask(text) : text || "");

		const header = [
			"# Conversation export",
			"",
			`Exported ${new Date().toISOString()}, ${items.length} item(s)${
				masked ? ", emails and phone numbers masked" : ""
			}.`,
			"",
		].join("\n");

		const blocks = items.map((item) =>
			[
				`## ${PLATFORM_NAME[item.type] || item.type}: ${item.label}${
					item.title ? ` (${format(item.title)})` : ""
				}`,
				"",
				`- Source: ${item.url}`,
				`- Collected: ${item.collectedAt}`,
				`- Scope: ${
					item.mode === "selected" ? "Selected text" : "Full conversation"
				}`,
				"",
				format(item.text),
			].join("\n"),
		);

		return `${header}\n${blocks.join("\n\n---\n\n")}\n`;
	}

	function buildJson(items, masked) {
		const format = (text) => (masked ? mask(text) : text || "");

		return JSON.stringify(
			{
				exportedAt: new Date().toISOString(),
				masked,
				items: items.map((item) => ({
					...item,
					title: format(item.title),
					text: format(item.text),
				})),
			},
			null,
			2,
		);
	}

	async function copyText(text) {
		if (typeof GM_setClipboard === "function") {
			GM_setClipboard(text, "text");

			return true;
		}

		try {
			await navigator.clipboard.writeText(text);

			return true;
		} catch {
			const area = document.createElement("textarea");

			area.value = text;

			Object.assign(area.style, {
				position: "fixed",
				left: "-9999px",
				top: "0",
			});

			document.body.appendChild(area);

			area.select();

			const success = document.execCommand("copy");

			area.remove();

			return success;
		}
	}

	function download(filename, content, type) {
		const url = URL.createObjectURL(new Blob([content], { type }));

		const link = document.createElement("a");

		link.href = url;

		link.download = filename;

		document.body.appendChild(link);

		link.click();
		link.remove();

		setTimeout(() => URL.revokeObjectURL(url), 1000);
	}

	const today = () => localDayKey();

	// ===========================================================================
	// ICONS
	// ===========================================================================

	const ICONS = {
		expand:
			'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 15l6-6 6 6"/></svg>',

		logo: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h16M4 12h10M4 19h6"/></svg>',

		minimize:
			'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>',

		remove:
			'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
	};

	// ===========================================================================
	// CSS
	// ===========================================================================

	const CSS = `
    :host {
      all: initial;
    }

    *,
    *::before,
    *::after {
      box-sizing: border-box;
    }

    button {
      font: inherit;
      color: inherit;
    }

    .dock,
    .toast {
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
      --danger-dark: #a72c24;

      --shadow:
        0 1px 2px rgba(30,42,51,.08),
        0 10px 28px -10px rgba(30,42,51,.28);

      font-family:
        ui-sans-serif,
        system-ui,
        -apple-system,
        "Segoe UI",
        Roboto,
        "Helvetica Neue",
        Arial,
        sans-serif;

      font-size: 13px;
      line-height: 1.45;
      color: var(--ink);
      -webkit-font-smoothing: antialiased;
    }

    .dock {
      position: fixed;
      left: 20px;
      top: 20px;
      z-index: 2147483646;
    }

    .dock.dragging {
      user-select: none;
    }

    .dock:not(.is-open) .panel {
      display: none;
    }

    .dock.is-open .launcher {
      display: none;
    }

    /* COLLAPSED */

    .launcher {
      display: inline-flex;
      align-items: stretch;
      border: 1px solid var(--line);
      border-radius: 12px;
      background: var(--paper);
      box-shadow: var(--shadow);
      overflow: hidden;
      cursor: grab;
    }

    .launcher button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 9px;
      height: 42px;
      border: 0;
      background: transparent;
      color: var(--ink);
      font-weight: 600;
      cursor: pointer;
    }

    .launcher button:hover:not(:disabled) {
      background: var(--paper-2);
    }

    .launcher button:disabled {
      color: var(--muted);
      cursor: default;
    }

    .launcher button:focus-visible {
      outline: 2px solid var(--cobalt);
      outline-offset: -2px;
    }

    .quick {
      padding: 0 14px 0 9px;
      min-width: 108px;
    }

    .clear-count {
      min-width: 40px;
      padding: 0 8px;
      border-left: 1px solid var(--line) !important;
      border-right: 1px solid var(--line) !important;
    }

    .open {
      width: 38px;
      padding: 0;
      color: var(--muted) !important;
    }

    .logo {
      width: 24px;
      height: 24px;
      flex: none;
      display: grid;
      place-items: center;
      border-radius: 7px;
      background: var(--ink);
      color: #fff;
    }

    .mark {
      min-width: 24px;
      height: 22px;
      padding: 0 7px;
      display: inline-grid;
      place-items: center;
      border-radius: 5px;
      background: var(--mark);
      color: var(--ink);
      font-weight: 700;
      font-size: 12px;
      font-variant-numeric: tabular-nums;
      transform: rotate(-2deg);
    }

    .mark.zero {
      background: var(--paper-2);
      color: var(--muted);
      transform: none;
    }

    .clear-count.confirming {
      min-width: 76px;
      background: var(--danger);
      color: #fff;
    }

    .clear-count.confirming:hover {
      background: var(--danger-dark) !important;
    }

    .clear-count.confirming .mark {
      min-width: auto;
      padding: 0;
      background: transparent;
      color: #fff;
      transform: none;
    }

    /* PANEL */

    .panel {
      width: 340px;
      max-width: calc(100vw - 16px);
      max-height: min(560px, calc(100vh - 16px));
      display: flex;
      flex-direction: column;
      background: var(--paper);
      border: 1px solid var(--line);
      border-radius: 14px;
      box-shadow: var(--shadow);
      overflow: hidden;
    }

    .head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 12px 10px 12px 14px;
      cursor: grab;
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 0;
    }

    .brand-text {
      min-width: 0;
    }

    .title {
      font-weight: 650;
      font-size: 14px;
    }

    .context {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
      font-size: 12px;
      color: var(--muted);
    }

    .context-label {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .status {
      flex: none;
      font-size: 11px;
      font-weight: 600;
      padding: 0 7px;
      border-radius: 999px;
      background: var(--ok-soft);
      color: var(--ok);
    }

    .status[hidden] {
      display: none;
    }

    .icon-btn {
      width: 28px;
      height: 28px;
      flex: none;
      display: grid;
      place-items: center;
      border: 0;
      border-radius: 8px;
      background: transparent;
      color: var(--muted);
      cursor: pointer;
    }

    .icon-btn:hover {
      background: var(--paper-2);
      color: var(--ink);
    }

    .actions {
      display: grid;
      gap: 8px;
      padding: 2px 14px 14px;
    }

    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      height: 36px;
      padding: 0 12px;
      border: 1px solid var(--line);
      border-radius: 9px;
      background: var(--paper);
      color: var(--ink);
      font-weight: 550;
      cursor: pointer;
    }

    .btn:hover:not(:disabled) {
      background: var(--paper-2);
    }

    .btn:disabled {
      opacity: .45;
      cursor: not-allowed;
    }

    .btn-primary {
      background: var(--cobalt);
      border-color: var(--cobalt);
      color: #fff;
    }

    .btn-primary:hover:not(:disabled) {
      background: var(--cobalt-2);
      border-color: var(--cobalt-2);
    }

    .btn-ink {
      background: var(--ink);
      border-color: var(--ink);
      color: #fff;
    }

    .btn-ink:hover:not(:disabled) {
      background: var(--ink-2);
    }

    .btn.big {
      height: 46px;
      font-size: 14px;
      font-weight: 600;
      border-radius: 10px;
    }

    .alt {
      min-height: 24px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 12px;
      color: var(--muted);
    }

    .alt [hidden] {
      display: none;
    }

    .link-btn {
      border: 0;
      background: none;
      padding: 3px 6px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 550;
      color: var(--muted);
      cursor: pointer;
    }

    .link-btn.accent {
      color: var(--cobalt);
      font-size: 12.5px;
    }

    .list-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 14px 6px;
      border-top: 1px solid var(--line);
      font-size: 12px;
      font-weight: 600;
    }

    .list {
      list-style: none;
      margin: 0;
      padding: 0 8px 8px;
      overflow-y: auto;
      flex: 1;
      min-height: 64px;
    }

    .item {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 7px 6px;
      border-radius: 9px;
    }

    .item:hover {
      background: var(--paper-2);
    }

    .src {
      width: 28px;
      height: 28px;
      flex: none;
      display: grid;
      place-items: center;
      border-radius: 7px;
      font-size: 10.5px;
      font-weight: 700;
    }

    .src-zendesk {
      background: #e4efee;
      color: #0b4a4f;
    }

    .src-livechat {
      background: #fdeee3;
      color: #a4410e;
    }

    .item-main {
      flex: 1;
      min-width: 0;
    }

    .item-title {
      display: block;
      color: var(--ink);
      text-decoration: none;
      font-weight: 550;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .item-title:hover {
      text-decoration: underline;
    }

    .item-meta {
      font-size: 11.5px;
      color: var(--muted);
    }

    .item .icon-btn {
      opacity: 0;
    }

    .item:hover .icon-btn {
      opacity: 1;
    }

    .empty {
      margin: 2px 6px 6px;
      padding: 16px 12px;
      border: 1px dashed var(--line);
      border-radius: 10px;
      color: var(--muted);
      font-size: 12.5px;
      text-align: center;
    }

    .foot {
      display: grid;
      gap: 10px;
      padding: 12px 14px 14px;
      border-top: 1px solid var(--line);
      background: var(--paper-2);
    }

    .foot-actions {
      display: flex;
      gap: 6px;
    }

    .foot-actions .btn-ink {
      flex: 1;
    }

    .switch {
      display: flex;
      align-items: center;
      gap: 9px;
      font-size: 12.5px;
      cursor: pointer;
    }

    .switch input {
      position: absolute;
      opacity: 0;
    }

    .track {
      position: relative;
      width: 30px;
      height: 18px;
      flex: none;
      border-radius: 999px;
      background: #c3ccd2;
    }

    .track::after {
      content: '';
      position: absolute;
      top: 2px;
      left: 2px;
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background: #fff;
      transition: transform .15s;
    }

    .switch input:checked + .track {
      background: var(--ok);
    }

    .switch input:checked + .track::after {
      transform: translateX(12px);
    }

    .hint {
      font-size: 11.5px;
      color: var(--muted);
      margin-top: -6px;
      padding-left: 39px;
    }

    .toast {
      position: fixed;
      left: 50%;
      bottom: 24px;
      z-index: 2147483647;
      display: flex;
      align-items: center;
      gap: 9px;
      max-width: min(460px, calc(100vw - 32px));
      padding: 10px 14px;
      border-radius: 10px;
      background: var(--ink);
      color: #fff;
      box-shadow: var(--shadow);
      opacity: 0;
      transform: translate(-50%, 8px);
      pointer-events: none;
      transition:
        opacity .18s,
        transform .18s;
    }

    .toast.show {
      opacity: 1;
      transform: translate(-50%, 0);
    }

    .toast .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #9fb0bb;
    }

    .toast.success .dot {
      background: #5fd3a2;
    }

    .toast.error .dot {
      background: #ff8a80;
    }
  `;

	// ===========================================================================
	// HTML
	// ===========================================================================

	const hostEl = document.createElement("div");

	hostEl.id = "conversation-collector-root";

	const shadow = hostEl.attachShadow({
		mode: "open",
	});

	shadow.innerHTML = `
    <style>${CSS}</style>

    <div class="dock">

      <div
        class="launcher"
        data-ref="launcher"
      >

        <button
          class="quick"
          type="button"
          data-ref="quickMain"
        >
          <span class="logo">
            ${ICONS.logo}
          </span>

          <span
            data-ref="quickMainText"
          >
            Save ${NOUN}
          </span>
        </button>

        <button
          class="clear-count"
          type="button"
          data-ref="quickClear"
          title="Clear saved items"
        >
          <span
            class="mark"
            data-ref="launcherCount"
          >
            0
          </span>
        </button>

        <button
          class="open"
          type="button"
          data-ref="openBtn"
          title="Open Conversation Collector"
          aria-label="Open Conversation Collector"
        >
          ${ICONS.expand}
        </button>

      </div>

      <section
        class="panel"
        role="dialog"
        aria-label="Conversation Collector"
      >

        <header
          class="head"
          data-ref="head"
        >

          <div class="brand">

            <span class="logo">
              ${ICONS.logo}
            </span>

            <div class="brand-text">

              <div class="title">
                Conversation Collector
              </div>

              <div class="context">

                <span
                  class="context-label"
                  data-ref="context"
                ></span>

                <span
                  class="status"
                  data-ref="status"
                  hidden
                >
                  Saved
                </span>

              </div>

            </div>

          </div>

          <button
            class="icon-btn"
            type="button"
            data-action="minimize"
            title="Minimize"
          >
            ${ICONS.minimize}
          </button>

        </header>

        <div class="actions">

          <button
            class="btn btn-primary big"
            type="button"
            data-action="collect"
            data-ref="saveBtn"
            title="Shortcut: ${SHORTCUT("C")}"
          >
            Save this ${NOUN}
          </button>

          <div class="alt">

            <button
              class="link-btn accent"
              type="button"
              data-action="selection"
              data-ref="selectLink"
              title="Shortcut: ${SHORTCUT("S")}"
              hidden
            >
              Save only the selected text
            </button>

            <span
              data-ref="selectTip"
            >
              To save only part of it, select the text first.
            </span>

          </div>

        </div>

        <div class="list-head">

          <span>
            Saved
            <span
              class="mark"
              data-ref="count"
            >
              0
            </span>
          </span>

          <button
            class="link-btn"
            type="button"
            data-action="clear"
            data-ref="clear"
          >
            Clear all
          </button>

        </div>

        <ul
          class="list"
          data-ref="list"
        ></ul>

        <footer class="foot">

          <label class="switch">

            <input
              type="checkbox"
              data-ref="mask"
            >

            <span class="track"></span>

            <span>
              Mask emails and phone numbers
            </span>

          </label>

          <div class="hint">
            Applies to copy and download.
          </div>

          <div class="foot-actions">

            <button
              class="btn btn-ink"
              type="button"
              data-action="copy"
            >
              Copy all as Markdown
            </button>

            <button
              class="btn"
              type="button"
              data-action="md"
            >
              .md
            </button>

            <button
              class="btn"
              type="button"
              data-action="json"
            >
              .json
            </button>

          </div>

        </footer>

      </section>

    </div>

    <div
      class="toast"
      data-ref="toast"
      role="status"
      aria-live="polite"
    >
      <span class="dot"></span>

      <span
        data-ref="toastText"
      ></span>
    </div>
  `;

	const dock = shadow.querySelector(".dock");

	const refs = {};

	shadow.querySelectorAll("[data-ref]").forEach((element) => {
		refs[element.dataset.ref] = element;
	});

	function el(tag, className, text) {
		const node = document.createElement(tag);

		if (className) {
			node.className = className;
		}

		if (text != null) {
			node.textContent = text;
		}

		return node;
	}

	// ===========================================================================
	// TOAST
	// ===========================================================================

	let toastTimer;

	function toast(message, kind = "info") {
		refs.toastText.textContent = message;

		refs.toast.className = `toast show ${kind}`;

		clearTimeout(toastTimer);

		toastTimer = setTimeout(() => {
			refs.toast.className = `toast ${kind}`;
		}, 2400);
	}

	// ===========================================================================
	// POSITION
	// ===========================================================================

	function placeDock(left, top) {
		const rect = dock.getBoundingClientRect();

		const maxLeft = Math.max(8, window.innerWidth - rect.width - 8);

		const maxTop = Math.max(8, window.innerHeight - rect.height - 8);

		const l = Math.min(Math.max(8, Number(left) || 20), maxLeft);

		const t = Math.min(Math.max(8, Number(top) || 20), maxTop);

		dock.style.left = `${l}px`;

		dock.style.top = `${t}px`;

		dock.style.right = "auto";

		dock.style.bottom = "auto";

		return {
			left: l,
			top: t,
		};
	}

	function applyPosition() {
		const ui = getUi();

		placeDock(ui.left, ui.top);
	}

	let suppressClick = false;

	function enableDrag(handle) {
		handle.addEventListener("pointerdown", (event) => {
			if (event.button !== 0 || event.target.closest("[data-action]")) {
				return;
			}

			const rect = dock.getBoundingClientRect();

			const start = {
				x: event.clientX,
				y: event.clientY,
				left: rect.left,
				top: rect.top,
			};

			let moved = false;

			const onMove = (moveEvent) => {
				const dx = moveEvent.clientX - start.x;

				const dy = moveEvent.clientY - start.y;

				if (!moved && Math.hypot(dx, dy) < 4) {
					return;
				}

				moved = true;

				dock.classList.add("dragging");

				placeDock(start.left + dx, start.top + dy);
			};

			const onUp = () => {
				window.removeEventListener("pointermove", onMove);

				window.removeEventListener("pointerup", onUp);

				dock.classList.remove("dragging");

				if (moved) {
					const r = dock.getBoundingClientRect();

					setUi({
						left: r.left,
						top: r.top,
					});

					suppressClick = true;
				}
			};

			window.addEventListener("pointermove", onMove);

			window.addEventListener("pointerup", onUp);
		});
	}

	// ===========================================================================
	// LIST
	// ===========================================================================

	function timeAgo(iso) {
		const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);

		if (seconds < 60) {
			return "just now";
		}

		if (seconds < 3600) {
			return `${Math.floor(seconds / 60)} min ago`;
		}

		return `${Math.floor(seconds / 3600)} h ago`;
	}

	function formatSize(length) {
		return length < 1000
			? `${length} chars`
			: `${(length / 1000).toFixed(1)}k chars`;
	}

	function renderList(items) {
		if (!items.length) {
			refs.list.replaceChildren(el("li", "empty", "Nothing saved yet."));

			return;
		}

		const rows = [...items].reverse().map((item) => {
			const li = el("li", "item");

			li.appendChild(
				el(
					"span",
					`src src-${item.type}`,
					item.type === "zendesk" ? "ZD" : "LC",
				),
			);

			const main = el("div", "item-main");

			const link = el("a", "item-title", item.label);

			link.href = item.url;

			link.target = "_blank";

			link.rel = "noopener";

			if (item.title) {
				link.title = item.title;
			}

			main.appendChild(link);

			main.appendChild(
				el(
					"div",
					"item-meta",
					`${
						item.mode === "selected" ? "Selected text" : "Full conversation"
					}, ${formatSize((item.text || "").length)}, ${timeAgo(
						item.collectedAt,
					)}`,
				),
			);

			li.appendChild(main);

			const remove = el("button", "icon-btn");

			remove.type = "button";

			remove.innerHTML = ICONS.remove;

			remove.dataset.action = "remove";

			remove.dataset.key = item.key;

			remove.title = `Remove ${item.label}`;

			li.appendChild(remove);

			return li;
		});

		refs.list.replaceChildren(...rows);
	}

	// ===========================================================================
	// COLLAPSED CLEAR CONFIRMATION
	// ===========================================================================

	let quickClearArmed = false;

	let quickClearTimer = null;

	function resetQuickClear() {
		quickClearArmed = false;

		clearTimeout(quickClearTimer);

		quickClearTimer = null;

		refs.quickClear.classList.remove("confirming");

		const count = getItems().length;

		refs.launcherCount.textContent = count;

		refs.quickClear.title = count
			? "Click twice to clear all saved items"
			: "Nothing to clear";
	}

	function quickClear() {
		const items = getItems();

		if (!items.length) {
			toast("Nothing saved yet.");

			return;
		}

		if (!quickClearArmed) {
			quickClearArmed = true;

			refs.quickClear.classList.add("confirming");

			refs.launcherCount.textContent = `Clear ${items.length}?`;

			refs.quickClear.title = "Click again within 3 seconds to clear all";

			quickClearTimer = setTimeout(resetQuickClear, 3000);

			return;
		}

		clearTimeout(quickClearTimer);

		quickClearTimer = null;

		quickClearArmed = false;

		refs.quickClear.classList.remove("confirming");

		setItems([]);

		toast("Cleared all items", "success");
	}

	// ===========================================================================
	// SELECTION
	// ===========================================================================

	let hasSelection = false;

	function renderSelectionHint() {
		refs.selectLink.hidden = !hasSelection;

		refs.selectTip.hidden = hasSelection;
	}

	document.addEventListener("selectionchange", () => {
		const selection = window.getSelection();

		const now = !!(
			selection &&
			!selection.isCollapsed &&
			selection.toString().trim()
		);

		if (now !== hasSelection) {
			hasSelection = now;

			renderSelectionHint();
		}
	});

	// ===========================================================================
	// RENDER
	// ===========================================================================

	function render() {
		const items = getItems();

		const ui = getUi();

		const ctx = currentContext();

		const currentSaved = !!(
			ctx && items.some((item) => item.key === `${PLATFORM}-${ctx.id}`)
		);

		dock.classList.toggle("is-open", ui.open);

		refs.launcherCount.textContent = items.length;

		refs.count.textContent = items.length;

		refs.launcherCount.classList.toggle("zero", items.length === 0);

		refs.count.classList.toggle("zero", items.length === 0);

		// -------------------------------------------------------------------------
		// COLLAPSED MAIN BUTTON
		// -------------------------------------------------------------------------

		if (!ctx) {
			refs.quickMainText.textContent =
				PLATFORM === "zendesk" ? "Save ticket" : "Save chat";

			refs.quickMain.disabled = true;

			refs.quickMain.title =
				PLATFORM === "zendesk" ? "Open a ticket first" : "Open a chat first";
		} else if (currentSaved) {
			refs.quickMainText.textContent = "Copy all";

			refs.quickMain.disabled = false;

			refs.quickMain.title = `Copy all ${items.length} saved item(s)`;
		} else {
			refs.quickMainText.textContent =
				PLATFORM === "zendesk" ? "Save ticket" : "Save chat";

			refs.quickMain.disabled = false;

			refs.quickMain.title =
				PLATFORM === "zendesk" ? "Save this ticket" : "Save this chat";
		}

		// -------------------------------------------------------------------------
		// COUNT / CLEAR
		// -------------------------------------------------------------------------

		refs.quickClear.disabled = !items.length;

		if (!quickClearArmed) {
			refs.quickClear.classList.remove("confirming");
		}

		// -------------------------------------------------------------------------
		// EXPANDED PANEL
		// -------------------------------------------------------------------------

		refs.context.textContent = ctx
			? `${PLATFORM_NAME[PLATFORM]}, ${ctx.label}`
			: `${PLATFORM_NAME[PLATFORM]}, no ${NOUN} open`;

		refs.status.hidden = !currentSaved;

		refs.saveBtn.disabled = !ctx;

		refs.saveBtn.textContent = !ctx
			? `Open a ${NOUN} to save it`
			: currentSaved
				? `Update saved ${NOUN}`
				: `Save this ${NOUN}`;

		refs.mask.checked = !!ui.redact;

		refs.clear.disabled = !items.length;

		shadow
			.querySelectorAll(
				'[data-action="copy"], [data-action="md"], [data-action="json"]',
			)
			.forEach((button) => {
				button.disabled = !items.length;
			});

		renderSelectionHint();

		if (ui.open) {
			renderList(items);
		}

		applyPosition();
	}

	// ===========================================================================
	// COPY ALL
	// ===========================================================================

	async function copyAllSaved() {
		const items = getItems();

		if (!items.length) {
			toast("Nothing saved yet.", "error");

			return;
		}

		const masked = !!getUi().redact;

		const success = await copyText(buildMarkdown(items, masked));

		toast(
			success ? `Copied ${items.length} item(s)` : "Copy failed",
			success ? "success" : "error",
		);
	}

	// ===========================================================================
	// COLLAPSED MAIN ACTION
	// ===========================================================================

	async function handleQuickMain() {
		const ctx = currentContext();

		if (!ctx) {
			toast(
				PLATFORM === "zendesk" ? "Open a ticket first." : "Open a chat first.",
				"error",
			);

			return;
		}

		const items = getItems();

		const currentSaved = items.some(
			(item) => item.key === `${PLATFORM}-${ctx.id}`,
		);

		if (currentSaved) {
			await copyAllSaved();
		} else {
			collectConversation();
		}
	}

	// ===========================================================================
	// PANEL ACTIONS
	// ===========================================================================

	async function handleAction(action, button) {
		const items = getItems();

		const masked = !!getUi().redact;

		switch (action) {
			case "minimize":
				setUi({
					open: false,
				});

				resetQuickClear();

				render();
				break;

			case "collect":
				collectConversation();
				break;

			case "selection":
				collectSelection();
				break;

			case "remove":
				setItems(items.filter((item) => item.key !== button.dataset.key));

				toast("Removed");
				break;

			// Expanded Clear all:
			// immediate clear, no confirmation.
			case "clear":
				if (!items.length) {
					return;
				}

				setItems([]);

				toast("Cleared all items", "success");
				break;

			case "copy": {
				const success = await copyText(buildMarkdown(items, masked));

				toast(
					success ? `Copied ${items.length} item(s)` : "Copy failed",
					success ? "success" : "error",
				);

				break;
			}

			case "md":
				download(
					`conversations-${today()}.md`,
					buildMarkdown(items, masked),
					"text/markdown;charset=utf-8",
				);

				toast("Downloaded", "success");
				break;

			case "json":
				download(
					`conversations-${today()}.json`,
					buildJson(items, masked),
					"application/json",
				);

				toast("Downloaded", "success");
				break;
		}
	}

	// ===========================================================================
	// EVENTS
	// ===========================================================================

	shadow.addEventListener("mousedown", (event) => {
		if (event.target.closest(".panel button")) {
			event.preventDefault();
		}
	});

	shadow.addEventListener("click", (event) => {
		const button = event.target.closest("[data-action]");

		if (!button) {
			return;
		}

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

	refs.launcher.addEventListener("mousedown", (event) =>
		event.preventDefault(),
	);

	// Left button:
	// unsaved current ticket/chat -> SAVE
	// saved current ticket/chat   -> COPY ALL
	refs.quickMain.addEventListener("click", unlessDragged(handleQuickMain));

	// Middle number:
	// click once -> red confirmation
	// click again -> clear
	refs.quickClear.addEventListener("click", unlessDragged(quickClear));

	// Right arrow:
	// expand panel
	refs.openBtn.addEventListener(
		"click",
		unlessDragged(() => {
			resetQuickClear();

			setUi({
				open: true,
			});

			render();
		}),
	);

	refs.mask.addEventListener("change", () =>
		setUi({
			redact: refs.mask.checked,
		}),
	);

	enableDrag(refs.launcher);

	enableDrag(refs.head);

	// ===========================================================================
	// KEYBOARD SHORTCUTS
	// ===========================================================================

	window.addEventListener(
		"keydown",
		(event) => {
			if (!event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey) {
				return;
			}

			if (event.code === "KeyC") {
				event.preventDefault();

				collectConversation();
			} else if (event.code === "KeyS") {
				event.preventDefault();

				collectSelection();
			}
		},
		true,
	);

	window.addEventListener("resize", applyPosition);

	// ===========================================================================
	// CROSS-TAB SYNC
	// ===========================================================================

	if (typeof GM_addValueChangeListener === "function") {
		GM_addValueChangeListener(KEY_ITEMS, (_name, _old, _new, remote) => {
			if (remote) {
				resetQuickClear();
				render();
			}
		});
	}

	// ===========================================================================
	// START
	// ===========================================================================

	clearExpiredItems();

	document.documentElement.appendChild(hostEl);

	render();

	let lastHref = location.href;

	let ticks = 0;

	setInterval(() => {
		ticks++;

		// Automatically clears yesterday's records
		// even if Zendesk/LiveChat stays open overnight.
		clearExpiredItems();

		if (!document.documentElement.contains(hostEl)) {
			document.documentElement.appendChild(hostEl);
		}

		// Zendesk and LiveChat are SPAs.
		// Re-render after navigation and periodically.
		if (location.href !== lastHref || ticks % 5 === 0) {
			lastHref = location.href;

			render();
		}
	}, 1000);
})();
