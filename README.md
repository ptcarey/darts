# Darts (darts.dusty.games)

A mobile-first PWA darts game. Plain HTML, CSS and Canvas: no framework, no build step.

- 301 or 501, best of 1, 3 or 5 legs
- **Double to win** toggle: off = any dart to exactly zero wins; on = the last dart must be a double or the bullseye (50). Below zero, or left on 1 with doubles on, is a bust
- 2 players on one phone, or 1 player vs the computer (Easy, Medium, Hard)
- Drag to aim, flick up to throw. Flick speed sets the arc: soft lobs and drops low, hard flies flat and high
- Finishing hints, 3-dart averages, best turn and 100+ counts
- **Practice** mode: unlimited darts with feedback on every flick (too soft, just right, too hard, sideways), the last flight path drawn on screen, optional targets (Bull, T20, random doubles) and a suggested Flick strength
- Forgiving flicks: anything within 25% of the ideal speed lands on the aim (`SWEET` in `game.js`); small sideways wobbles are ignored (`SIDE_FORGIVE`)
- Power bar along the bottom of the screen shows each player's last flick
- Tuned for iPhone 15 and later (built against the iPhone 16 Pro): full 3x sharpness, clear of the Dynamic Island and home indicator
- Installable and works offline once loaded

## Files

Site files live in `public/` (served as static assets by a Cloudflare Worker, configured in `wrangler.jsonc`).

| File | Purpose |
|------|---------|
| `index.html` | Screens and HUD |
| `style.css` | Styles |
| `board.js` | Board drawing, scoring, finishing hints (no DOM, unit-testable in Node) |
| `game.js` | Game flow, input, rendering, computer player |
| `sw.js` | Network-first service worker with offline fallback and update checks |
| `manifest.webmanifest`, `icons/` | PWA install details |
| `_headers` | Cloudflare Pages headers (`no-cache` so every load revalidates with the server) |

## Run locally

```
npx wrangler dev
```

Open http://localhost:8787 (or `cd public && python3 -m http.server 8000`). Add `?debug` to log flick speed and landing point to the console (handy for tuning on a real phone).

## Tuning

At the top of `game.js`:

- `FLICK`: ideal flick speed (screen heights per second) for Gentle (the default), Normal and Strong
- `SWEET`, `SIDE_FORGIVE`: how forgiving flicks are
- `CPU`: computer accuracy, as spread in millimetres (smaller is more accurate)

## Battery

The canvas only redraws while a finger is down, a dart is flying or a score label is fading. When nothing is moving, nothing is drawn. Pixel density is capped at 2x and the board is pre-rendered once per resize.

## Deploy (Cloudflare Workers, static assets)

1. Cloudflare dashboard > Workers & Pages > Create > Workers > Import a repository > `ptcarey/darts`.
2. Worker name **`darts`** (must match `name` in `wrangler.jsonc`). Build command blank, deploy command `npx wrangler deploy`, root directory `/`, production branch `main`.
3. Worker > Settings > Domains & Routes > Add > Custom domain > **`darts.dusty.games`**.
4. Every push to `main` redeploys. No version bump is needed: players pick it up automatically (see below).

## How updates reach players

- **Every visit:** the service worker always tries the network first (revalidating with the server), so an online visit runs the latest files. The offline copy is only used when offline, or if the network takes more than 4 seconds. If that happens and newer files then arrive, the page reloads itself.
- **Every return to the app:** phones often resume an installed app rather than reload it, so returning to the menu also re-checks every file with the server (at most every 2 minutes).
- **48 hour full refresh:** if 48 hours have passed since the last full download, every file is downloaded again from scratch, bypassing all caches. This is checked on open, on resume and hourly while open.
- **Never mid-game:** if a newer version arrives during a game, it is applied when the player is back on the menu.

Add `?debug` to the URL to log flicks and expose `window.__darts` for testing.
