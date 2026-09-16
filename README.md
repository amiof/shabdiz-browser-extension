# Shabdiz Download Manager Extension

Browser extension companion for [Shabdiz Download Manager](https://github.com/amiof/shabdiz-download-manager) — a fast, lightweight download manager desktop app.

This extension watches downloads in your browser and forwards them to the Shabdiz app running on your machine.

## How it works

- **Automatic interception** — When enabled, any download started in the browser is cancelled and sent to the Shabdiz app instead.
- **Right-click menu** — Right-click any link or page and choose **"Download with Shabdiz"** to send that URL to the app directly.
- **Popup switch** — A popup in the toolbar has an ON/OFF switch. Turning it off means downloads behave normally (handled by the browser); turning it on restores interception.
- **Local only** — The extension only talks to `http://127.0.0.1:3325` where the Shabdiz desktop app listens. Nothing is sent anywhere else.

## Supported browsers

| Browser | Support |
|---|---|
| Chrome (MV3) | Full |
| Edge (Chromium MV3) | Full |
| Firefox (MV3) | Full |
| Safari | Limited — downloads API isn't fully supported, right-click menu may still work |

## Getting Started

### 1. Install the Shabdiz app

Download and install the [Shabdiz Download Manager desktop app](https://github.com/amiof/shabdiz-download-manager) and make sure it's running (listens on port `3325`).

### 2. Build the extension

```bash
npm  install
npm run build:chrome    # for Chrome/Edge
npm run build:firefox   # for Firefox
# or build both:
npm run build:all
```

Production bundles land in `build/chrome-mv3-prod` and `build/firefox-mv3-prod`.

### 3. Load in your browser

**Chrome / Edge**

1. Open `chrome://extensions` (or `edge://extensions`)
2. Enable **Developer mode**
3. Click **Load unpacked** and select `build/chrome-mv3-prod`

**Firefox**

1. Open `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on**
3. Pick any file inside `build/firefox-mv3-prod` (e.g. `manifest.json`)

### Development

```bash
npm run dev:chrome      # Chrome dev build with hot reload
npm run dev:firefox     # Firefox dev build with hot reload
```

Load the matching dev build (`build/chrome-mv3-dev` or `build/firefox-mv3-dev`) in your browser.

## Project structure

```
src/
├── background.ts    # Service worker: intercepts downloads, context menu, storage listener
├── popup.tsx        # Toolbar popup with the ON/OFF switch
└── lib/
    └── shabdiz.ts   # Shared helpers: storage key, enabled check, POST to Shabdiz
```

## How to use

1. Click the Shabdiz icon in your browser toolbar.
2. Toggle the switch to **ON** — downloads are now sent to the Shabdiz app.
3. Toggle it **OFF** anytime to hand control back to the browser.
4. Right-click any link and pick **"Download with Shabdiz"** for one-off downloads (works even when the switch is off).

## Troubleshooting

- **Downloads aren't being intercepted** — Make sure the Shabdiz app is running and listening on port `3325`.
- **Sent links don't duplicate after browser restart** — The extension erases intercepted downloads from browser history (Chrome only) so they don't get restored and re-sent.
- **Firefox: extension won't install** — Firefox requires a signed extension or Developer Edition with `xpinstall.signatures.required` set to `false` in `about:config`.

## License

MIT — see the [main Shabdiz repo](https://github.com/amiof/shabdiz-download-manager) for details.
