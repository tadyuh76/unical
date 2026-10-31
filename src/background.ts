// Background worker. Keeps the student's "UEH · Lịch học / Lịch thi / Deadline" calendars in Google
// Calendar matching UEH. While the browser is open it reads the student portal and the LMS itself (when the
// browser starts, then every hour) with the student's own UEH login, so nobody has to open those pages; a
// visit to either page also updates right away. LMS deadlines also come through the student's private LMS
// calendar link, which keeps working even when UEH has signed them out.
import type {
  Deadline,
  LmsPayload,
  Message,
  Plan,
  PortalPayload,
  ReadResult,
  Site,
  Source,
  SyncReport,
} from "@/types";
import { CALENDARS, TIMEZONE, cleanTitle, eventsFor, toIcs, type GoogleTime } from "@/calendar";
import {
  DEFAULTS,
  SOURCES,
  atLocal,
  load,
  save,
  signInNeeded,
  type CalendarState,
  type State,
} from "@/store";
import { REGISTERING } from "@/ueh";

const API = "https://www.googleapis.com/calendar/v3";
const CLIENT_ID =
  "467741806170-8hej1cop6kuihuhlh4cr1ok66ec05rk9.apps.googleusercontent.com";
// Only the calendars UniCal creates itself; the student's other calendars and events stay out of reach.
const SCOPES = [
  "https://www.googleapis.com/auth/calendar.app.created",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/userinfo.email",
];
// The names of the account's calendars, only to find the ones UniCal made before (before a reinstall, on
// another computer) instead of making a second set. Asked for when connecting; UniCal works without it.
const LIST = "https://www.googleapis.com/auth/calendar.calendarlist.readonly";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
}

// Every state change runs one at a time.
let queue: Promise<unknown> = Promise.resolve();
function task<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

// ---- Google sign-in ----

class AuthError extends Error {}
// Google shows the calendar permission as an unticked box; the student skipped it.
class ScopeError extends AuthError {}

// Google's web sign-in works the same in Chrome, Brave, Edge and Cốc Cốc, and lets the
// student pick any Google account. Later tokens are fetched silently for that account.
async function getToken(interactive: boolean, hint?: string): Promise<string> {
  const { web } = await chrome.storage.session.get("web");
  if (!interactive && web && web.expires > Date.now() + MINUTE) return web.token as string;

  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: chrome.identity.getRedirectURL(),
    response_type: "token",
    // Silent renewals ask for no more than students of every version agreed to; Google adds what else they allowed.
    scope: (interactive ? [...SCOPES, LIST] : SCOPES).join(" "),
    include_granted_scopes: "true",
    prompt: interactive ? "select_account" : "none",
    ...(hint ? { login_hint: hint } : {}),
  }).toString();

  let redirect: string | undefined;
  try {
    redirect = await chrome.identity.launchWebAuthFlow({ url: url.href, interactive });
  } catch {
    // Google's page didn't come back (offline, a Wi-Fi login page in the way): try again next round, the
    // connection is fine. Only Google answering that UniCal may no longer get in means access is gone.
    if (!interactive) throw new Error("offline");
  }
  const params = new URLSearchParams(redirect ? new URL(redirect).hash.slice(1) : "");
  const token = params.get("access_token");
  if (!token) throw new AuthError();
  const scope = params.get("scope") ?? "";
  if (!scope.includes("calendar.app.created")) throw new ScopeError();
  const expires = Date.now() + Number(params.get("expires_in") ?? 3600) * 1000;
  await chrome.storage.session.set({ web: { token, expires, list: scope.includes(LIST) } });
  return token;
}

const dropToken = () => chrome.storage.session.remove("web");

// `once`: a request Google may have carried out even when it answers with an error (making a calendar), so it
// is never sent twice.
type Call = (method: string, path: string, body?: unknown, once?: boolean) => Promise<Response>;

