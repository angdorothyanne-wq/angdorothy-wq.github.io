// Tools Ta-Done! calls: Google Calendar, Drive, Docs, Sheets, Tasks, and weather (Open-Meteo).
import { g, kvGet, kvSet } from './_lib.js';

const CAL = 'https://www.googleapis.com/calendar/v3';
const DRIVE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const TASKS = 'https://tasks.googleapis.com/tasks/v1';
const bad = (code, message) => Object.assign(new Error(message), { code });
const wfetch = async u => { try { return await fetch(u); } catch (e) { throw bad('server_unavailable', 'Weather is unreachable'); } };

export async function runTool(env, server, tool, input) {
  const key = server + '/' + tool;
  switch (key) {
    // ----- Weather (free, no key) -----
    case 'AccuWeather®/widgets-search-claude': return wxSearch(input);
    case 'AccuWeather®/widgets-current-claude': return wxCurrent(input);
    // ----- Google Calendar -----
    case 'Google Calendar/list_calendars': return listCalendars(env);
    case 'Google Calendar/list_events': return listEvents(env, input);
    case 'Google Calendar/create_event': return createEvent(env, input);
    case 'Google Calendar/update_event': return updateEvent(env, input);
    // ----- Google Drive -----
    case 'Google Drive/search_files': return searchFiles(env, input);
    case 'Google Drive/create_file': return createFile(env, input);
    // ----- Journal → Google Docs, time log → Google Sheets -----
    case 'Google Docs/sync_journal': return syncJournal(env, input);
    case 'Google Sheets/sync_timelog': return syncTimelog(env, input);
    case 'Google Drive/links': return (await kvGet(env, 'links')) || {};
    // ----- Tasks ↔ Google Tasks -----
    case 'Google Tasks/sync': return syncTasks(env, input);
  }
  throw bad('not_in_manifest', 'Unknown tool ' + key);
}

