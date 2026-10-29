# @pipeworx/pa-medical-exclusions

Pennsylvania Department of Human Services (DHS) Medicheck Precluded
Providers List screening — check a provider by name, NPI, license number, or
FEIN against the ~6,750-row list of providers and businesses ever precluded
from Pennsylvania's Medical Assistance (Medicaid) program, the state-level
counterpart to the federal HHS OIG LEIE (`leie` pack) and the sibling of
`ny-omig-exclusions` (New York), `ca-medical-exclusions` (California),
`tx-medical-exclusions` (Texas) and `fl-medical-exclusions` (Florida).

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1856+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `pa_medical_check_exclusion(name?, npi?, license?, fein?, limit?)` —
  screens a provider against the DHS Medicheck list. An NPI, license, or
  FEIN match is an **identification** (all three are exact identifiers); a
  name match — even an exact one — is a **candidate lead only**, since the
  list carries no date of birth to disambiguate same-named providers. Every
  match carries DHS's own `status` field and a `currently_precluded` flag
  derived from it — `null` with `status_unknown: true` on the minority of
  rows where DHS's own status is blank, rather than a guess.
- `pa_medical_exclusion_coverage()` — total rows ever recorded, how many are
  currently precluded vs. ended vs. status-unknown, how many carry an NPI,
  license number, or FEIN, the distinct status values DHS uses, and the
  oldest/newest preclusion effective date. Pass `year` or
  `start_date`/`end_date` to instead count preclusions whose effective date
  falls in that range, over the whole list.

## Auth

Keyless.

## Data sources

- Pennsylvania Department of Human Services (DHS), Medicheck Precluded
  Providers List — the state's published roster of individuals, businesses
  and other entities precluded from participating in Pennsylvania's Medical
  Assistance program, searchable at
  <https://www.humanservices.dhs.pa.gov/Medchk/> and downloadable as a full
  text file directly from that same application.

### Why no open-data-portal mirror — checked, not assumed

A Socrata catalog search of data.pa.gov
(`api.us.socrata.com/api/catalog/v1?domains=data.pa.gov`) for "medicheck",
"precluded", "excluded provider" and "medicaid sanction" (2026-10-17)
returned zero matching datasets. DHS's own Medicheck search application is
the only source.

### Why this is baked, not a live proxy

Per root CLAUDE.md's standing rule for a table this size, the full list
(6,751 rows at capture time, ~2.7MB as generated TypeScript) is baked by
`scripts/bake-index.mjs` into `src/pa-medchk-index-data.ts`, registered in
`workers/gateway/src/pack-baked-indexes.json`, uploaded to KV at deploy, and
injected into every call as `args._bakedIndex` — never a static module-scope
import (fleet #2754: six packs doing that put ~48MB of retained heap into
every gateway isolate and cost about one call in four as a Cloudflare 1102).
A missing or malformed injection throws loudly rather than answering
"not found" — see `src/index.test.ts`.

Unlike `tx-medical-exclusions`, no ASP.NET VIEWSTATE postback is needed: the
Medicheck application's "Download Text File" button is a plain,
unauthenticated GET, verified live 2026-10-17.

Re-run `node mcps/pa-medical-exclusions/scripts/bake-index.mjs` periodically
and recommit; `data_as_of` on every response says how stale the baked copy
is.

### Status is messy — `currently_precluded` is derived and labelled

DHS's own `Status` field (`Precluded`, `Terminated`, `Reinstated`,
`Suspended`, `Withdrawal`, `Voluntary Withdrawal`, `Permanent Preclusion`,
`Permanent Withdrawal`, `Terminated-No Cause`) is the closest thing to a
current-state flag, but 466 of 6,751 rows (2026-10-17 capture) carry a
**blank** `Status` — checked directly, not assumed: `EndDate` presence does
not cleanly correlate with `Status` either way (plenty of `Precluded` rows
also carry an `EndDate`), so `EndDate` cannot be used to resolve the blanks.
This pack derives `currently_precluded` from `Status` alone when `Status` is
one of DHS's own recognized values, and reports `currently_precluded: null`
with `status_unknown: true` on the blank rows — a guess here would be the
silent wrong-answer shape root CLAUDE.md's loud-failure rule exists to
prevent.

### Ever-precluded vs. currently-precluded

Same shape as the four precedent state packs: this download is the **ever**
precluded list, not a currently-precluded-only list — rows go back to 1957
and include providers long since reinstated, terminated, or withdrawn.
`ever_vs_current_caveat` states this on every response.

### Matching

An `npi` query matches only exact 10-digit numeric NPI values. A `license`
query matches `LicenseNumber`, letters/digits only (case-insensitive,
punctuation/whitespace stripped) — Pennsylvania license numbers are
alphanumeric (e.g. `AJ006399L`) and sometimes carry an out-of-state
annotation in parentheses (e.g. `172434 (NY)`), so `license: "172434"`
matches that row too. A `fein` query matches the federal EIN exactly,
digits only. Name queries match against the provider's assembled individual
name (first/middle/last), business name, or DHS's recorded alias, any word
order, case/punctuation-insensitive.

### Reachability

Verified live 2026-10-17 with a laptop curl against
`https://www.humanservices.dhs.pa.gov/Medchk/MedchkSearch/Medchk?target=_blank`:
200, `text/plain`, quoted comma-delimited CRLF file, 6,751 data rows. No
session state, cookies, or form replay required — simpler than the
VIEWSTATE handshake `tx-medical-exclusions` needs.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "pa-medical-exclusions": {
      "url": "https://gateway.pipeworx.io/pa-medical-exclusions/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/pa-medical-exclusions/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1856+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/pa_medical_check_exclusion \
  -H 'Content-Type: application/json' \
  -d '{"name":"Zeidler"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/pa_medical_check_exclusion`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Run it from npm

`@pipeworx/mcp-pa-medical-exclusions` is a local stdio bridge to the Pipeworx gateway: your MCP client
starts it with `npx`, and it forwards every call to the same
`https://gateway.pipeworx.io/pa-medical-exclusions/mcp` endpoint shown above. It needs network access;
there is no offline mode.

```json
{
  "mcpServers": {
    "pa-medical-exclusions": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-pa-medical-exclusions"]
    }
  }
}
```

Without a key it calls anonymously, capped at 50 calls a day. A free account
raises that to 200 a day: get a key at https://pipeworx.io/signup and add
`"env": { "PIPEWORX_API_KEY": "<your key>" }` to the server entry.
The key is sent as a Bearer token, the same way a hosted connection sends it,
so calls are metered and billed exactly as they are there.

It lists **only** this pack's tools by default. Set `PIPEWORX_META_TOOLS=1` to
also list `ask_pipeworx` and the other gateway-wide tools.

Behind an HTTPS proxy: Node's built-in `fetch` does not read `HTTPS_PROXY` by
default. Newer Node releases honour it when `NODE_USE_ENV_PROXY=1` is set; check
your Node version's documentation.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Pa Medical Exclusions data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