function google(initial: string, hint: string): Call {
  let token = initial;
  return async (method, path, body, once = false) => {
    let renewed = false;
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(API + path, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (res.status === 401) {
        if (renewed) throw new AuthError();
        renewed = true;
        await dropToken();
        token = await getToken(false, hint);
        continue;
      }
      const limited =
        res.status === 429 ||
        res.status >= 500 ||
        (res.status === 403 &&
          /rateLimit/i.test(
            (await res.clone().json().catch(() => null))?.error?.errors?.[0]?.reason ?? ""
          ));
      if (limited && attempt < 5 && !(once && res.status >= 500)) {
        await sleep(700 * 2 ** attempt);
        continue;
      }
      return res;
    }
  };
}

// ---- Google Calendar sync ----

async function digest(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Google event ids allow 0-9 and a-v; a hash of the item keeps them stable.
const eventId = async (source: Source, key: string) =>
  `uc${(await digest(`${source}|${key}`)).slice(0, 40)}`;

const withIds = (source: Source, state: State) =>
  Promise.all(
    eventsFor(source, state).map(async (e) => ({
      ...e,
      id: await eventId(source, e.key),
      h: (await digest(JSON.stringify(e.body))).slice(0, 16),
    }))
  );

// Calendar ids also go to the browser account's synced storage, so connecting Google again, or using UniCal
// on another computer with browser sync on, keeps filling the same calendars even for a student who didn't
// allow UniCal to see their calendar list. Keyed by a hash of the Google account, so no email address goes
// into the browser's sync.
type Remembered = Partial<Record<Source, string>>;
const rememberKey = async (email: string) => `calendars:${(await digest(email.toLowerCase())).slice(0, 16)}`;

async function remembered(email: string): Promise<Remembered> {
  const key = await rememberKey(email);
  const stored = await chrome.storage.sync.get(key).catch(() => ({}));
  return (stored as Record<string, Remembered>)[key] ?? {};
}

async function remember(email: string, before: Remembered, calendars: State["calendars"]) {
  const now: Remembered = {};
  for (const source of SOURCES) if (calendars[source]) now[source] = calendars[source]!.id;
  if (JSON.stringify(now) === JSON.stringify(before)) return;
  await chrome.storage.sync.set({ [await rememberKey(email)]: now }).catch(() => {});
}

// UniCal's own events in a calendar (start times by id), past and upcoming. Anything the student added
// there themselves is left out, so UniCal never touches it. Null when the calendar is gone or isn't one
// UniCal made (Google answers "not found" for those); any other trouble is an error, never "gone".
const OWN_EVENT = /^uc[0-9a-f]{40}$/;
type Owned = { events: Record<string, number>; theirs: boolean }; // theirs: the student added events too
async function ownEvents(call: Call, id: string): Promise<Owned | null> {
  const events: Record<string, number> = {};
  let theirs = false;
  let page = "";
  do {
    const query = new URLSearchParams({
      maxResults: "2500",
      fields: "items(id,start),nextPageToken",
      ...(page ? { pageToken: page } : {}),
    });
    const res = await call("GET", `/calendars/${encodeURIComponent(id)}/events?${query}`);
    if (res.status === 404 || res.status === 410) return null;
    if (!res.ok) throw new Error(`list ${res.status}`);
    const body: { items?: { id: string; start?: GoogleTime }[]; nextPageToken?: string } = await res.json();
    for (const e of body.items ?? []) {
      if (!OWN_EVENT.test(e.id)) theirs = true;
      else events[e.id] = e.start?.dateTime ? Date.parse(e.start.dateTime) : atLocal(`${e.start?.date}T00:00`);
    }
    page = body.nextPageToken ?? "";
  } while (page);
  return { events, theirs };
}

// The ids of the calendars in the student's Google account, by name. Null without the permission to see them.
type Listed = { id: string; summary?: string }[];
async function listCalendars(call: Call): Promise<Listed | null> {
  const { web } = await chrome.storage.session.get("web");
  if (!web?.list) return null;
  const items: Listed = [];
  let page = "";
  do {
    const query = new URLSearchParams({
      minAccessRole: "owner",
      showHidden: "true",
      fields: "items(id,summary),nextPageToken",
      ...(page ? { pageToken: page } : {}),
    });
    const res = await call("GET", `/users/me/calendarList?${query}`);
    if (!res.ok) return null;
    const body: { items?: Listed; nextPageToken?: string } = await res.json();
    items.push(...(body.items ?? []));
    page = body.nextPageToken ?? "";
  } while (page);
  return items;
}

// The calendar to write into. Usually the one from last time. Otherwise, and whenever the account holds more
// than one of this kind (UniCal installed again, another computer, an earlier connection), UniCal keeps one and
// deletes the other copies: first one the student added events of their own to, then the one with the most
// history. A copy the student added events to is never deleted. A calendar counts as a copy only if most of
// what's coming up in it is this student's (or, for the one this browser remembers, when there's nothing
// coming up to compare), so another student's UniCal calendars in the same Google account are never touched.
// Without any, a new calendar is made.
async function ensureCalendar(
  call: Call,
  source: Source,
  state: State,
  upcoming: Set<string>,
  earlier: string | undefined,
  listed: Listed | null
): Promise<CalendarState> {
  const known = state.calendars[source];
  const live = known?.id ? await ownEvents(call, known.id) : null;
  const others = new Set(listed?.filter((c) => c.summary === CALENDARS[source]).map((c) => c.id));
  if (earlier) others.add(earlier);
  if (live) others.delete(known!.id);

  if (others.size) {
    const now = Date.now();
    const copies: (Owned & { id: string })[] = [];
    if (live) copies.push({ id: known!.id, ...live });
    for (const id of others) {
      const found = await ownEvents(call, id).catch(() => null);
      if (!found) continue; // not one UniCal made, already gone, or not readable right now
      const ahead = Object.keys(found.events).filter((e) => found.events[e]! > now);
      const mine = ahead.filter((e) => upcoming.has(e)).length;
      const unknown = ahead.length === 0 || upcoming.size === 0;
      if ((ahead.length > 0 && mine * 2 >= ahead.length) || (id === earlier && unknown)) copies.push({ id, ...found });
    }
    const size = (c: Owned) => Object.keys(c.events).length;
    copies.sort((a, b) => Number(b.theirs) - Number(a.theirs) || size(b) - size(a) || (a.id < b.id ? -1 : 1));
    const keep = copies[0];
    for (const extra of copies.slice(1)) {
      if (!extra.theirs) await call("DELETE", `/calendars/${encodeURIComponent(extra.id)}`);
    }
    if (keep && keep.id === known?.id) return known;
    if (keep) {
      const events: CalendarState["events"] = {};
      for (const [id, s] of Object.entries(keep.events)) if (s > now) events[id] = { h: "", s };
      return { id: keep.id, events };
    }
  }
  if (live) return known!;

  const res = await call(
    "POST",
    "/calendars",
    { summary: CALENDARS[source], description: "Tự động cập nhật bởi UniCal", timeZone: TIMEZONE },
    true
  );
  if (!res.ok) throw new Error(`create ${res.status}`);
  const { id } = await res.json();
  return { id, events: {} };
}

// Writes only what changed since the last sync. Future events that disappeared
// from UEH are removed; past ones stay in the calendar as history.
async function reconcile(
  call: Call,
  source: Source,
  state: State,
  earlier: string | undefined,
  listed: Listed | null
): Promise<number> {
  const wanted = await withIds(source, state);
  const ids = new Set(wanted.map((e) => e.id));
  const upcoming = new Set(wanted.filter((e) => e.start > Date.now()).map((e) => e.id));
  const cal = await ensureCalendar(call, source, state, upcoming, earlier, listed);
  state.calendars[source] = cal;
  const persist = () => save({ calendars: state.calendars });
  await persist(); // a browser closed mid-sync must not lose a calendar it just made
  const base = `/calendars/${encodeURIComponent(cal.id)}/events`;
  let changed = 0;
  let refused = 0; // writes Google turned away for now (usage limits, outages): the sync isn't done

  await pool(
    wanted.filter((e) => cal.events[e.id]?.h !== e.h),
    4,
    async (e) => {
      const body = { ...e.body, id: e.id, status: "confirmed" };
      const known = Boolean(cal.events[e.id]);
      let res = known
        ? await call("PUT", `${base}/${e.id}`, body)
        : await call("POST", base, body);
      if (!known && res.status === 409) res = await call("PUT", `${base}/${e.id}`, body);
      if (known && (res.status === 404 || res.status === 410)) res = await call("POST", base, body);
      if (!res.ok) {
        if (res.status === 403 || res.status === 429 || res.status >= 500) refused++;
        return;
      }
      cal.events[e.id] = { h: e.h, s: e.start };
      if (++changed % 20 === 0) await persist();
    }
  );

  const now = Date.now();
  await pool(
    Object.keys(cal.events).filter((id) => !ids.has(id)),
    4,
    async (id) => {
      if (cal.events[id]!.s > now) {
        const res = await call("DELETE", `${base}/${id}`);
        if (!res.ok && res.status !== 404 && res.status !== 410) {
          refused++;
          return;
        }
        changed++;
      }
      delete cal.events[id];
    }
  );

  await persist();
  if (refused) throw new Error(`${refused} writes refused`);
  return changed;
}

// A calendar the student switched off leaves Google Calendar; switching it back on brings back what's coming up.
async function removeCalendar(call: Call, source: Source, state: State) {
  const cal = state.calendars[source];
  if (!cal) return;
  const res = await call("DELETE", `/calendars/${encodeURIComponent(cal.id)}`);
  if (!res.ok && res.status !== 404 && res.status !== 410) throw new Error(`delete ${res.status}`);
  delete state.calendars[source];
  await save({ calendars: state.calendars });
}

async function runSync(): Promise<SyncReport> {
  const state = await load();
  const changed: Record<Source, number> = { classes: 0, exams: 0, deadlines: 0 };

  if (!state.account) {
    const hasData = SOURCES.some((s) => state.data[s].length > 0);
    const nudge = hasData && Date.now() - state.nudged > DAY;
    if (nudge) await save({ nudged: Date.now() });
    await badge();
    return { changed, connected: false, nudge };
  }

  if (!navigator.onLine) return { changed, connected: true, nudge: false };
  let call: Call;
  try {
    call = google(await getToken(false, state.account.email), state.account.email);
  } catch (err) {
    if (!(err instanceof AuthError)) return { changed, connected: true, nudge: false };
    return lost();
  }

  let problem: State["problem"] = "";
  const earlier = await remembered(state.account.email);
  const listed = await listCalendars(call).catch(() => null);
  // A kind of item this computer hasn't read yet (just installed, UEH not signed in here) is left alone: with
  // nothing to compare, taking over or tidying a calendar could empty what another computer keeps up to date.
  const read = (source: Source) =>
    Boolean(source === "deadlines" ? state.seen.deadlines || state.seen.feed : state.seen[source]);
  for (const source of SOURCES) {
    try {
      if (state.settings[source]) {
        if (read(source)) changed[source] = await reconcile(call, source, state, earlier[source], listed);
      } else await removeCalendar(call, source, state);
    } catch (err) {
      problem = err instanceof AuthError ? "auth" : "google";
      if (problem === "auth") break;
    }
  }
  await remember(state.account.email, earlier, state.calendars);
  if (problem === "auth") return lost();
  await save({ problem, ...(problem ? {} : { synced: Date.now() }) });
  await badge();
  return { changed, connected: true, nudge: false };
}

// Google no longer lets UniCal in (access removed, password changed): ask, at most once a day, to connect again.
async function lost(): Promise<SyncReport> {
  const { nudged } = await load();
  const nudge = Date.now() - nudged > DAY;
  await save({ problem: "auth", ...(nudge ? { nudged: Date.now() } : {}) });
  await badge();
  return { changed: { classes: 0, exams: 0, deadlines: 0 }, connected: false, nudge, lost: true };
}

// ---- What the UEH pages report ----

const KEEP = 30 * DAY; // past items kept locally, for history in the popup and .ics

function prune(data: State["data"]) {
  const cutoff = Date.now() - KEEP;
  data.classes = data.classes.filter((c) => atLocal(c.end) > cutoff);
  data.exams = data.exams.filter((e) => atLocal(`${e.date}T23:59`) > cutoff);
  data.deadlines = data.deadlines.filter((d) => d.due > cutoff);
}

// How old each kind of data may get before it's read again: on a visit to the page, and in the background.
const VISIT = { exams: 10 * MINUTE, classes: 6 * HOUR, deadlines: 10 * MINUTE };
const AWAY = { exams: 3 * HOUR, classes: 6 * HOUR, deadlines: 50 * MINUTE };

// Only what's switched on is read. A site UEH signed the student out of is read again at the first chance,
// so the warning clears right away.
async function plan(ages: Record<Source, number>): Promise<Plan> {
  const { seen, feed, login, settings } = await load();
  const due = (key: Source, out?: boolean) =>
    settings[key] && (Date.now() - (seen[key] ?? 0) > ages[key] || Boolean(out));
  return {
    exams: due("exams", login.portal),
    classes: due("classes", login.portal),
    deadlines: due("deadlines", login.lms),
    feed: settings.deadlines && !feed,
  };
}

// Whose UEH data UniCal keeps. While Google Calendar is connected it stays with the first student read, so
// a friend signing in to UEH in this browser never ends up in this student's calendar. Before that, the
// student signed in now is the one that counts, and what was read for someone else is dropped.
async function owner(site: Site, who: string): Promise<boolean> {
  const state = await load();
  const known = state.who[site];
  if (!who || who === known) return true;
  if (known && state.account) return false;
  if (known) {
    if (site === "portal") Object.assign(state.data, { classes: [], exams: [] });
    else state.data.deadlines = [];
    await save({ data: state.data, ...(site === "lms" ? { feed: "" } : {}) });
  }
  await save({ who: { ...state.who, [site]: who } });
  return true;
}

// The LMS's private calendar link, and nothing else, is ever fetched from what a page reports.
const FEED = /^https:\/\/lms\.ueh\.edu\.vn\/calendar\/export_execute\.php\?/;

// UEH answers a term it has trouble with exactly like a term with nothing in it. So when everything still
// coming up in a term would vanish at once, UniCal keeps it until a read at least 20 minutes later says the
// same; a real change (every course dropped, a next term taken down) still comes through then.
const DOUBT = 20 * MINUTE;

async function mergePortal(p: PortalPayload) {
  if (!(await owner("portal", p.who))) return;
  const { data, subjects, seen, doubt } = await load();
  const now = Date.now();
  // Whether to keep what's stored for this term instead of the empty read.
  const hold = (key: string, before: number, after: number) => {
    if (!before || after) {
      delete doubt[key];
      return false;
    }
    doubt[key] ??= now;
    if (now - doubt[key] < DOUBT) return true;
    delete doubt[key];
    return false;
  };
  if (p.exams) {
    const kept = p.terms.filter((term) =>
      hold(
        `exams|${term}`,
        data.exams.filter((e) => e.term === term && atLocal(`${e.date}T23:59`) > now).length,
        p.exams!.filter((e) => e.term === term).length
      )
    );
    data.exams = data.exams
      .filter((e) => !p.terms.includes(e.term) || kept.includes(e.term))
      .concat(p.exams.filter((e) => !kept.includes(e.term)));
    seen.exams = now;
  }
  if (p.classes) {
    const { from, sessions } = p.classes;
    const replaced = (c: { term: string; start: string }) => {
      const start = from[c.term];
      return start !== undefined && (start === "" || c.start >= start);
    };
    const kept = Object.keys(from).filter((term) =>
      hold(
        `classes|${term}`,
        data.classes.filter((c) => c.term === term && replaced(c) && atLocal(c.start) > now).length,
        sessions.filter((s) => s.term === term).length
      )
    );
    data.classes = data.classes
      .filter((c) => !replaced(c) || kept.includes(c.term))
      .concat(sessions.filter((s) => !kept.includes(s.term)));
    seen.classes = now;
  }
  for (const item of [...data.classes, ...data.exams]) {
    if (item.lhp) subjects[item.lhp] = item.subject;
  }
  prune(data);
  await save({ data, subjects, seen, doubt });
}

const deadlineType = (eventType: string): Deadline["type"] =>
  eventType === "due" || eventType === "expectcompletionon"
    ? "due"
    : eventType === "close"
      ? "close"
      : "other";

async function mergeLms(p: LmsPayload) {
  if (!(await owner("lms", p.who))) return;
  const { data, seen, feed } = await load();
  const now = Date.now();
  const fresh = new Set(p.events.map((e) => e.id));
  const byId = new Map(
    data.deadlines
      .filter((d) => d.due < p.from || d.due >= p.to || fresh.has(d.id))
      .map((d) => [d.id, d])
  );
  for (const e of p.events) {
    const prev = byId.get(e.id);
    byId.set(e.id, {
      id: e.id,
      title: cleanTitle(e.name),
      course: e.course,
      type: deadlineType(e.type),
      due: e.due,
      url: e.url,
      done: e.due > now ? e.done : (prev?.done ?? false),
    });
  }
  data.deadlines = [...byId.values()];
  prune(data);
  seen.deadlines = now;
  await save({ data, seen, feed: p.feed && FEED.test(p.feed) ? p.feed : feed });
}

// ---- LMS calendar link (works without an LMS session) ----

function parseIcs(text: string) {
  const local = (v: string) => {
    const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?/);
    if (!m) return 0;
    const [, y, mo, d, h = "0", mi = "0", s = "0", utc] = m;
    const ms = Date.UTC(+y!, +mo! - 1, +d!, +h, +mi, +s);
    return utc ? ms : ms - 7 * HOUR;
  };
  const unescape = (s = "") => s.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1");

  const events: { id: string; name: string; course: string; due: number }[] = [];
  let current: Record<string, string> | null = null;
  for (const line of text.replace(/\r?\n[ \t]/g, "").split(/\r?\n/)) {
    if (line === "BEGIN:VEVENT") current = {};
    else if (line === "END:VEVENT" && current) {
      const id = current.UID?.split("@")[0] ?? "";
      const due = local(current.DTSTART ?? "");
      if (id && due) {
        events.push({ id, name: unescape(current.SUMMARY), course: unescape(current.CATEGORIES), due });
      }
      current = null;
    } else if (current) {
      const i = line.indexOf(":");
      if (i > 0) current[line.slice(0, i).split(";")[0]!.toUpperCase()] = line.slice(i + 1);
    }
  }
  return events;
}

