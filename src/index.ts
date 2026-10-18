interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Shared "count records by a named date field over a year or range" helper —
 * fleet #3170.
 *
 * WHY THIS EXISTS. Four baked-table packs (ny-omig-exclusions,
 * tx-medical-exclusions, ca-medical-exclusions, fl-medical-exclusions) each
 * hold thousands of rows and each had only a list-wide total — no way to
 * answer "how many took effect in year Y" without a caller paging through
 * every row itself. A benchmark probe (fleet #3170/#3149) asked exactly that
 * question against two of them and both returned the SAME list-wide total on
 * every one of 7-8 rounds; the model ran out of rounds and refused rather
 * than get a wrong number. This is the one piece of that fix every pack
 * shares: parsing `year` or `start_date`/`end_date` into an inclusive
 * YYYY-MM-DD range, or a NAMED reason when the input can't be turned into
 * one. It deliberately never returns a silent zero for a bad argument —
 * root CLAUDE.md's silent-zero policy applies to a malformed count request
 * exactly as it does to an upstream outage.
 *
 * WHAT IT DOES NOT DO. It does not touch the rows — each pack's own ISO date
 * field (already YYYY-MM-DD in every one of these four) is filtered by plain
 * string comparison, which is correct for YYYY-MM-DD strings and avoids a
 * Date() parse / timezone trap entirely. Each pack is responsible for saying
 * which of its own fields it counted (data varies: NY/TX/CA have exactly one
 * exclusion-date field each; FL additionally splits "all sanction orders" vs
 * "participation exclusions" within the matched range).
 */

interface DateRange {
  /** Inclusive start date, YYYY-MM-DD. */
  start: string;
  /** Inclusive end date, YYYY-MM-DD. */
  end: string;
  /** Human label for the range, e.g. "2025" or "2024-06-01 to 2025-06-01". */
  label: string;
}

interface DateRangeError {
  error: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Reads `args.year`, `args.start_date` and `args.end_date` and returns:
 *   - `null` if none were passed (no date-range count was requested at all —
 *     the caller should fall through to its normal, non-counting response);
 *   - `{ error }` if something WAS passed but can't be turned into a valid
 *     range (bad format, start after end, year out of a sane bound) — the
 *     caller must surface this as a named reason, never as a zero count;
 *   - `{ start, end, label }` otherwise.
 *
 * start_date/end_date, if either is present, take precedence over `year`
 * (an explicit range is a more specific request than a calendar year).
 */
function parseYearOrDateRange(args: Record<string, unknown>): DateRange | DateRangeError | null {
  const startRaw = typeof args.start_date === 'string' ? args.start_date.trim() : '';
  const endRaw = typeof args.end_date === 'string' ? args.end_date.trim() : '';
  const yearRaw = args.year;
  const yearGiven = yearRaw !== undefined && yearRaw !== null && yearRaw !== '';

  if (!startRaw && !endRaw && !yearGiven) return null;

  if (startRaw || endRaw) {
    if (!DATE_RE.test(startRaw) || !DATE_RE.test(endRaw)) {
      return {
        error:
          `start_date and end_date must BOTH be present and in YYYY-MM-DD form ` +
          `(got start_date=${startRaw ? JSON.stringify(startRaw) : '(missing)'}, end_date=${endRaw ? JSON.stringify(endRaw) : '(missing)'}).`,
      };
    }
    if (startRaw > endRaw) {
      return { error: `start_date (${startRaw}) is after end_date (${endRaw}).` };
    }
    return { start: startRaw, end: endRaw, label: startRaw === endRaw ? startRaw : `${startRaw} to ${endRaw}` };
  }

  const year = Math.floor(Number(yearRaw));
  if (!Number.isFinite(year) || year < 1900 || year > 2100) {
    return { error: `year must be a 4-digit calendar year between 1900 and 2100 (got ${JSON.stringify(yearRaw)}).` };
  }
  return { start: `${year}-01-01`, end: `${year}-12-31`, label: String(year) };
}

function isDateRangeError(r: DateRange | DateRangeError | null): r is DateRangeError {
  return r != null && typeof (r as DateRangeError).error === 'string';
}

/** Inclusive YYYY-MM-DD membership test; `null`/empty dates never match. */
function inRange(date: string | null | undefined, range: DateRange): boolean {
  return Boolean(date) && (date as string) >= range.start && (date as string) <= range.end;
}

const DATE_RANGE_ARG_SCHEMA = {
  year: {
    type: 'number' as const,
    description: 'Count records whose date field falls in this calendar year (e.g. 2025), counted over the WHOLE list, not a page. Ignored if start_date/end_date are given.',
  },
  start_date: {
    type: 'string' as const,
    description: 'Inclusive range start, YYYY-MM-DD. Use with end_date for a custom date range instead of a calendar year.',
  },
  end_date: {
    type: 'string' as const,
    description: 'Inclusive range end, YYYY-MM-DD. Use with start_date for a custom date range instead of a calendar year.',
  },
};
/**
 * Pennsylvania Department of Human Services (DHS) Medicheck Precluded
 * Providers List screening — fleet #3277, the fifth state exclusion pack
 * after mcps/ny-omig-exclusions (#2788), mcps/ca-medical-exclusions (#2805),
 * mcps/tx-medical-exclusions (#2809) and mcps/fl-medical-exclusions.
 *
 * Beside the federal HHS OIG LEIE (mcps/leie) and the SAM federal
 * exclusions list, Pennsylvania runs its own Medical Assistance exclusion
 * list through DHS's "Medicheck" program: providers, individuals and
 * entities precluded from participating in or billing Pennsylvania's
 * Medical Assistance (Medicaid) program. This is that list, for
 * Pennsylvania only — one pack per jurisdiction (root CLAUDE.md rule 5).
 *
 * SOURCE AND SHAPE. No open-data-portal mirror exists for this dataset —
 * checked, not assumed: a Socrata catalog search of data.pa.gov
 * (api.us.socrata.com/api/catalog/v1?domains=data.pa.gov) for "medicheck",
 * "precluded", "excluded provider" and "medicaid sanction" (2026-10-17)
 * returned zero matching datasets. DHS's Medicheck search page
 * (https://www.humanservices.dhs.pa.gov/Medchk/) carries a "Download Text
 * File" button that is a PLAIN, UNAUTHENTICATED GET to
 * https://www.humanservices.dhs.pa.gov/Medchk/MedchkSearch/Medchk?target=_blank
 * — no VIEWSTATE postback needed (unlike tx-medical-exclusions), verified
 * live 2026-10-17 with a laptop curl: 200, quoted comma-delimited CRLF text,
 * 6,751 data rows.
 *
 * Root CLAUDE.md's standing rule 3 still applies regardless of
 * reachability: a baked table this size (6,751 rows, ~2.7MB as generated
 * TS) never sits in gateway module scope. It is baked by
 * mcps/pa-medical-exclusions/scripts/bake-index.mjs into
 * src/pa-medchk-index-data.ts, registered in
 * workers/gateway/src/pack-baked-indexes.json, uploaded to KV at deploy,
 * and injected here as `args._bakedIndex` — same pattern as the four
 * precedent packs (fleet #2754).
 *
 * This is an official Pennsylvania State public enforcement record that DHS
 * publishes specifically so providers, payers and the public can screen
 * against it — baking a copy needs no reuse grant, same footing as the
 * federal LEIE and the four precedent state packs.
 *
 * STATUS IS MESSY — currently_precluded IS DERIVED AND LABELLED, NEVER
 * TRUSTED BLINDLY. DHS's own `Status` field is the closest thing to a
 * current-state flag, but 466 of 6,751 rows (2026-10-17 capture) carry a
 * BLANK Status, and EndDate presence does not cleanly correlate with Status
 * either way — checked directly, not assumed. `currently_precluded` is
 * `true`/`false` only when Status is one of DHS's own recognized values,
 * and `null` with `status_unknown: true` on the blank rows, rather than
 * guessing.
 *
 * THIS IS THE "EVER PRECLUDED" FILE, NOT "CURRENTLY PRECLUDED ONLY" — same
 * shape as the TX/CA/NY precedent packs: rows go back to 1957 and include
 * providers long since reinstated or withdrawn.
 *
 * MATCHING MODEL, same shape as the four precedent packs: an NPI, license,
 * or FEIN match identifies a specific provider or business (all three are
 * exact identifiers DHS assigns/records). A name match — even an exact one
 * — is a CANDIDATE, never an identification: this list has no date of
 * birth, and common surnames repeat across 6,751 rows spanning 1957-2026.
 * License numbers are alphanumeric (not purely numeric like TX/NY) and
 * sometimes carry an out-of-state annotation in parens (e.g.
 * "172434 (NY)"); matching strips non-alphanumeric characters before
 * comparing.
 *
 * Keyless.
 */
import type { PaMedchkRow } from './pa-medchk-index-data.js';

// fleet #2754 / root CLAUDE.md rule 3 — the baked table (6,751 rows,
// ~2.7MB) is injected by the gateway as `args._bakedIndex`, loaded from KV
// once per isolate. NEVER value-import ./pa-medchk-index-data.js here —
// only the type-only import above, which is erased at compile time. A
// value import puts the whole table back in the bundle and into every
// isolate's heap; scripts/check-gateway-bundle-size.mjs fails the deploy if
// that happens.
let ROWS: PaMedchkRow[] = [];
let DATA_AS_OF = '';
let SOURCE_URL = '';
let SEARCH_URL = '';
let CAPTURED_AT = '';
let TOTAL_ROWS = 0;

function ensureIndex(args: Record<string, unknown>): void {
  if (ROWS.length) return;
  const idx = args._bakedIndex as Record<string, unknown> | null | undefined;
  const rows = idx?.PA_MEDCHK_ROWS;
  if (!Array.isArray(rows) || rows.length === 0) {
    // Loud on purpose (root CLAUDE.md rule 2): answering "no match found"
    // from an empty table would be a silent wrong answer, indistinguishable
    // from a real clean screening result.
    throw new Error(
      `pa-medical-exclusions: the baked PA DHS Medicheck index is unavailable (${idx == null ? 'not injected' : 'malformed'}). ` +
        'The gateway loads it from KV on the first call into this pack; this is a server-side fault, not a bad query — retry shortly.',
    );
  }
  ROWS = rows as PaMedchkRow[];
  DATA_AS_OF = String(idx?.PA_MEDCHK_DATA_AS_OF ?? '');
  SOURCE_URL = String(idx?.PA_MEDCHK_SOURCE_URL ?? 'https://www.humanservices.dhs.pa.gov/Medchk/MedchkSearch/Medchk?target=_blank');
  SEARCH_URL = String(idx?.PA_MEDCHK_SEARCH_URL ?? 'https://www.humanservices.dhs.pa.gov/Medchk/');
  CAPTURED_AT = String(idx?.PA_MEDCHK_CAPTURED_AT ?? '');
  TOTAL_ROWS = Number(idx?.PA_MEDCHK_TOTAL_ROWS ?? ROWS.length);
}

const SOURCE_LABEL = 'Pennsylvania Department of Human Services (DHS) — Medicheck Precluded Providers List';

const ACTIVE_STATUSES = new Set(['Precluded', 'Suspended', 'Permanent Preclusion']);
const ENDED_STATUSES = new Set([
  'Terminated', 'Reinstated', 'Withdrawal', 'Voluntary Withdrawal', 'Permanent Withdrawal', 'Terminated-No Cause',
]);

const STATUS_CAVEAT =
  'DHS\'s own Status field is the closest thing to a current-state flag, but a minority of rows (about 7% at the last capture) carry a blank Status that this pack cannot resolve to active or ended — those are reported with currently_precluded:null and status_unknown:true rather than a guess.';

const EVER_VS_CURRENT_CAVEAT =
  'This dataset is DHS\'s "ever precluded" Medicheck list, not a currently-precluded-only list — it includes providers later reinstated, terminated or withdrawn, with rows going back to 1957. currently_precluded is DERIVED from Status (see status_caveat); DHS does not publish a single current-status boolean itself.';

const NOT_AN_ANSWER =
  'Name matches are CANDIDATES, not identifications — this list has no date of birth to tell same-named providers apart. Only an NPI, license-number, or FEIN match identifies a specific provider or business. Confirm a name match against one of those before acting on it.';

function normalize(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

function alnumOnly(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function digitsOnly(s: string): string {
  return s.replace(/\D/g, '');
}

function fullName(r: PaMedchkRow): string {
  const parts = [r.first_name, r.middle_name, r.last_name].filter((p): p is string => Boolean(p));
  return parts.join(' ');
}

function displayName(r: PaMedchkRow): string {
  return fullName(r) || r.business_name || r.provider_name || 'Unknown';
}

function isTenDigitNpi(s: string): boolean {
  return /^\d{10}$/.test(s);
}

function currentlyPrecluded(status: string | null): boolean | null {
  if (!status) return null;
  if (ACTIVE_STATUSES.has(status)) return true;
  if (ENDED_STATUSES.has(status)) return false;
  return null;
}

type MatchType = 'npi_match' | 'license_match' | 'fein_match' | 'name_candidate_exact' | 'name_candidate_partial';

const MATCH_MEANING: Record<MatchType, string> = {
  npi_match: 'The NPI matched exactly against this provider\'s listed NPI. An NPI identifies one provider, so this is an identification.',
  license_match: 'The license number matched exactly (letters/digits only, case-insensitive). A license number identifies one provider, so this is an identification.',
  fein_match: 'The federal EIN matched exactly. An EIN identifies one business, so this is an identification.',
  name_candidate_exact: 'The name matched exactly (individual name, business name, or a recorded alias), but this list has no date of birth to confirm it is the same person or entity — several precluded providers can share a name. Confirm with NPI, license number, or FEIN before acting.',
  name_candidate_partial: 'The name is a partial/substring match, not exact, checked against the provider\'s individual name, business name, and recorded alias. Treat as a lead to check, not a finding. Confirm with NPI, license number, or FEIN.',
};

function shape(r: PaMedchkRow, matchType: MatchType) {
  const status = r.status;
  const current = currentlyPrecluded(status);
  return {
    provider_name: displayName(r),
    business_name: r.business_name,
    alias: r.alias,
    title: r.title,
    license_number: r.license_number,
    npi: r.npi,
    fein: r.fein,
    status,
    currently_precluded: current,
    status_unknown: current === null,
    begin_date: r.begin_date,
    end_date: r.end_date,
    list_date: r.list_date,
    date_last_changed: r.date_last_changed,
    county_assistance_office: r.cao,
    match_type: matchType,
    what_that_means: MATCH_MEANING[matchType],
  };
}

async function checkExclusion(args: Record<string, unknown>) {
  const nameRaw = typeof args.name === 'string' ? args.name.trim() : '';
  const npiRaw = typeof args.npi === 'string' ? digitsOnly(args.npi) : '';
  const licenseRaw = typeof args.license === 'string' ? args.license.trim() : '';
  const licenseAlnum = licenseRaw ? alnumOnly(licenseRaw) : '';
  const feinRaw = typeof args.fein === 'string' ? digitsOnly(args.fein) : '';

  if (!nameRaw && !npiRaw && !licenseRaw && !feinRaw) {
    return {
      found: false,
      reason: 'no_query',
      hint: 'Pass name (the provider or business to screen), and/or npi, license, and/or fein. An NPI, license, or FEIN match is an identification; a name match is a lead.',
      source: SOURCE_LABEL,
      source_url: SOURCE_URL,
      data_as_of: DATA_AS_OF,
    };
  }

  const limit = Math.max(1, Math.min(50, Math.floor(typeof args.limit === 'number' ? args.limit : 10)));

  const npiMatches = npiRaw && isTenDigitNpi(npiRaw) ? ROWS.filter((r) => r.npi && digitsOnly(r.npi) === npiRaw) : [];
  const licenseMatches = licenseAlnum
    ? ROWS.filter((r) => r.license_number && alnumOnly(r.license_number) === licenseAlnum)
    : [];
  const feinMatches = feinRaw ? ROWS.filter((r) => r.fein && digitsOnly(r.fein) === feinRaw) : [];

  const identitySeen = new Set<PaMedchkRow>();
  const identityResults: ReturnType<typeof shape>[] = [];
  for (const r of npiMatches) {
    if (identitySeen.has(r)) continue;
    identitySeen.add(r);
    identityResults.push(shape(r, 'npi_match'));
  }
  for (const r of licenseMatches) {
    if (identitySeen.has(r)) continue;
    identitySeen.add(r);
    identityResults.push(shape(r, 'license_match'));
  }
  for (const r of feinMatches) {
    if (identitySeen.has(r)) continue;
    identitySeen.add(r);
    identityResults.push(shape(r, 'fein_match'));
  }

  let nameResults: ReturnType<typeof shape>[] = [];
  if (nameRaw) {
    const qNorm = normalize(nameRaw);
    const qTokens = qNorm.split(' ').filter(Boolean);
    const exact: ReturnType<typeof shape>[] = [];
    const partial: ReturnType<typeof shape>[] = [];
    for (const r of ROWS) {
      if (identitySeen.has(r)) continue;
      const fullNorm = normalize(fullName(r));
      const businessNorm = r.business_name ? normalize(r.business_name) : '';
      const aliasNorm = r.alias ? normalize(r.alias) : '';
      if (
        (fullNorm && qNorm === fullNorm) ||
        (businessNorm && qNorm === businessNorm) ||
        (aliasNorm && qNorm === aliasNorm)
      ) {
        exact.push(shape(r, 'name_candidate_exact'));
      } else if (
        qTokens.length > 0 &&
        qTokens.every((t) => fullNorm.includes(t) || businessNorm.includes(t) || aliasNorm.includes(t))
      ) {
        partial.push(shape(r, 'name_candidate_partial'));
      }
    }
    nameResults = [...exact, ...partial];
  }

  const combined = [...identityResults, ...nameResults];
  const truncated = combined.length > limit;
  const matches = combined.slice(0, limit);

  if (matches.length === 0) {
    return {
      found: false,
      result: 'No match found in the Pennsylvania DHS Medicheck Precluded Providers List for that provider.',
      screened: { name: nameRaw || null, npi: npiRaw || null, license: licenseRaw || null, fein: feinRaw || null },
      caveat: `This checks the Pennsylvania DHS Medicheck list only. It does not cover the federal HHS OIG LEIE, the federal SAM exclusions list, or any other state's Medicaid exclusion list (see ny-omig-exclusions, ca-medical-exclusions, tx-medical-exclusions, fl-medical-exclusions). ${EVER_VS_CURRENT_CAVEAT}`,
      source: SOURCE_LABEL,
      source_url: SOURCE_URL,
      data_as_of: DATA_AS_OF,
    };
  }

  return {
    found: true,
    screened: { name: nameRaw || null, npi: npiRaw || null, license: licenseRaw || null, fein: feinRaw || null },
    count: matches.length,
    truncated,
    matches,
    not_an_identification: NOT_AN_ANSWER,
    status_caveat: STATUS_CAVEAT,
    ever_vs_current_caveat: EVER_VS_CURRENT_CAVEAT,
    source: SOURCE_LABEL,
    source_url: SOURCE_URL,
    data_as_of: DATA_AS_OF,
  };
}

async function coverage(args: Record<string, unknown>) {
  const withNpi = ROWS.filter((r) => r.npi).length;
  const withLicense = ROWS.filter((r) => r.license_number).length;
  const withFein = ROWS.filter((r) => r.fein).length;
  const currentlyPrecludedCount = ROWS.filter((r) => currentlyPrecluded(r.status) === true).length;
  const endedCount = ROWS.filter((r) => currentlyPrecluded(r.status) === false).length;
  const statusUnknownCount = ROWS.filter((r) => currentlyPrecluded(r.status) === null).length;
  const dates = ROWS.map((r) => r.begin_date).filter((d): d is string => Boolean(d)).sort();
  const statuses = new Set(ROWS.map((r) => r.status).filter(Boolean));

  // fleet #3170: count-by-date-range mode, same as the four precedent state
  // packs. Counted field is begin_date (DHS's BeginDate) — NOT list_date
  // (ListDate, when the row was added to the published list): a prior
  // benchmark probe against the sibling packs found "added to the file" and
  // "preclusion took effect" are different events that give different
  // numbers for the same year.
  const range = parseYearOrDateRange(args);
  if (isDateRangeError(range)) {
    return {
      found: false,
      reason: 'invalid_date_range',
      hint: range.error,
      source: SOURCE_LABEL,
      source_url: SOURCE_URL,
      data_as_of: DATA_AS_OF,
    };
  }
  if (range) {
    const count = ROWS.filter((r) => inRange(r.begin_date, range)).length;
    return {
      found: true,
      mode: 'date_range_count',
      count,
      date_field_counted: 'begin_date — DHS\'s BeginDate (preclusion effective date). NOT list_date (ListDate, when the row was added to the published list), which gives a different, wrong number for the same range.',
      range: { start: range.start, end: range.end, label: range.label },
      counted_over: 'the whole list (6,700+ rows), not a page',
      total_rows_all_time: TOTAL_ROWS,
      oldest_begin_date: dates[0] ?? null,
      newest_begin_date: dates[dates.length - 1] ?? null,
      data_as_of: DATA_AS_OF,
      index_captured_at: CAPTURED_AT,
      ever_vs_current_caveat: EVER_VS_CURRENT_CAVEAT,
      source: SOURCE_LABEL,
      source_url: SOURCE_URL,
    };
  }

  return {
    found: true,
    total_rows: TOTAL_ROWS,
    currently_precluded: currentlyPrecludedCount,
    ended: endedCount,
    status_unknown: statusUnknownCount,
    with_npi: withNpi,
    with_license_number: withLicense,
    with_fein: withFein,
    distinct_statuses: [...statuses].sort(),
    oldest_begin_date: dates[0] ?? null,
    newest_begin_date: dates[dates.length - 1] ?? null,
    data_as_of: DATA_AS_OF,
    index_captured_at: CAPTURED_AT,
    status_caveat: STATUS_CAVEAT,
    ever_vs_current_caveat: EVER_VS_CURRENT_CAVEAT,
    search_url: SEARCH_URL,
    source: SOURCE_LABEL,
    source_url: SOURCE_URL,
  };
}

const tools: McpToolExport['tools'] = [
  {
    name: 'pa_medical_check_exclusion',
    description:
      'Is this healthcare provider precluded from the Pennsylvania Medical Assistance (Medicaid) program? Screens a person or business name, an NPI, a license number, and/or a federal EIN against the Pennsylvania Department of Human Services (DHS) Medicheck Precluded Providers List — the state-level counterpart to the federal HHS OIG LEIE (see the leie pack) for Pennsylvania specifically, and the sibling of ny_omig_check_exclusion (New York), ca_medical_check_exclusion (California), tx_medical_check_exclusion (Texas) and fl_medical_check_exclusion (Florida). Answers "is this provider precluded from Pennsylvania Medicaid", "check this NPI against the PA Medicheck list", or pre-payment/credentialing screening for a Pennsylvania Medicaid provider. '
      + 'An NPI, license-number, or FEIN match is an IDENTIFICATION (all three are exact, provider- or business-specific identifiers); a name match — even an exact one — is a CANDIDATE lead only, since this list carries no date of birth to tell same-named providers apart. Every match carries DHS\'s own Status field (Precluded, Terminated, Reinstated, Suspended, Withdrawal, and similar) and a currently_precluded flag DERIVED from that status — null with status_unknown:true on the minority of rows where DHS\'s own Status is blank, rather than a guess. This dataset covers everyone EVER precluded, not only those currently precluded. Pass npi, license, or fein to turn a name lead into an identification. Sourced from the Pennsylvania DHS Medicheck Precluded Providers List, keyless.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Provider or business name to screen, e.g. "John Smith" or "Acme Home Health Inc". Matched against the provider\'s individual name, business name, and any recorded alias, any word order.' },
        npi: { type: 'string', description: 'The provider\'s 10-digit NPI, if known. An NPI match is an identification rather than a name lead — always pass it when known.' },
        license: { type: 'string', description: 'Pennsylvania professional license number, if known, e.g. "AJ006399L". A license match is an identification.' },
        fein: { type: 'string', description: 'Federal Employer Identification Number (EIN) of the business, if known. An EIN match is an identification.' },
        limit: { type: 'number', description: 'Maximum matches to return (default 10, max 50).' },
      },
    },
  },
  {
    name: 'pa_medical_exclusion_coverage',
    description:
      'What the Pennsylvania DHS Medicheck Precluded Providers data covers and how current it is: total rows ever recorded, how many are currently precluded vs. ended vs. status-unknown, how many carry an NPI, license number, or FEIN, the distinct status values DHS uses, and the oldest/newest preclusion effective dates. Use to check the screening data is fresh enough to rely on before a compliance decision, and to see the one-line notes on the status field\'s gaps and the ever-vs-currently-precluded distinction. '
      + 'Pass year (e.g. 2025) or start_date/end_date to instead COUNT how many preclusions have an effective date in that year or range, counted over the whole 6,700+ row list, not a page — answers "how many PA Medicheck preclusions took effect in 2025". The response names the date field counted (begin_date / DHS\'s BeginDate — never list_date, which answers a different question and gives a different number). Sourced from the Pennsylvania DHS Medicheck Precluded Providers List, keyless.',
    inputSchema: { type: 'object' as const, properties: { ...DATE_RANGE_ARG_SCHEMA } },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  ensureIndex(args);
  switch (name) {
    case 'pa_medical_check_exclusion':
      return checkExclusion(args);
    case 'pa_medical_exclusion_coverage':
      return coverage(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export { tools, callTool };
export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
