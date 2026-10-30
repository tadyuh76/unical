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
import { CALENDARS, TIMEZONE, cleanTitle, eventsFor, toIcs } from "@/calendar";
import {
  DEFAULTS,
  SOURCES,
  atLocal,
  load,
  save,
  type CalendarState,
  type State,
} from "@/store";

const API = "https://www.googleapis.com/calendar/v3";
const CLIENT_ID =
  "467741806170-8hej1cop6kuihuhlh4cr1ok66ec05rk9.apps.googleusercontent.com";
// Only the calendars UniCal creates itself; the student's other calendars stay out of reach.
const SCOPES = [
  "https://www.googleapis.com/auth/calendar.app.created",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/userinfo.email",
];
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
    scope: SCOPES.join(" "),
    prompt: interactive ? "select_account" : "none",
    ...(hint ? { login_hint: hint } : {}),
  }).toString();

  const redirect = await chrome.identity
    .launchWebAuthFlow({ url: url.href, interactive })
    .catch(() => undefined);
  const params = new URLSearchParams(redirect ? new URL(redirect).hash.slice(1) : "");
  const token = params.get("access_token");
  if (!token) throw new AuthError();
  if (!params.get("scope")?.includes("calendar.app.created")) throw new ScopeError();
  const expires = Date.now() + Number(params.get("expires_in") ?? 3600) * 1000;
  await chrome.storage.session.set({ web: { token, expires } });
  return token;
}

const dropToken = () => chrome.storage.session.remove("web");

type Call = (method: string, path: string, body?: unknown) => Promise<Response>;

