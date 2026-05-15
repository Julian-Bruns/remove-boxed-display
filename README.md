# ChatGPT Math Normalizer

Personal Manifest V3 WebExtension for ChatGPT that:

- removes visual borders from KaTeX `\boxed`, `\fbox`, and `\fcolorbox` output
- converts KaTeX display math into inline flow
- can re-render simple display formulas as true inline KaTeX with local bundled KaTeX
- leaves complex display formulas untouched when `Skip complex display math` is enabled

## Install locally

### Chrome / Chromium

1. Open `chrome://extensions`.
2. Enable `Developer mode`.
3. Choose `Load unpacked` and select this folder.

### Zen / Firefox

1. Open `about:debugging#/runtime/this-firefox`.
2. Choose `Load Temporary Add-on...`.
3. Select `manifest.json` from this folder.

The extension requests only the `storage` permission. Its static content script runs on:

- `https://chatgpt.com/*`
- `https://chat.openai.com/*`

Zen uses Firefox-compatible extensions, so the manifest includes a Gecko add-on ID for Firefox/Zen `storage.sync`.

## Development

Run `npm run check` for JavaScript syntax checks.

KaTeX is already vendored in `vendor/katex`. To refresh it, run:

```sh
npm install
npm run vendor:katex
```