async function refreshFeed() {
  const { feed, data, seen, settings } = await load();
  if (!settings.deadlines || !FEED.test(feed)) return;
  let res: Response;
  let text: string;
  try {
    res = await fetch(feed, { credentials: "omit", cache: "no-store" });
    text = await res.text();
  } catch {
    return;
  }
  if (!text.includes("BEGIN:VCALENDAR")) {
    // The LMS says so in plain words when a link stops working (a new one is made on the next LMS visit).
    // Anything else, an error or maintenance page, passes.
    if (res.ok && /invalid authentication|no export/i.test(text)) await save({ feed: "" });
    return;
  }

  // The link covers the last few days and the next 60.
  const now = Date.now();
  const events = parseIcs(text).filter((e) => !/\s(bắt đầu|opens)$/i.test(e.name));
  const fresh = new Set(events.map((e) => e.id));
  const byId = new Map(
    data.deadlines
      .filter((d) => d.due <= now || d.due >= now + 55 * DAY || fresh.has(d.id))
      .map((d) => [d.id, d])
  );
  for (const e of events) {
    const prev = byId.get(e.id);
    byId.set(
      e.id,
      prev
        ? { ...prev, title: cleanTitle(e.name), due: e.due }
        : {
            id: e.id,
            title: cleanTitle(e.name),
            course: e.course,
            type: /(tới hạn|đến hạn|is due)$/i.test(e.name)
              ? "due"
              : /(kết thúc|closes)$/i.test(e.name)
                ? "close"
                : "other",
            due: e.due,
            url: `https://lms.ueh.edu.vn/calendar/view.php?view=day&time=${Math.floor(e.due / 1000)}`,
            done: false,
          }
    );
  }
  data.deadlines = [...byId.values()];
  prune(data);
  await save({ data, seen: { ...seen, feed: now } });
}

