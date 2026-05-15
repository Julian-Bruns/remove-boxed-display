# ChatGPT Math Normalizer

Personal Manifest V3 browser extension for ChatGPT that:

- removes visual borders from KaTeX `\boxed`, `\fbox`, and `\fcolorbox` output
- converts KaTeX display math into inline flow
- can re-render simple display formulas as true inline KaTeX with local bundled KaTeX
- leaves complex display formulas untouched when `Skip complex display math` is enabled

## Install locally

1. Open `chrome://extensions`.
2. Enable `Developer mode`.
3. Choose `Load unpacked` and select this folder.

The extension requests only the `storage` permission. Its static content script runs on:

- `https://chatgpt.com/*`
- `https://chat.openai.com/*`

## Development

Run `npm run check` for JavaScript syntax checks.

KaTeX is already vendored in `vendor/katex`. To refresh it, run:

```sh
npm install
npm run vendor:katex
```
