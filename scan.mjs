#!/usr/bin/env node
/**
 * scan.mjs — Zero-token portal scanner
 *
 * Two scan modes (both zero Claude tokens):
 *   1. Company boards  — Greenhouse, Ashby, Lever APIs per tracked_companies
 *   2. Search APIs     — Adzuna + CareerJet keyword search (search_apis in portals.yml)
 *
 * Applies title + location filters, deduplicates, writes to:
 *   pipeline.md, scan-history.tsv, output/job-link.md
 * Shows Windows toast notification when new offers are found.
 *
 * Usage:
 *   node scan.mjs                  # full scan
 *   node scan.mjs --dry-run        # preview without writing files
 *   node scan.mjs --company Cohere # scan a single company board
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import yaml from 'js-yaml';
const parseYaml = yaml.load;

// ── Config ──────────────────────────────────────────────────────────

const PORTALS_PATH      = 'portals.yml';
const SCAN_HISTORY_PATH = 'data/scan-history.tsv';
const PIPELINE_PATH     = 'data/pipeline.md';
const APPLICATIONS_PATH = 'data/applications.md';
const JOB_LINK_PATH     = 'output/job-link.md';

mkdirSync('data',   { recursive: true });
mkdirSync('output', { recursive: true });

const CONCURRENCY      = 10;
const FETCH_TIMEOUT_MS = 10_000;

// ── API detection (company boards) ─────────────────────────────────

function detectApi(company) {
  if (company.api) {
    if (company.api.includes('greenhouse')) return { type: 'greenhouse', url: company.api };
    if (company.api.includes('ashbyhq'))   return { type: 'ashby',      url: company.api };
    if (company.api.includes('lever'))     return { type: 'lever',      url: company.api };
  }

  const url = company.careers_url || '';

  const ashbyMatch = url.match(/jobs\.ashbyhq\.com\/([^/?#]+)/);
  if (ashbyMatch) {
    return { type: 'ashby', url: `https://api.ashbyhq.com/posting-api/job-board/${ashbyMatch[1]}?includeCompensation=true` };
  }

  const leverMatch = url.match(/jobs\.lever\.co\/([^/?#]+)/);
  if (leverMatch) {
    return { type: 'lever', url: `https://api.lever.co/v0/postings/${leverMatch[1]}` };
  }

  const ghMatch = url.match(/job-boards(?:\.eu)?\.greenhouse\.io\/([^/?#]+)/);
  if (ghMatch) {
    return { type: 'greenhouse', url: `https://boards-api.greenhouse.io/v1/boards/${ghMatch[1]}/jobs` };
  }

  const workableMatch = url.match(/apply\.workable\.com\/([^/?#]+)/);
  if (workableMatch) {
    return { type: 'workable', url: `https://apply.workable.com/api/v3/accounts/${workableMatch[1]}/jobs` };
  }

  return null;
}

// ── Company board parsers ───────────────────────────────────────────

function parseGreenhouse(json, companyName) {
  return (json.jobs || []).map(j => ({
    title: j.title || '', url: j.absolute_url || '',
    company: companyName,  location: j.location?.name || '',
  }));
}

function parseAshby(json, companyName) {
  return (json.jobs || []).map(j => ({
    title: j.title || '', url: j.jobUrl || '',
    company: companyName,  location: j.location || '',
  }));
}

function parseLever(json, companyName) {
  if (!Array.isArray(json)) return [];
  return json.map(j => ({
    title: j.text || '', url: j.hostedUrl || '',
    company: companyName,  location: j.categories?.location || '',
  }));
}

function parseWorkable(json, companyName) {
  return (json.results || []).map(j => ({
    title: j.title || '', url: `https://apply.workable.com/${j.shortcode}/j/${j.id}/` ,
    company: companyName,  location: j.location?.city || j.location?.country || '',
  }));
}

const BOARD_PARSERS = { greenhouse: parseGreenhouse, ashby: parseAshby, lever: parseLever, workable: parseWorkable };

// ── Search API parsers ──────────────────────────────────────────────

function parseAdzuna(json, queryName) {
  return (json.results || []).map(j => ({
    title:    j.title || '',
    url:      j.redirect_url || '',
    company:  j.company?.display_name || 'Unknown',
    location: j.location?.display_name || '',
    source:   queryName,
  }));
}

function parseCareerjet(json, queryName) {
  if (json.type === 'ERROR') return [];
  return (json.jobs || []).map(j => ({
    title:    j.title || '',
    url:      j.url || '',
    company:  j.company || 'Unknown',
    location: j.locations || '',
    source:   queryName,
  }));
}

// ── Fetch with timeout ──────────────────────────────────────────────

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, ...options });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ── Title filter ────────────────────────────────────────────────────

function buildTitleFilter(titleFilter) {
  const positive = (titleFilter?.positive || []).map(k => k.toLowerCase());
  const negative = (titleFilter?.negative || []).map(k => k.toLowerCase());

  // Short acronyms (≤4 chars) use word boundaries to avoid false matches
  // e.g. "SET" should not match "asset", "QA" should not match inside other words
  function matches(text, keyword) {
    if (keyword.length <= 4) {
      const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`\\b${escaped}\\b`, 'i').test(text);
    }
    return text.includes(keyword);
  }

  return title => {
    const lower = title.toLowerCase();
    const hasPositive = positive.length === 0 || positive.some(k => matches(lower, k));
    const hasNegative = negative.some(k => lower.includes(k));
    return hasPositive && !hasNegative;
  };
}

// ── Location filter ─────────────────────────────────────────────────

function buildLocationFilter(locationFilter) {
  const positive = (locationFilter?.positive || []).map(k => k.toLowerCase());
  const negative = (locationFilter?.negative || []).map(k => k.toLowerCase());
  return location => {
    if (!location || location.trim() === '') return true;
    const lower = location.toLowerCase();
    if (negative.some(k => lower.includes(k))) return false;
    if (positive.length === 0) return true;
    return positive.some(k => lower.includes(k));
  };
}

function classifyLocation(location) {
  if (!location || location.trim() === '') return 'remote';
  const lower = location.toLowerCase();
  if (['remote', 'anywhere', 'worldwide', 'distributed'].some(k => lower.includes(k))) return 'remote';
  return 'location';
}

// ── URL normalization ────────────────────────────────────────────────

// Adzuna returns different tracking params (se=, v=) for the same job across queries.
// Strip query string so dedup treats them as the same URL.
function normalizeUrl(url) {
  if (url && url.includes('adzuna.com/land/ad/')) return url.split('?')[0];
  return url;
}

// ── Dedup ───────────────────────────────────────────────────────────

function loadSeenUrls() {
  const seen = new Set();
  if (existsSync(SCAN_HISTORY_PATH)) {
    for (const line of readFileSync(SCAN_HISTORY_PATH, 'utf-8').split('\n').slice(1)) {
      const url = line.split('\t')[0];
      if (url) seen.add(normalizeUrl(url));
    }
  }
  if (existsSync(PIPELINE_PATH)) {
    const text = readFileSync(PIPELINE_PATH, 'utf-8');
    for (const match of text.matchAll(/https?:\/\/[^\s|)]+/g)) seen.add(normalizeUrl(match[0].replace(/\s.*$/, '')));
  }
  if (existsSync(APPLICATIONS_PATH)) {
    const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
    for (const match of text.matchAll(/https?:\/\/[^\s|)]+/g)) seen.add(normalizeUrl(match[0]));
  }
  return seen;
}

function loadSeenCompanyRoles() {
  const seen = new Set();
  if (existsSync(APPLICATIONS_PATH)) {
    const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
    for (const match of text.matchAll(/\|[^|]+\|[^|]+\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|/g)) {
      const company = match[1].trim().toLowerCase();
      const role    = match[2].trim().toLowerCase();
      if (company && role && company !== 'company') seen.add(`${company}::${role}`);
    }
  }
  // Also load pending pipeline entries — prevents re-adding same company+role
  // even if Adzuna rotates ad IDs for the same posting
  if (existsSync(PIPELINE_PATH)) {
    const text = readFileSync(PIPELINE_PATH, 'utf-8');
    for (const match of text.matchAll(/^- \[.?\] [^\|]+\|\s*([^|]+)\s*\|\s*(.+)/gm)) {
      const company = match[1].trim().toLowerCase();
      const role    = match[2].trim().toLowerCase();
      if (company && role) seen.add(`${company}::${role}`);
    }
  }
  return seen;
}

// ── Writers ─────────────────────────────────────────────────────────

function appendToPipeline(offers) {
  if (offers.length === 0) return;
  let text = readFileSync(PIPELINE_PATH, 'utf-8');
  const marker = '## Pendientes';
  const idx = text.indexOf(marker);
  if (idx === -1) {
    const procIdx  = text.indexOf('## Procesadas');
    const insertAt = procIdx === -1 ? text.length : procIdx;
    text = text.slice(0, insertAt) + `\n${marker}\n\n` + offers.map(o => `- [ ] ${o.url} | ${o.company} | ${o.title}`).join('\n') + '\n\n' + text.slice(insertAt);
  } else {
    const nextSection = text.indexOf('\n## ', idx + marker.length);
    const insertAt    = nextSection === -1 ? text.length : nextSection;
    text = text.slice(0, insertAt) + '\n' + offers.map(o => `- [ ] ${o.url} | ${o.company} | ${o.title}`).join('\n') + '\n' + text.slice(insertAt);
  }
  writeFileSync(PIPELINE_PATH, text, 'utf-8');
}

function appendToScanHistory(offers, date) {
  if (!existsSync(SCAN_HISTORY_PATH)) {
    writeFileSync(SCAN_HISTORY_PATH, 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\n', 'utf-8');
  }
  appendFileSync(SCAN_HISTORY_PATH, offers.map(o => `${o.url}\t${date}\t${o.source}\t${o.title}\t${o.company}\tadded`).join('\n') + '\n', 'utf-8');
}

function appendToJobLink(offers, datetime) {
  const remote   = offers.filter(o => o.locationType === 'remote');
  const location = offers.filter(o => o.locationType === 'location');
  const fmt = o => `- [${o.company} — ${o.title}](${o.url}) _(${o.location || 'Remote'} — pending evaluation)_`;

  const section = [
    `## ${datetime} (scan.mjs — API scan)`, '',
    offers.length === 0 ? '_(no new offers this run)_' : null,
    offers.length === 0 ? '' : null,
    ...(offers.length > 0 ? [
      '### Remote',   ...(remote.length   > 0 ? remote.map(fmt)   : ['_(none)_']), '',
      '### Location', ...(location.length > 0 ? location.map(fmt) : ['_(none)_']), '',
      '### Expired / Closed / Non-US', '_(none)_', '',
    ] : []),
    '---', '',
  ].filter(l => l !== null).join('\n');

  if (!existsSync(JOB_LINK_PATH)) {
    writeFileSync(JOB_LINK_PATH, '# Job Links — Scan Finds\n\n<!-- Auto-updated after each scan. Newest entries at the top. -->\n\n', 'utf-8');
  }
  let text = readFileSync(JOB_LINK_PATH, 'utf-8');
  const commentEnd = text.indexOf('-->\n');
  const insertAt   = commentEnd === -1 ? (text.indexOf('\n\n') + 2) : (commentEnd + 4 + (text[commentEnd + 4] === '\n' ? 1 : 0));
  writeFileSync(JOB_LINK_PATH, text.slice(0, insertAt) + '\n' + section + text.slice(insertAt), 'utf-8');
}

// ── Windows toast ────────────────────────────────────────────────────

function showToast(count, offers) {
  if (process.platform !== 'win32' || count === 0) return;
  try {
    const companies = offers.slice(0, 3).map(o => o.company).join(', ');
    const more      = offers.length > 3 ? ` +${offers.length - 3} more` : '';
    const title     = `career-ops: ${count} new offer${count !== 1 ? 's' : ''} found`;
    const body      = `${companies}${more}`;
    const ps = [
      `[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime]`,
      `[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType=WindowsRuntime]`,
      `$x = New-Object Windows.Data.Xml.Dom.XmlDocument`,
      `$x.LoadXml('<toast><visual><binding template="ToastGeneric"><text>${title}</text><text>${body}</text></binding></visual></toast>')`,
      `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('career-ops').Show([Windows.UI.Notifications.ToastNotification]::new($x))`,
    ].join('; ');
    execSync(`powershell -NonInteractive -Command "${ps}"`, { stdio: 'ignore', timeout: 5000 });
  } catch { /* best-effort */ }
}

