# Marketech Focus Delayed ASX Widget

Local proof-of-concept split into:

- `collector.js`
  - logs in
  - keeps the Focus session usable
  - refreshes delayed quote snapshots
  - syncs the ASX symbol universe on startup and daily at midnight
  - writes local JSON storage
- `api.js`
  - serves the demo page
  - serves quote/chart/search endpoints
  - serves the embeddable `widget.js`

## Current shape

- Quote source:
  - `totm/get` first
  - candle fallback if needed
- Chart source:
  - `candles/get`
  - supported intervals:
    - `minute`
    - `hour`
    - `day`
    - `week`
    - `month`
- Symbol discovery:
  - `contracts/search`

## Local storage

The project currently uses JSON files as the "db":

- `symbols.json`
- `symbols-meta.json`
- `data/latest-quotes.json`
- `data/latest-charts.json`
- `data/collector-status.json`
- `data/partners.json`

## Setup

1. `npm install`
2. Copy `.env.example` to `.env`
3. Fill in:
   - `FOCUS_LOGIN_URL=https://focus.marketech.com.au/#/login`
   - `FOCUS_EMAIL=...`
   - `FOCUS_PASSWORD=...`
4. Install Playwright Chromium once:
   - `npx playwright install chromium`

## Run

- `npm run dev`
  - starts `collector.js` and `api.js`
- `npm run start:all`
  - same as `npm run dev`
  - useful for hosts where you set one production start command
- `npm run collector`
  - starts just the collector
- `npm run api`
  - starts just the API
- `npm run partner-host`
  - starts the separate local partner test page

Open:

- `http://localhost:3000`
- `http://localhost:8080`

## API

- `GET /api/quote/:symbol`
- `GET /api/chart/:symbol?interval=minute|hour|day|week|month`
- `GET /api/search?q=BHP`
- `GET /api/public/quote/:symbol`
- `GET /api/public/chart/:symbol?interval=minute|hour|day|week|month`
- `GET /widget.js`
- `GET /internal/status`

## Notes

- Partner widgets should hit your API, not the Marketech platform directly.
- Quotes are intended to be refreshed broadly by the collector.
- Charts can now be prefetched broadly by the collector and cached locally.
- Default chart collection cadence is every 10 minutes across:
  - `minute`
  - `hour`
  - `day`
  - `week`
  - `month`
- Symbol sync now fits the same collector architecture:
  - runs on startup by default
  - runs again at local midnight by default
  - rewrites `symbols.json` and `symbols-meta.json`
- This is still a local/dev proof, not a production deployment model.

## Cheapest deployment path

The fastest low-cost path for this repo is:

1. Run this app on a Node host
2. Keep WordPress only for the public pages
3. Paste the widget embed snippet into WordPress with a Custom HTML block

This app is not WordPress-only because it still needs:

- a long-running API process serving `widget.js` and `/api/public/*`
- a long-running collector process refreshing cached data and auth

### Free-host setup

For a free always-on test deployment, use a host that can run one Node service continuously.

- Build command: `npm install`
- Start command: `npm run start:all`

### Environment variables

At minimum, set:

- `PORT`
- `MARKETECH_COOKIE`

Or, if you want the app to refresh auth itself, set:

- `FOCUS_LOGIN_URL`
- `FOCUS_EMAIL`
- `FOCUS_PASSWORD`

Useful defaults from `.env.example`:

- `PUBLIC_WIDGET_REFRESH_MS=60000`
- `QUOTE_REFRESH_INTERVAL_MS=60000`
- `COOKIE_REFRESH_INTERVAL_MS=600000`
- `CHART_REFRESH_INTERVAL_MS=600000`

### WordPress embed

After deployment, replace `YOUR-WIDGET-DOMAIN` with your real widget host and paste this into a WordPress Custom HTML block:

```html
<div id="mt-ticker-widget"></div>
<script
  src="https://YOUR-WIDGET-DOMAIN/widget.js"
  data-widget="ticker"
  data-symbol="ASX:BHP"
  data-width="100%"
  data-container-id="mt-ticker-widget"
  data-refresh-ms="10000"
  async></script>
```

If the editor strips `<script>` tags, use a snippets/plugin block that allows raw embed code.

### Important caveat

This project stores cache/state in local JSON files. On a free host, expect those files to reset on redeploy or restart. The collector should refill them, but this is still a pragmatic prototype deployment rather than a hardened production setup.