// ================= Weather =================
async function wxSearch(input) {
  const q = String((input.queryParams && input.queryParams.query) || '').trim();
  if (!q) return { results: [] };
  const r = await wfetch('https://geocoding-api.open-meteo.com/v1/search?count=8&language=en&format=json&name=' + encodeURIComponent(q));
  if (!r.ok) throw bad('server_unavailable', 'Weather search is down');
  const d = await r.json();
  return { results: (d.results || []).map(p => ({ locationKey: p.latitude.toFixed(3) + ',' + p.longitude.toFixed(3), name: [p.name, p.admin1, p.country].filter(Boolean).filter((x, i, a) => a.indexOf(x) === i).join(', ') })) };
}
// WMO weather codes → [AccuWeather-style day icon, night icon, phrase]
const WMO = {
  0: [1, 33, 'Sunny'], 1: [2, 34, 'Mostly sunny'], 2: [3, 35, 'Partly sunny'], 3: [7, 7, 'Cloudy'],
  45: [11, 11, 'Fog'], 48: [11, 11, 'Fog'], 51: [12, 12, 'Light drizzle'], 53: [12, 12, 'Drizzle'], 55: [12, 12, 'Heavy drizzle'],
  56: [26, 26, 'Freezing drizzle'], 57: [26, 26, 'Freezing drizzle'], 61: [12, 12, 'Light rain'], 63: [18, 18, 'Rain'], 65: [18, 18, 'Heavy rain'],
  66: [26, 26, 'Freezing rain'], 67: [26, 26, 'Freezing rain'], 71: [22, 22, 'Light snow'], 73: [22, 22, 'Snow'], 75: [22, 22, 'Heavy snow'], 77: [22, 22, 'Snow grains'],
  80: [12, 12, 'Showers'], 81: [18, 18, 'Showers'], 82: [18, 18, 'Heavy showers'], 85: [22, 22, 'Snow showers'], 86: [22, 22, 'Snow showers'],
  95: [15, 15, 'Thunderstorms'], 96: [15, 15, 'Thunderstorms'], 99: [15, 15, 'Thunderstorms'],
};
async function wxCurrent(input) {
  const qp = input.queryParams || {}, [lat, lon] = String(qp.locationKey || '').split(',').map(Number);
  if (!isFinite(lat) || !isFinite(lon)) throw bad('tool_error', 'Bad location');
  const imperial = qp.unit === 'imperial', u = imperial ? '°F' : '°C';
  const r = await wfetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,apparent_temperature,weather_code,is_day,wind_speed_10m,relative_humidity_2m&timezone=auto${imperial ? '&temperature_unit=fahrenheit&wind_speed_unit=mph' : ''}`);
  if (!r.ok) throw bad('server_unavailable', 'Weather is down');
  const c = (await r.json()).current || {};
  const w = WMO[c.weather_code] || [1, 33, 'Clear'], day = c.is_day === 1;
  let phrase = w[2]; if (!day && /sunny/i.test(phrase)) phrase = phrase.replace(/Mostly sunny/i, 'Mostly clear').replace(/Partly sunny/i, 'Partly cloudy').replace(/Sunny/i, 'Clear');
  return { currentConditions: { temperature: Math.round(c.temperature_2m) + u, realFeel: Math.round(c.apparent_temperature) + u, phrase, iconCode: day ? w[0] : w[1], isDayTime: day, humidity: c.relative_humidity_2m, wind: c.wind_speed_10m } };
}

// ================= Google Calendar =================
async function listCalendars(env) {
  const d = await g(env, CAL + '/users/me/calendarList?maxResults=100');
  const items = (d.items || []).filter(c => !c.deleted);
  items.sort((a, b) => (b.primary ? 1 : 0) - (a.primary ? 1 : 0));
  return { calendars: items.map(c => ({ id: c.id, summary: c.summaryOverride || c.summary, primary: !!c.primary, accessRole: c.accessRole, backgroundColor: c.backgroundColor })) };
}
async function listEvents(env, i) {
  const p = new URLSearchParams({ singleEvents: 'true', maxResults: String(Math.min(i.pageSize || 250, 250)) });
  if (i.startTime) p.set('timeMin', i.startTime); if (i.endTime) p.set('timeMax', i.endTime);
  if (i.orderBy === 'startTime') p.set('orderBy', 'startTime');
  if (i.fullText) p.set('q', i.fullText);
  const d = await g(env, CAL + '/calendars/' + encodeURIComponent(i.calendarId || 'primary') + '/events?' + p);
  return { events: (d.items || []).map(e => {
    const v = e.conferenceData && (e.conferenceData.entryPoints || []).find(x => x.entryPointType === 'video');
    return Object.assign(e, { conferenceUrl: e.hangoutLink || (v && v.uri) || undefined });
  }) };
}
const dateIn = (iso, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
function eventTimes(i) {
  if (i.allDay) return { start: { date: dateIn(i.startTime, i.timeZone) }, end: { date: dateIn(i.endTime, i.timeZone) } };
  return { start: { dateTime: i.startTime, timeZone: i.timeZone }, end: { dateTime: i.endTime, timeZone: i.timeZone } };
}
async function createEvent(env, i) {
  const body = Object.assign({ summary: i.summary, description: i.description || '' }, eventTimes(i));
  if (i.notificationLevel === 'NONE') body.reminders = { useDefault: false, overrides: [] };
  return g(env, CAL + '/calendars/' + encodeURIComponent(i.calendarId || 'primary') + '/events?sendUpdates=none', { method: 'POST', body });
}
async function updateEvent(env, i) {
  const body = Object.assign({ summary: i.summary }, eventTimes(i));
  return g(env, CAL + '/calendars/' + encodeURIComponent(i.calendarId || 'primary') + '/events/' + encodeURIComponent(i.eventId) + '?sendUpdates=none', { method: 'PATCH', body });
}

// ================= Google Drive =================
const viewOf = f => ({ id: f.id, title: f.name, mimeType: f.mimeType, viewUrl: f.webViewLink });
async function searchFiles(env, i) {
  // Accepts the simple "title = 'X' and mimeType = '...'" form the app uses.
  const q = String(i.query || '').replace(/\btitle\s*=/g, 'name =').replace(/\s*and\s+owner\s*=\s*'me'/g, '') + ' and trashed = false';
  const d = await g(env, DRIVE + '/files?' + new URLSearchParams({ q, pageSize: String(i.pageSize || 10), fields: 'files(id,name,mimeType,webViewLink)' }));
  return { files: (d.files || []).map(viewOf) };
}
function multipart(meta, content, type) {
  const b = 'tadone' + crypto.randomUUID().replace(/-/g, '');
  const body = `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${b}\r\nContent-Type: ${type}; charset=UTF-8\r\n\r\n${content}\r\n--${b}--`;
  return { body, headers: { 'content-type': 'multipart/related; boundary=' + b } };
}
const GTYPES = { 'text/csv': 'application/vnd.google-apps.spreadsheet', 'text/html': 'application/vnd.google-apps.document', 'text/plain': 'application/vnd.google-apps.document' };
async function createFile(env, i) {
  if (i.contentMimeType === 'application/vnd.google-apps.folder') {
    const meta = { name: i.title, mimeType: 'application/vnd.google-apps.folder' }; if (i.parentId) meta.parents = [i.parentId];
    return viewOf(await g(env, DRIVE + '/files?fields=id,name,mimeType,webViewLink', { method: 'POST', body: meta }));
  }
  const type = i.contentMimeType || 'text/plain', meta = { name: i.title };
  if (i.parentId) meta.parents = [i.parentId];
  if (!i.disableConversionToGoogleType && GTYPES[type]) meta.mimeType = GTYPES[type];
  const m = multipart(meta, i.textContent || '', type);
  return viewOf(await g(env, UPLOAD + '/files?uploadType=multipart&fields=id,name,mimeType,webViewLink', { method: 'POST', body: m.body, headers: m.headers }));
}
// Find or make the "Ta-Done!" folder that holds the journal docs and the time-log sheet.
async function appFolder(env, links) {
  if (links.folder && links.folder.id) {
    try { const f = await g(env, DRIVE + '/files/' + links.folder.id + '?fields=id,trashed,webViewLink'); if (!f.trashed) return links.folder.id; } catch (e) { if (e.code !== 'not_found') throw e; }
  }
  const f = await createFile(env, { title: 'Ta-Done!', contentMimeType: 'application/vnd.google-apps.folder' });
  links.folder = { id: f.id, url: f.viewUrl };
  return f.id;
}
// Create a Google Doc/Sheet once, then keep replacing its content.
async function upsertConverted(env, links, slot, title, content, type) {
  const cur = slot.get();
  if (cur && cur.id) {
    try {
      const m = multipart({ name: title }, content, type);
      const f = await g(env, UPLOAD + '/files/' + cur.id + '?uploadType=multipart&fields=id,name,mimeType,webViewLink,trashed', { method: 'PATCH', body: m.body, headers: m.headers });
      if (!f.trashed) { slot.set({ id: f.id, url: f.webViewLink, at: Date.now() }); return; }
    } catch (e) { if (e.code !== 'not_found') throw e; }
  }
  const folder = await appFolder(env, links);
  const f = await createFile(env, { title, textContent: content, contentMimeType: type, parentId: folder });
  slot.set({ id: f.id, url: f.viewUrl, at: Date.now() });
}
async function syncJournal(env, i) {
  if (!/^\d{4}-\d{2}$/.test(i.month || '')) throw bad('tool_error', 'Bad month');
  const links = (await kvGet(env, 'links')) || {}; links.journal = links.journal || {};
  await upsertConverted(env, links, { get: () => links.journal[i.month], set: v => { links.journal[i.month] = v; } }, i.title || 'Ta-Done! Journal ' + i.month, i.html || '<p></p>', 'text/html');
  await kvSet(env, 'links', links);
  return links.journal[i.month];
}
async function syncTimelog(env, i) {
  const links = (await kvGet(env, 'links')) || {};
  await upsertConverted(env, links, { get: () => links.timelog, set: v => { links.timelog = v; } }, i.title || 'Ta-Done! Time log', i.csv || 'Date', 'text/csv');
  await kvSet(env, 'links', links);
  return links.timelog;
}

// ================= Google Tasks (two-way) =================
const sigOf = (title, notes, due, done) => JSON.stringify([String(title || '').trim(), String(notes || '').trim(), due || '', !!done]);
const gFields = t => ({ title: t.title || '', notes: t.notes || '', due: t.due ? String(t.due).slice(0, 10) : null, done: t.status === 'completed' });
const gBody = t => ({ title: t.title, notes: t.notes || '', due: t.due ? t.due + 'T00:00:00.000Z' : null, status: t.done ? 'completed' : 'needsAction' });
async function taskList(env) {
  let id = await kvGet(env, 'gtlist');
  if (id) { try { await g(env, TASKS + '/users/@me/lists/' + encodeURIComponent(id)); return { id, fresh: false }; } catch (e) { if (e.code !== 'not_found') throw e; } }
  const lists = await g(env, TASKS + '/users/@me/lists?maxResults=100');
  const hit = (lists.items || []).find(l => l.title === 'Ta-Done!');
  id = hit ? hit.id : (await g(env, TASKS + '/users/@me/lists', { method: 'POST', body: { title: 'Ta-Done!' } })).id;
  await kvSet(env, 'gtlist', id);
  return { id, fresh: !hit };
}
async function syncTasks(env, input) {
  const tl = await taskList(env), list = tl.id, L = TASKS + '/lists/' + encodeURIComponent(list) + '/tasks';
  let budget = 40; // Cloudflare allows ~50 outgoing calls per request; the app repeats if more is left.
  const all = []; let page = '';
  do { const d = await g(env, L + '?' + new URLSearchParams({ showCompleted: 'true', showHidden: 'true', maxResults: '100', ...(page ? { pageToken: page } : {}) })); budget--; all.push(...(d.items || [])); page = d.nextPageToken || ''; } while (page && budget > 30);
  const byId = new Map(all.filter(t => !t.deleted).map(t => [t.id, t]));
  const out = { links: {}, updates: {}, removed: [], created: [], more: false, listId: list };
  // Deleted in Ta-Done → delete in Google.
  for (const gid of input.deleted || []) { if (budget <= 0) { out.more = true; break; } if (byId.has(gid)) { try { await g(env, L + '/' + encodeURIComponent(gid), { method: 'DELETE' }); } catch (e) { if (e.code !== 'not_found') throw e; } budget--; byId.delete(gid); } }
  const known = new Set((input.known || []).concat(input.deleted || []));
  const linked = new Set();
  for (const t of input.tasks || []) {
    const cur = sigOf(t.title, t.notes, t.due, t.done);
    if (t.gtaskId && tl.fresh) t.gtaskId = null; // the list was remade, so link everything again
    if (!t.gtaskId) {
      if (budget <= 0) { out.more = true; continue; }
      const made = await g(env, L, { method: 'POST', body: gBody(t) }); budget--;
      out.links[t.id] = { gtaskId: made.id, sig: cur };
      continue;
    }
    const gt = byId.get(t.gtaskId);
    linked.add(t.gtaskId);
    if (!gt) { out.removed.push(t.id); continue; }
    const gf = gFields(gt), gsig = sigOf(gf.title, gf.notes, gf.due, gf.done);
    if (cur !== t.gtSig && cur !== gsig) {
      if (budget <= 0) { out.more = true; continue; }
      await g(env, L + '/' + encodeURIComponent(t.gtaskId), { method: 'PATCH', body: gBody(t) }); budget--;
      out.links[t.id] = { gtaskId: t.gtaskId, sig: cur };
    } else if (gsig !== t.gtSig) {
      out.updates[t.id] = Object.assign(gf, { sig: gsig });
    }
  }
  // New in Google → add to Ta-Done (skip ones Ta-Done already knows about).
  for (const gt of byId.values()) {
    if (linked.has(gt.id) || known.has(gt.id) || gt.parent) continue;
    const gf = gFields(gt);
    if (!gf.title.trim()) continue;
    out.created.push(Object.assign(gf, { gtaskId: gt.id, sig: sigOf(gf.title, gf.notes, gf.due, gf.done) }));
  }
  return out;
}