// ---- Reading UEH in the background ----

// Reading needs a DOM, which this worker doesn't have, so a hidden extension page does it (offscreen.ts).
async function readUeh(site: Site, plan: Plan): Promise<ReadResult> {
  await chrome.offscreen
    .createDocument({
      url: "offscreen.html",
      reasons: [chrome.offscreen.Reason.DOM_PARSER],
      justification: "Read the UEH timetable, exams and LMS deadlines of the signed-in student",
    })
    .catch(() => {}); // already open
  return chrome.runtime.sendMessage({ type: "READ", site, plan } satisfies Message);
}

// The student is registering for courses (or signing up for something) on the portal right now.
async function registering(): Promise<boolean> {
  const tabs = await chrome.tabs.query({ url: "*://student.ueh.edu.vn/*" }).catch(() => []);
  return tabs.some((t) => t.url && REGISTERING.test(new URL(t.url).pathname));
}

// `everything` (the popup's sync button) reads both sites now, however recently they were read.
async function refreshInBackground(everything = false) {
  const { account, settings, login } = await load();
  if (!navigator.onLine) return runSync();
  await save({ busy: Date.now() });
  try {
    return await refresh(everything, Boolean(account), settings, login);
  } finally {
    await save({ busy: 0 });
  }
}

async function refresh(everything: boolean, account: boolean, settings: State["settings"], login: State["login"]) {
  if (account || everything) {
    const p = everything
      ? { exams: settings.exams, classes: settings.classes, deadlines: settings.deadlines, feed: settings.deadlines }
      : await plan(AWAY);
    const want: Record<Site, boolean> = {
      portal: (p.classes || p.exams) && (everything || !(await registering())),
      lms: p.deadlines || p.feed,
    };
    try {
      for (const site of ["portal", "lms"] as Site[]) {
        if (!want[site]) continue;
        const result = await readUeh(site, p).catch(() => null);
        if (!result) continue; // couldn't reach UEH: next round
        if ("login" in result) {
          login[site] = true;
          continue;
        }
        login[site] = false;
        if (!result.payload) continue;
        if (site === "portal") await mergePortal(result.payload as PortalPayload);
        else await mergeLms(result.payload as LmsPayload);
      }
    } finally {
      await chrome.offscreen.closeDocument().catch(() => {});
    }
    await save({ login });
  }
  await refreshFeed();
  return runSync();
}

