# Marketech Focus snapshot scheduler

This free Cloudflare Worker replaces the unreliable GitHub Actions `schedule`
event. It runs every 20 minutes in UTC, then checks the scheduled instant in
`Australia/Sydney` so AEST/AEDT is handled automatically.

It dispatches the GitHub Actions collector only at these Sydney weekday slots:

- 09:20 and 09:40
- 10:00 through 16:40 at `:00`, `:20`, and `:40`

## Deployment requirements

Set `GITHUB_TOKEN` as a Worker secret. It must be a fine-grained GitHub token
restricted to `jmrktch/widgets`, with permission to dispatch Actions workflows.
Never add that token to this repository or to `wrangler.jsonc`.

After deployment, use the Worker Logs / Cron Trigger past-events view to check
for a `dispatched` entry at the next market slot. GitHub Actions remains the
collector and GitHub Pages publisher; this Worker only starts the workflow.
