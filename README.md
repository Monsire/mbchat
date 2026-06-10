# mbchat

Self-hosted livestream chat aggregator. Merges live chat from **Twitch**, **Kick**, **YouTube**, and **X** into one feed, with cross-platform polls, viewer spotlights, and an OBS-ready stream overlay.

## Pages

| Route | Purpose |
|---|---|
| `/` | Admin panel — manage chat sources, run polls, spotlight viewers, style the stream display |
| `/chat` | Public combined chat page (supports `?embed=1` for a frameless read-only embed) |
| `/obschat` | Stream display for OBS — combined chat, polls, and spotlights with admin-controlled styling |
| `/watch` | Minimal watch page — Twitch player with embedded chat |

## Features

- Combined real-time chat from Twitch (IRC), Kick (WebSocket), YouTube (live chat polling), and X (broadcast chat)
- Cross-chat polls: viewers vote by typing an option number or its text in any connected chat (one vote per user per platform), with live bar/pie charts and an optional timer
- Viewer spotlight: pin a user's message history on stream, with streamer-controlled scroll sync
- Per-source and total live viewer counts
- User popups with profile pictures, badge art, and message logs
- Stream display styling controlled from the admin panel: text size, stroke width, colors, background, chat toggle

## Running

```bash
npm install
npm start
```

Serves at `http://localhost:4173`. Sources are configured from the admin panel and live in server memory (re-add them after a restart).

> Kick API access uses a headless Chromium (Playwright) to get past Cloudflare; the first Kick lookup may take a few seconds.