// ---- Account ----

async function connect() {
  let token: string;
  try {
    token = await getToken(true);
  } catch (err) {
    // Closing Google's window changes nothing; skipping the calendar box is worth a word.
    if (err instanceof ScopeError) await save({ problem: "scope" });
    return false;
  }
  const res = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new AuthError();
  const user = await res.json();
  await save({
    account: { email: user.email, name: user.name || user.email, picture: user.picture },
    problem: "",
  });
  // The sign-in window closed the popup; bring it back so the student sees the calendars fill in.
  chrome.action.openPopup().catch(() => {});
  task(() => refreshInBackground()); // reads UEH unless it was just read (e.g. right after installing)
  return true;
}

async function disconnect() {
  const { account } = await load();
  try {
    const { web } = await chrome.storage.session.get("web");
    const token = web?.token ?? (await getToken(false, account?.email));
    await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, {
      method: "POST",
      mode: "no-cors",
    });
  } catch {
    // Already signed out, or offline.
  }
  await dropToken();
  // The calendars stay in Google; connecting this account again finds and keeps filling them.
  await save({ account: null, problem: "", calendars: {}, who: {} });
  await badge();
  return true;
}

async function ics() {
  const state = await load();
  const events = (
    await Promise.all(SOURCES.filter((s) => state.settings[s]).map((s) => withIds(s, state)))
  ).flat();
  return toIcs(events);
}

