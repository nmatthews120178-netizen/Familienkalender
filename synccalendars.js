// Pulls each family member's published Outlook/iCloud calendar (ICS link) and
// writes ONLY free/busy time blocks into the family calendar's Firebase
// database — never event titles, locations or descriptions. Runs on a
// schedule via GitHub Actions (see .github/workflows/sync-calendars.yml).

const ical = require('node-ical');

const FIREBASE_DB_URL = (process.env.FIREBASE_DB_URL || '').replace(/\/$/, '');
if (!FIREBASE_DB_URL) {
  console.error('FIREBASE_DB_URL is not set.');
  process.exit(1);
}

const WINDOW_PAST_DAYS = 3;
const WINDOW_FUTURE_DAYS = 120;
const MAX_BLOCKS_PER_PERSON = 400;
const FETCH_TIMEOUT_MS = 20000;

function safeKey(raw) {
  return String(raw).replace(/[.#$\[\]/]/g, '_').slice(0, 120);
}

function normalizeCalendarUrl(url) {
  // iCloud hands out "webcal://" links; that scheme means "https, treat as calendar
  // data" but plain fetch() doesn't know it, so treat it as https transparently.
  if (/^webcal:\/\//i.test(url)) return 'https://' + url.slice('webcal://'.length);
  return url;
}

async function fetchWithTimeout(rawUrl, ms) {
  const url = normalizeCalendarUrl(rawUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'familienkalender-sync/1.0' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function extractBusyBlocks(icsText, from, to) {
  const parsed = ical.sync.parseICS(icsText);
  const blocks = [];
  for (const key in parsed) {
    const ev = parsed[key];
    if (!ev || ev.type !== 'VEVENT') continue;
    let instances;
    try {
      instances = ical.expandRecurringEvent(ev, { from, to });
    } catch (e) {
      continue; // skip events node-ical can't expand rather than failing the whole feed
    }
    for (const inst of instances) {
      if (!inst.start || !inst.end) continue;
      const allDay = Boolean(inst.start.dateOnly);
      blocks.push({
        start: new Date(inst.start).toISOString(),
        end: new Date(inst.end).toISOString(),
        allDay: allDay,
        uid: String(ev.uid || key)
      });
      if (blocks.length >= MAX_BLOCKS_PER_PERSON) return blocks;
    }
  }
  return blocks;
}

async function firebaseGet(path) {
  const res = await fetch(FIREBASE_DB_URL + path + '.json');
  if (!res.ok) throw new Error('Firebase GET ' + path + ' failed: HTTP ' + res.status);
  const text = await res.text();
  return text === 'null' ? null : JSON.parse(text);
}

async function firebasePut(path, value) {
  const res = await fetch(FIREBASE_DB_URL + path + '.json', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value)
  });
  if (!res.ok) throw new Error('Firebase PUT ' + path + ' failed: HTTP ' + res.status);
}

(async () => {
  const now = new Date();
  const from = new Date(now.getTime() - WINDOW_PAST_DAYS * 86400000);
  const to = new Date(now.getTime() + WINDOW_FUTURE_DAYS * 86400000);

  const people = (await firebaseGet('/people')) || {};
  const existingBusy = (await firebaseGet('/busyBlocks')) || {};

  const targetPersonIds = new Set();
  let okCount = 0, errCount = 0;

  for (const personId of Object.keys(people)) {
    const person = people[personId] || {};
    const url = (person.icsUrl || '').trim();
    if (!url) continue;
    targetPersonIds.add(personId);

    try {
      const icsText = await fetchWithTimeout(url, FETCH_TIMEOUT_MS);
      const blocks = extractBusyBlocks(icsText, from, to);
      const blocksById = {};
      blocks.forEach((b) => {
        const id = safeKey(b.uid + '_' + new Date(b.start).getTime());
        blocksById[id] = { start: b.start, end: b.end, allDay: b.allDay };
      });
      await firebasePut('/busyBlocks/' + personId, Object.keys(blocksById).length ? blocksById : null);
      console.log('OK  ' + (person.name || personId) + ': ' + blocks.length + ' Termine synchronisiert');
      okCount++;
    } catch (err) {
      console.error('FEHLER bei ' + (person.name || personId) + ': ' + err.message);
      errCount++;
    }
  }

  // Clear busyBlocks for anyone who no longer has a link configured (removed link or removed person)
  for (const personId of Object.keys(existingBusy)) {
    if (!targetPersonIds.has(personId)) {
      await firebasePut('/busyBlocks/' + personId, null);
      console.log('Bereinigt: ' + personId + ' (kein Kalender-Link mehr hinterlegt)');
    }
  }

  console.log('Fertig. ' + okCount + ' Person(en) synchronisiert, ' + errCount + ' Fehler.');
  if (errCount > 0 && okCount === 0) process.exitCode = 1;
})().catch((err) => {
  console.error('Unerwarteter Fehler:', err);
  process.exit(1);
});