// ── Parallel fetch ───────────────────────────────────────────────────

async function parallelFetch(tasks, limit) {
  let i = 0;
  async function next() { while (i < tasks.length) await tasks[i++](); }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, () => next()));
}

// ── Search API runner ────────────────────────────────────────────────

async function runSearchApis(searchApis, titleFilter, locationFilter, seenUrls, seenCompanyRoles, newOffers, errors) {
  const enabled = (searchApis || []).filter(s => s.enabled !== false);
  if (enabled.length === 0) return { found: 0, filtered: 0, filteredLoc: 0, dupes: 0 };

  let found = 0, filtered = 0, filteredLoc = 0, dupes = 0;

  for (const api of enabled) {
    try {
      let json, jobs;

      if (api.type === 'adzuna') {
        if (!api.app_id || !api.app_key) {
          errors.push({ company: api.name, error: 'Missing app_id or app_key — register at developer.adzuna.com' });
          continue;
        }
        const location = encodeURIComponent(api.location || 'United States');
        let url;
        if (api.keywords_or) {
          const kw = encodeURIComponent(api.keywords_or);
          url = `https://api.adzuna.com/v1/api/jobs/us/search/1?app_id=${api.app_id}&app_key=${api.app_key}&results_per_page=${api.results_per_page || 50}&what_or=${kw}&where=${location}&sort_by=date&content-type=application/json`;
        } else {
          const kw = encodeURIComponent(api.keywords || 'SDET QA Automation');
          url = `https://api.adzuna.com/v1/api/jobs/us/search/1?app_id=${api.app_id}&app_key=${api.app_key}&results_per_page=${api.results_per_page || 50}&what=${kw}&where=${location}&sort_by=date&content-type=application/json`;
        }
        json = await fetchJson(url);
        jobs = parseAdzuna(json, api.name);

      } else if (api.type === 'careerjet') {
        if (!api.affid) {
          errors.push({ company: api.name, error: 'Missing affid — register at careerjet.com/partners' });
          continue;
        }
        const keywords = encodeURIComponent(api.keywords || 'SDET QA Automation');
        const location = encodeURIComponent(api.location || 'United States');
        const url = `http://public.api.careerjet.net/search?keywords=${keywords}&location=${location}&pagesize=${api.pagesize || 50}&page=1&affid=${api.affid}&sort=date&locale_code=en_US`;
        json = await fetchJson(url);
        jobs = parseCareerjet(json, api.name);

      } else {
        errors.push({ company: api.name, error: `Unknown search API type: ${api.type}` });
        continue;
      }

      found += jobs.length;

      for (const job of jobs) {
        const normUrl = normalizeUrl(job.url);
        if (!titleFilter(job.title))          { filtered++;    continue; }
        if (!locationFilter(job.location))    { filteredLoc++; continue; }
        if (seenUrls.has(normUrl))            { dupes++;       continue; }
        const key = `${job.company.toLowerCase()}::${job.title.toLowerCase()}`;
        if (seenCompanyRoles.has(key))        { dupes++;       continue; }
        seenUrls.add(normUrl);
        seenCompanyRoles.add(key);
        newOffers.push({ ...job, url: normUrl, locationType: classifyLocation(job.location) });
      }

    } catch (err) {
      errors.push({ company: api.name, error: err.message });
    }
  }

  return { found, filtered, filteredLoc, dupes };
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const args          = process.argv.slice(2);
  const dryRun        = args.includes('--dry-run');
  const companyFlag   = args.indexOf('--company');
  const filterCompany = companyFlag !== -1 ? args[companyFlag + 1]?.toLowerCase() : null;

  // Pull latest from GitHub first so remote scan results appear in job-link.md immediately
  if (!dryRun) {
    try { execSync('git pull --rebase origin main', { stdio: 'ignore' }); } catch { /* offline or no remote */ }
  }

  if (!existsSync(PORTALS_PATH)) {
    console.error('Error: portals.yml not found. Run onboarding first.');
    process.exit(1);
  }

  const config         = parseYaml(readFileSync(PORTALS_PATH, 'utf-8'));
  const companies      = config.tracked_companies || [];
  const titleFilter    = buildTitleFilter(config.title_filter);
  const locationFilter = buildLocationFilter(config.location_filter);

  const targets = companies
    .filter(c => c.enabled !== false)
    .filter(c => !filterCompany || c.name.toLowerCase().includes(filterCompany))
    .map(c => ({ ...c, _api: detectApi(c) }))
    .filter(c => c._api !== null);

  const skippedCount = companies.filter(c => c.enabled !== false).length - targets.length;

  const searchApis       = (config.search_apis || []).filter(s => s.enabled !== false);
  const searchApisTotal  = (config.search_apis || []).length;
  const searchApisSkipped = searchApisTotal - searchApis.length;

  console.log(`Scanning ${targets.length} company boards (${skippedCount} skipped — no API detected)`);
  if (searchApis.length > 0)     console.log(`Running ${searchApis.length} search API queries (${searchApisSkipped} disabled)`);
  else if (searchApisTotal > 0)  console.log(`Search APIs: ${searchApisSkipped} configured but disabled (add credentials to enable)`);
  if (dryRun) console.log('(dry run — no files will be written)\n');

  const seenUrls         = loadSeenUrls();
  const seenCompanyRoles = loadSeenCompanyRoles();

  const now      = new Date();
  const date     = now.toISOString().slice(0, 10);
  const time     = now.toTimeString().slice(0, 5);
  const datetime = `${date} ${time}`;

  let totalFound = 0, totalFiltered = 0, totalFilteredLoc = 0, totalDupes = 0;
  const newOffers = [];
  const errors    = [];

  // ── Company board scan ──────────────────────────────────────────
  const boardTasks = targets.map(company => async () => {
    const { type, url } = company._api;
    try {
      const fetchOpts = type === 'workable'
        ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: '', location: [], department: [], worktype: [], remote: [] }) }
        : {};
      const json = await fetchJson(url, fetchOpts);
      const jobs = BOARD_PARSERS[type](json, company.name);
      totalFound += jobs.length;
      for (const job of jobs) {
        const normUrl = normalizeUrl(job.url);
        if (!titleFilter(job.title))          { totalFiltered++;    continue; }
        if (!locationFilter(job.location))    { totalFilteredLoc++; continue; }
        if (seenUrls.has(normUrl))            { totalDupes++;       continue; }
        const key = `${job.company.toLowerCase()}::${job.title.toLowerCase()}`;
        if (seenCompanyRoles.has(key))        { totalDupes++;       continue; }
        seenUrls.add(normUrl);
        seenCompanyRoles.add(key);
        newOffers.push({ ...job, url: normUrl, source: `${type}-api`, locationType: classifyLocation(job.location) });
      }
    } catch (err) {
      errors.push({ company: company.name, error: err.message });
    }
  });

  await parallelFetch(boardTasks, CONCURRENCY);

  // ── Search API scan ─────────────────────────────────────────────
  const searchStats = await runSearchApis(
    config.search_apis, titleFilter, locationFilter, seenUrls, seenCompanyRoles, newOffers, errors
  );
  totalFound       += searchStats.found;
  totalFiltered    += searchStats.filtered;
  totalFilteredLoc += searchStats.filteredLoc;
  totalDupes       += searchStats.dupes;

  // ── Write results ───────────────────────────────────────────────
  if (!dryRun) {
    if (newOffers.length > 0) {
      appendToPipeline(newOffers);
      appendToScanHistory(newOffers, date);
      showToast(newOffers.length, newOffers);
    }
    appendToJobLink(newOffers, datetime);
  }

  // ── Summary ──────────────────────────────────────────────────────
  console.log(`\n${'━'.repeat(45)}`);
  console.log(`Portal Scan — ${datetime}`);
  console.log(`${'━'.repeat(45)}`);
  console.log(`Companies scanned:     ${targets.length}`);
  if (searchApis.length > 0) console.log(`Search API queries:    ${searchApis.length}`);
  console.log(`Total jobs found:      ${totalFound}`);
  console.log(`Filtered by title:     ${totalFiltered} removed`);
  console.log(`Filtered by location:  ${totalFilteredLoc} removed`);
  console.log(`Duplicates:            ${totalDupes} skipped`);
  console.log(`New offers added:      ${newOffers.length}`);

  if (errors.length > 0) {
    console.log(`\nErrors (${errors.length}):`);
    for (const e of errors) console.log(`  ✗ ${e.company}: ${e.error}`);
  }

  if (newOffers.length > 0) {
    console.log('\nNew offers:');
    for (const o of newOffers) {
      const tag = o.locationType === 'remote' ? '🌐' : '📍';
      console.log(`  ${tag} ${o.company} | ${o.title} | ${o.location || 'Remote'}`);
    }
    if (!dryRun) console.log(`\nResults saved to ${PIPELINE_PATH}, ${SCAN_HISTORY_PATH}, and ${JOB_LINK_PATH}`);
  }

  console.log(`\n→ Run /career-ops pipeline to evaluate new offers.`);
  console.log('→ Share results and get help: https://discord.gg/8pRpHETxa4');

  // Auto-push job-link.md to GitHub so it's viewable on mobile
  if (!dryRun) {
    try {
      execSync('git add output/job-link.md data/scan-history.tsv data/pipeline.md', { stdio: 'ignore' });
      execSync(`git commit -m "scan: update job-link.md ${datetime}"`, { stdio: 'ignore' });
      execSync('git push', { stdio: 'ignore' });
      console.log('→ job-link.md pushed to GitHub.');
    } catch { /* no changes or no remote — silently skip */ }
  }
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