// ---- Toolbar badge: deadlines due in the next 3 days ----

async function badge() {
  const { account, problem, data, login, settings, feed, seen, synced } = await load();
  const warn = async (title: string) => {
    await chrome.action.setBadgeBackgroundColor({ color: "#f59e0b" });
    await chrome.action.setBadgeText({ text: "!" });
    await chrome.action.setTitle({ title: `UniCal · ${title}` });
  };
  if (!account || problem === "auth" || problem === "scope") {
    return warn(account ? "Kết nối lại Google Calendar" : "Kết nối Google Calendar");
  }
  const sites = signInNeeded({ login, settings, feed });
  if (sites.length) {
    const again = Object.values(seen).some(Boolean) ? "Đăng nhập lại" : "Đăng nhập";
    return warn(`${again} ${sites.join(" và ")}`);
  }
  const now = Date.now();
  // Problems that usually sort themselves out only get a sign once they've lasted: Google refusing changes
  // for a day, or UEH not read for three.
  if (problem === "google" && synced && now - synced > DAY) return warn("Chưa đồng bộ được với Google Calendar");
  const read = SOURCES.filter((s) => settings[s])
    .map((s) => (s === "deadlines" ? Math.max(seen.deadlines ?? 0, seen.feed ?? 0) : seen[s] ?? 0))
    .filter(Boolean);
  const days = read.length ? Math.floor((now - Math.min(...read)) / DAY) : 0;
  if (days >= 3) return warn(`Lịch chưa cập nhật ${days} ngày`);
  const soon = settings.deadlines
    ? data.deadlines.filter((d) => !d.done && d.due > now && d.due < now + 3 * DAY)
    : [];
  await chrome.action.setBadgeBackgroundColor({ color: "#dc2626" });
  await chrome.action.setBadgeText({ text: soon.length ? String(soon.length) : "" });
  await chrome.action.setTitle({
    title: soon.length ? `UniCal · ${soon.length} deadline trong 3 ngày tới` : "UniCal",
  });
}

