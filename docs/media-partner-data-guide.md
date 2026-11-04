# Marketech Focus partner data & visual assets — beta

## Status and intended use

This is a beta distribution for approved internal testing only. The feeds refresh during the Australian market session at an approximately 20-minute cadence and are designed to support internal research, newsroom workflows and production testing.

Do not announce, republish, mirror, redistribute or embed these feeds publicly yet. Partner-facing embeds are planned, but are not production-ready. For internal Excel access and live-feed viewing, Microsoft Edge is the recommended browser for the Excel web-data workflow.

The base URL is:

`https://jmrktch.github.io/widgets/`

Each snapshot includes a timestamped manifest. Read this first to confirm the snapshot is complete and current:

`snapshot/latest/manifest.json`

## How it works

1. A scheduled collector refreshes the market snapshot from Marketech Focus.
2. It publishes self-contained JSON resources for the supplied Australian Top 200 universe, market content and scans.
3. The same snapshot generates clean, fixed-format HTML panels and JPEG derivatives in light and dark variants.
4. GitHub Pages serves the latest version at stable URLs. Consumers should always use the `latest` path, rather than cache a particular run.

The HTML and JPEG panels are presentation artefacts generated from the JSON; JSON remains the source layer for data integrations.

## JSON feeds

All JSON feed URLs begin with `snapshot/latest/`.

| Category | Path | Contents |
| --- | --- | --- |
| Snapshot status | `manifest.json` | Generation time, market timezone, cadence, universe metadata and dataset health. |
| Stock universe | `universe.json` | Requested/published symbols for the supplied Australian Top 200 universe, plus unavailable symbols and the ticker-resource pattern. |
| Individual stocks | `tickers/{SYMBOL}.json` | One file per available stock, for example `tickers/BHP.json` or `tickers/CBA.json`. Includes quote, 5-minute/five-day candles and contract/company metadata. |
| Benchmarks | `benchmarks/{SYMBOL}.json` | Quote and 5-minute/five-day candles for `GOLD`, `AU1YY`, `US1YY`, `OOO` and `A200`. An unavailable instrument is represented explicitly rather than omitted. |
| Heatmap data | `content/heatmap.json` | Top-200 stock/sector model, weighted by market capitalisation and coloured by daily move. `scans/heatmap.json` is also available as the underlying scan-style heatmap resource. |
| Media | `content/media.json` | Current media items. |
| Dividends | `content/dividends.json` | Upcoming dividends, currently collected for the next 14 days. |
| Capital raises | `content/raises.json` | Current capital-raise items. |

### Scan feeds

Every scan is available at `scans/{SCAN}.json`:

| Scan | Path |
| --- | --- |
| Top Gainers | `scans/top-gainers.json` |
| Top Losers | `scans/top-losers.json` |
| Gapped Up | `scans/gapped-up.json` |
| Gapped Down | `scans/gapped-down.json` |
| Trading Halts | `scans/trading-halt.json` |
| 52-Week Highs | `scans/52-week-high.json` |
| 52-Week Lows | `scans/52-week-low.json` |
| RSI Oversold | `scans/rsi-oversold.json` |
| RSI Overbought | `scans/rsi-overbought.json` |

## Rendered HTML panels

Rendered panels live under `snapshot-renders/latest/`. They use portable HTML, inline styling and SVG chart/sparkline elements, making them suitable for browser display and downstream image generation.

| Panel type | URL pattern |
| --- | --- |
| Panel index | `snapshot-renders/latest/` |
| Scans | `snapshot-renders/latest/scans/{SCAN}.html` |
| Dividends | `snapshot-renders/latest/dividends.html` |
| Capital raises | `snapshot-renders/latest/raises.html` |
| Media | `snapshot-renders/latest/media.html` |
| Heatmap | `snapshot-renders/latest/heatmap.html` |
| Benchmark charts | `snapshot-renders/latest/benchmarks/{SYMBOL}.html` |

Standard table panels are 1200 × 675 (16:9); the heatmap is 1200 × 1200 (1:1); benchmark chart panels are 850 × 850. Each panel includes the Marketech Focus CTA and data disclaimer.

### Light and dark HTML

The default URL is light. Add either `?dark`, `?theme=dark` or `#dark` for the dark variant.

For example:

```text
https://jmrktch.github.io/widgets/snapshot-renders/latest/scans/top-gainers.html
https://jmrktch.github.io/widgets/snapshot-renders/latest/scans/top-gainers.html?theme=dark
```

## JPEG image assets

Every rendered panel is also captured as a high-resolution JPEG in both themes. The image manifest is:

`snapshot-renders/latest/images/manifest.json`

Image URL pattern:

```text
snapshot-renders/latest/images/light/{same-panel-path-with-jpg}
snapshot-renders/latest/images/dark/{same-panel-path-with-jpg}
```

Examples:

```text
https://jmrktch.github.io/widgets/snapshot-renders/latest/images/light/scans/top-gainers.jpg
https://jmrktch.github.io/widgets/snapshot-renders/latest/images/dark/scans/top-gainers.jpg
https://jmrktch.github.io/widgets/snapshot-renders/latest/images/light/heatmap.jpg
https://jmrktch.github.io/widgets/snapshot-renders/latest/images/dark/benchmarks/A200.jpg
```

The image manifest records each source panel, theme variant, output dimensions and generation time. Use it to discover the current asset list programmatically.

## Important beta notes

- Treat the manifest generation time as the freshness check; do not assume a URL is current solely because it is named `latest`.
- A failed or incomplete collection preserves the prior complete published snapshot rather than replacing it with partial data.
- Data, output layouts, URLs and available instruments may change during beta.
- No public syndication, public embeds or automated redistribution until written approval is provided.
