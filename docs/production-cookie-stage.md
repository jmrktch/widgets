# Production stage 1: external cookie refresh

The GitHub Action performs the Focus login. The deployed Node service receives
the resulting cookie through `POST /internal/runtime-cookie`; it stores it only
in `data/runtime-cookie.json`. That file is ignored by Git and must be on a
private persistent service volume. The cookie is never placed in `public/`, a
GitHub artifact, a repository secret output, or an unauthenticated endpoint.

## Required deployment configuration

Set these on the deployed Node service:

```text
COOKIE_UPDATE_TOKEN=<long random secret>
COOKIE_REFRESH_ENABLED=false
```

Keep the existing `FOCUS_*` credentials out of the service once GitHub Actions
owns login. The service needs a persistent volume mounted at `/app/data` (the
container working directory is `/app`).

Add these GitHub repository secrets:

```text
FOCUS_EMAIL=<Focus account email>
FOCUS_PASSWORD=<Focus account password>
COOKIE_UPDATE_URL=https://<service-host>/internal/runtime-cookie
COOKIE_UPDATE_TOKEN=<the same long random secret>
```

`COOKIE_STATUS_URL` is optional. When omitted, the workflow derives
`/internal/auth-status` from `COOKIE_UPDATE_URL`.

The private status endpoint only returns whether a runtime cookie is present
and when it was last written. It requires `x-cookie-update-token` and never
returns the cookie, its hash, or its length.
`/internal/status` is protected by the same token because its diagnostics are
operational information, not public API data.

The workflow checks every ten minutes, but only logs in on Sydney weekdays from
09:00 to 17:30 when the cookie is missing or older than four hours. This keeps
a one-hour authentication runway on either side of the ASX 10:00–16:30 session.
It does not
yet have an ASX public-holiday calendar; the collector currently has the same
weekday/time-window limitation.

## Local one-hour soak test

Use a local `.env` with valid Focus credentials and:

```text
COOKIE_REFRESH_ENABLED=false
COOKIE_UPDATE_TOKEN=local-test-secret
QUOTE_BATCH_SIZE=10
CHART_BATCH_SIZE=10
QUOTE_BATCH_PAUSE_MS=150
CHART_BATCH_PAUSE_MS=150
```

In one terminal, start both long-running processes:

```powershell
npm.cmd start
```

In a second terminal, refresh the cookie once:

```powershell
npm.cmd run auth:refresh-cookie
```

Observe `data/collector-status.json` for at least an hour. The useful recovery
check is to stop and restart `npm start`, then run the refresh command again;
quotes and charts should resume without clearing the existing data files.
Do not commit `.env`, `data/`, `refresh-state.json`, or `runtime-cookie.json`.