// ---- Wiring ----

async function handle(message: Message): Promise<unknown> {
  switch (message.type) {
    case "PLAN":
      return plan(VISIT);
    case "PORTAL":
      return task(async () => {
        await mergePortal(message.payload);
        await signedIn("portal");
        return runSync();
      });
    case "LMS":
      return task(async () => {
        await mergeLms(message.payload);
        await signedIn("lms");
        return runSync();
      });
    case "CONNECT":
      return connect();
    case "DISCONNECT":
      return task(disconnect);
    case "SYNC":
      return task(() => refreshInBackground(true));
    case "TOGGLE": {
      const { settings } = await load();
      await save({ settings: { ...settings, [message.source]: message.on } });
      task(() => (message.on ? refreshInBackground() : runSync()));
      return true;
    }
    case "ICS":
      return ics();
    case "OPEN_POPUP":
      return chrome.action
        .openPopup()
        .catch(() => chrome.tabs.create({ url: chrome.runtime.getURL("index.html") }));
  }
}

// What UniCal keeps is for its own pages only; the script on UEH pages talks to it through messages.
chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }).catch(() => {});
chrome.storage.sync.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }).catch(() => {});

// UEH pages may only hand over what they read and ask for the popup; everything else comes from UniCal's own pages.
const FROM_PAGES = new Set<Message["type"]>(["PLAN", "PORTAL", "LMS", "OPEN_POPUP"]);
const UEH = /^https:\/\/(student|lms)\.ueh\.edu\.vn\//;
chrome.runtime.onMessage.addListener((message: Message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return false;
  const own = sender.url?.startsWith(chrome.runtime.getURL(""));
  if (!own && !(FROM_PAGES.has(message.type) && UEH.test(sender.url ?? ""))) return false;
  if (message.type === "READ") return false; // for the hidden reading page
  handle(message).then(respond, () => respond(undefined));
  return true;
});

// The student just read a site in the open page, so UEH has them signed in there again.
async function signedIn(site: Site) {
  const { login } = await load();
  if (login[site]) await save({ login: { ...login, [site]: false } });
}

chrome.alarms.onAlarm.addListener(() => task(() => refreshInBackground()));
chrome.runtime.onStartup.addListener(() => task(() => refreshInBackground()));

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === "update") {
    // Earlier versions kept different keys and signed in differently; start clean.
    const old = await chrome.storage.local.get(null);
    await chrome.storage.local.remove(Object.keys(old).filter((k) => !(k in DEFAULTS)));
    // A calendar switched off in an earlier version, which only stopped updating it, stays in Google as the
    // student left it: only switching one off in the popup, which asks first, removes it.
    const { settings, calendars } = await load();
    for (const source of SOURCES) if (!settings[source]) delete calendars[source];
    await save({ calendars });
  }
  if (reason === "install") {
    chrome.action.openPopup().catch(() => {});
    task(() => refreshInBackground(true)); // so the popup already shows what UniCal found
  }
  if (reason === "update") task(() => refreshInBackground());
  await badge();
});

chrome.alarms.get("tick").then((alarm) => {
  if (!alarm) chrome.alarms.create("tick", { periodInMinutes: 60 });
});