function google(initial: string, hint: string): Call {
  let token = initial;
  return async (method, path, body) => {
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
        if (attempt > 0) throw new AuthError();
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
      if (limited && attempt < 5) {
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

async function ensureCalendar(
  call: Call,
  source: Source,
  known?: CalendarState
): Promise<CalendarState> {
  if (known?.id) {
    const res = await call("GET", `/calendars/${encodeURIComponent(known.id)}`);
    if (res.ok) return known;
    if (res.status !== 404 && res.status !== 410) throw new Error(`calendar ${res.status}`);
  }
  const res = await call("POST", "/calendars", {
    summary: CALENDARS[source],
    description: "Tự động cập nhật bởi UniCal",
    timeZone: TIMEZONE,
  });
  if (!res.ok) throw new Error(`create ${res.status}`);
  const { id } = await res.json();
  return { id, events: {} };
}

// Writes only what changed since the last sync. Future events that disappeared
// from UEH are removed; past ones stay in the calendar as history.
async function reconcile(call: Call, source: Source, state: State): Promise<number> {
  const cal = await ensureCalendar(call, source, state.calendars[source]);
  state.calendars[source] = cal;
  const persist = () => save({ calendars: state.calendars });
  const base = `/calendars/${encodeURIComponent(cal.id)}/events`;
  const wanted = await withIds(source, state);
  const ids = new Set(wanted.map((e) => e.id));
  let changed = 0;

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
      if (!res.ok) return;
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
        if (!res.ok && res.status !== 404 && res.status !== 410) return;
        changed++;
      }
      delete cal.events[id];
    }
  );

  await persist();
  return changed;
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

  let call: Call;
  try {
    call = google(await getToken(false, state.account.email), state.account.email);
  } catch {
    await save({ problem: "auth" });
    await badge();
    return { changed, connected: false, nudge: false };
  }

  let problem: State["problem"] = "";
  for (const source of SOURCES) {
    if (!state.settings[source]) continue;
    try {
      changed[source] = await reconcile(call, source, state);
    } catch (err) {
      problem = err instanceof AuthError ? "auth" : "google";
      if (problem === "auth") break;
    }
  }
  await save({ problem, ...(problem ? {} : { synced: Date.now() }) });
  await badge();
  return { changed, connected: problem !== "auth", nudge: false };
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

async function plan(ages: Record<Source, number>): Promise<Plan> {
  const { seen, feed } = await load();
  const stale = (key: Source) => Date.now() - (seen[key] ?? 0) > ages[key];
  return { exams: stale("exams"), classes: stale("classes"), deadlines: stale("deadlines"), feed: !feed };
}

async function mergePortal(p: PortalPayload) {
  const { data, subjects, seen } = await load();
  if (p.exams) {
    data.exams = data.exams.filter((e) => !p.terms.includes(e.term)).concat(p.exams);
    seen.exams = Date.now();
  }
  if (p.classes) {
    const { from, sessions } = p.classes;
    data.classes = data.classes
      .filter((c) => {
        const start = from[c.term];
        return start === undefined || (start !== "" && c.start < start);
      })
      .concat(sessions);
    seen.classes = Date.now();
  }
  for (const item of [...data.classes, ...data.exams]) {
    if (item.lhp) subjects[item.lhp] = item.subject;
  }
  prune(data);
  await save({ data, subjects, seen });
}

const deadlineType = (eventType: string): Deadline["type"] =>
  eventType === "due" || eventType === "expectcompletionon"
    ? "due"
    : eventType === "close"
      ? "close"
      : "other";

async function mergeLms(p: LmsPayload) {
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
  await save({ data, seen, feed: p.feed || feed });
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
  const { feed, data, seen } = await load();
  if (!feed) return;
  let text: string;
  try {
    text = await (await fetch(feed, { credentials: "omit", cache: "no-store" })).text();
  } catch {
    return;
  }
  if (!text.includes("BEGIN:VCALENDAR")) {
    await save({ feed: "" }); // link no longer valid; a new one is made on the next LMS visit
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

// `everything` (the popup's sync button) reads both sites now, however recently they were read.
async function refreshInBackground(everything = false) {
  const { account, settings, login } = await load();
  if (account && navigator.onLine) {
    const p = everything ? { exams: true, classes: true, deadlines: true, feed: true } : await plan(AWAY);
    const want: Record<Site, boolean> = {
      portal: (settings.classes && p.classes) || (settings.exams && p.exams),
      lms: settings.deadlines && (p.deadlines || p.feed),
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
    await save({ problem: err instanceof ScopeError ? "scope" : "" });
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
  task(runSync);
  return true;
}

async function disconnect() {
  const { account } = await load();
  try {
    const token = await getToken(false, account?.email);
    await fetch(`https://oauth2.googleapis.com/revoke?token=${token}`, {
      method: "POST",
      mode: "no-cors",
    });
    await dropToken();
  } catch {
    // Already signed out.
  }
  await save({ account: null, problem: "" });
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
  const { account, problem, data, login, settings } = await load();
  if (!account || problem === "auth") {
    await chrome.action.setBadgeBackgroundColor({ color: "#f59e0b" });
    await chrome.action.setBadgeText({ text: "!" });
    await chrome.action.setTitle({ title: "UniCal · Kết nối Google Calendar" });
    return;
  }
  if (login.portal && (settings.classes || settings.exams)) {
    await chrome.action.setBadgeBackgroundColor({ color: "#f59e0b" });
    await chrome.action.setBadgeText({ text: "!" });
    await chrome.action.setTitle({ title: "UniCal · Đăng nhập UEH Student để lịch tiếp tục tự cập nhật" });
    return;
  }
  const now = Date.now();
  const soon = data.deadlines.filter((d) => !d.done && d.due > now && d.due < now + 3 * DAY);
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
      if (message.on) task(runSync);
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

chrome.runtime.onMessage.addListener((message: Message, _sender, respond) => {
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
  }
  if (reason === "install") chrome.action.openPopup().catch(() => {});
  if (reason === "update") task(() => refreshInBackground());
  await badge();
});

chrome.alarms.get("tick").then((alarm) => {
  if (!alarm) chrome.alarms.create("tick", { periodInMinutes: 60 });
});
