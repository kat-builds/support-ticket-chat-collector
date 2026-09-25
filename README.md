# Zendesk & LiveChat Collector

A browser script for saving Zendesk tickets and LiveChat conversations as clean Markdown for QA reviews or AI analysis.

You can save the whole ticket or chat in one click, or select only the part you need. Saved items stay together while you move between pages, so you can collect several examples and copy or download them in one batch.

The script can also mask email addresses and phone numbers when you copy or download the collected content. The masking is basic, so the output should still be checked before sharing.

## What It Does

- Saves the full conversation from a Zendesk ticket or LiveChat chat
- Saves only selected text when you do not need the whole conversation
- Keeps multiple saved items together across pages and browser tabs
- Copies the full batch as clean Markdown
- Downloads the batch as Markdown or JSON
- Optionally masks email addresses and phone numbers during copy and download
- Keeps links and useful conversation structure where possible

## Why I Made It

When I review support work, I often need only part of a ticket or chat, or several conversations together.

Doing that manually means selecting text, copying it somewhere else, cleaning it up, switching pages, and repeating the same steps again.

I made this script so I can collect the material while I am reviewing it, then export everything together when I am ready.

## Installation

This is a Tampermonkey userscript.

1. Install **Tampermonkey** in your browser.
2. Open Tampermonkey and create a new userscript.
3. Open `conversation-collector.user.js` in this repository.
4. Copy the full script into the Tampermonkey editor.
5. Save it.
6. Open a Zendesk ticket or LiveChat conversation. The collector will appear on the page.

The script currently runs on:

- Zendesk Agent pages
- LiveChat
- LiveChat Inc

## How to Use It

### Save the whole ticket or chat

Open a Zendesk ticket or LiveChat conversation and choose **Save this ticket** or **Save this chat**.

The current conversation is added to the saved list.

### Save only part of it

Select the text you want on the page, then choose **Save only the selected text**.

Selected excerpts are stored separately, so they do not overwrite the full conversation from the same ticket or chat.

### Export what you collected

Open the collector panel when you are ready.

You can:

- Copy everything as Markdown
- Download a `.md` file
- Download a `.json` file
- Clear saved items when you are finished

## Privacy Masking

**Mask emails and phone numbers** is enabled by default.

When it is on, the script replaces email addresses and likely phone numbers in copied and downloaded output.

This is a convenience check, not a complete privacy filter. Always review the exported content before sharing it with another person or an AI tool.

## Keyboard Shortcuts

- **Alt + Shift + C** — save the current ticket or chat
- **Alt + Shift + S** — save selected text

On macOS, the script shows the equivalent Option + Shift shortcuts in the interface.

## Script

The complete userscript is in:

`conversation-collector.user.js`

## Notes

This tool reads content that is already visible in the Zendesk or LiveChat page you have open. It stores collected items through Tampermonkey so they can stay available while you move between supported pages.

Zendesk and LiveChat can change their page structure over time, so selectors may need to be updated if either interface changes.

## License

MIT License.
