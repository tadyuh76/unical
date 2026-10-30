// Reads the signed-in student's timetable and exams from the UEH student portal, and their deadlines
// from the LMS, with the student's own UEH cookies. Used on the pages themselves (content.ts) and by the
// background (offscreen.ts), so both read exactly the same way. Only DOM and fetch here, no chrome APIs.
import type { ClassSession, Exam, LmsEvent, LmsPayload, Plan, PortalPayload, Site, Term } from "@/types";

export const PORTAL = "https://student.ueh.edu.vn";
export const LMS = "https://lms.ueh.edu.vn";
const HUB = "https://loginst.ueh.edu.vn"; // UEH's login page for students, shared by both

// The portal or LMS session has lapsed.
export class Expired extends Error {}

// ---- Helpers ----

const parseHtml = (html: string) =>
  new DOMParser().parseFromString(html, "text/html");

const text = (el: Element | null | undefined) =>
  (el?.textContent ?? "").replace(/\s+/g, " ").trim();

const pad = (n: number) => String(n).padStart(2, "0");

// "12/06/2026" -> "2026-06-12"
function isoDate(value: string): string {
  const m = value.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? `${m[3]}-${pad(Number(m[2]))}-${pad(Number(m[1]))}` : "";
}

// "06g45" -> "06:45"
function clock(value: string): string {
  const m = value.match(/(\d{1,2})\s*[g:h]\s*(\d{2})/i);
  return m ? `${pad(Number(m[1]))}:${m[2]}` : "";
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function pool<T, R>(
  items: T[],
  size: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return out;
}

// A GET with the student's UEH cookies. Ending up anywhere but the page asked for (the login hub, or
// Moodle's sign-in page) means the session has lapsed.
async function get(origin: string, path: string, init: RequestInit = {}): Promise<string> {
  const res = await fetch(origin + path, { credentials: "include", cache: "no-store", ...init });
  if (!res.url.startsWith(origin) || /\/login\/index\.php|\/Login\//.test(res.url)) throw new Expired();
  if (!res.ok) throw new Error(`${res.status} ${path}`);
  return res.text();
}

const roomId = (room: string) => room.replace(/\s*\(.*\)\s*$/, "").trim();

// ---- Student portal ----

const nextTerm = ({ year, term }: Term): Term =>
  term === "HKD"
    ? { year, term: "HKG" }
    : term === "HKG"
      ? { year, term: "HKC" }
      : { year: String(Number(year) + 1), term: "HKD" };

async function currentTerm(): Promise<Term | null> {
  const doc = parseHtml(await get(PORTAL, "/Home/Schedules"));
  const year = doc.querySelector<HTMLSelectElement>("#YearStudy")?.value;
  const term = doc.querySelector<HTMLSelectElement>("#TermID")?.value;
  return year && term ? { year, term } : null;
}

// Whole-term view: used for campus addresses and to skip terms without classes.
function readTermOverview(html: string) {
  const addresses = new Map<string, string>();
  let sessions = 0;
  parseHtml(html)
    .querySelectorAll("tbody tr")
    .forEach((tr) => {
      const cells = Array.from(tr.querySelectorAll("td")).map(text);
      if (cells.length < 6) return;
      const [day, , room, , campus, address] = cells.slice(-6) as string[];
      if (day) sessions++;
      const clean = address!.replace(/\s*\[Địa chỉ cũ:[^\]]*\]/i, "").trim();
      if (!/\d/.test(clean) || /online|lms/i.test(campus!)) return;
      if (room) addresses.set(roomId(room), clean);
      if (campus) addresses.set(campus, clean);
    });
  return { addresses, sessions };
}

function parseExams(html: string, term: string): Exam[] | null {
  if (!/<table/i.test(html)) return null;
  const exams = new Map<string, Exam>();
  parseHtml(html)
    .querySelectorAll("table tbody tr")
    .forEach((row) => {
      const c = row.querySelectorAll("td");
      if (c.length < 10) return;
      const head = text(c[0]).match(/^(\S+)\s+(.+)$/);
      const date = isoDate(text(c[3]));
      if (!head || !date) return;
      const exam: Exam = {
        key: "",
        term,
        lhp: head[1]!,
        subject: head[2]!,
        sbd: text(c[1]),
        attempt: text(c[2]),
        date,
        time: clock(text(c[4])),
        room: text(c[5]),
        campus: text(c[6]),
        format: text(c[7]),
        kind: text(c[8]),
        note: text(c[9]),
        address: "",
      };
      exam.key = `${term}|${exam.lhp}|${exam.attempt}|${exam.kind}`;
      exams.set(exam.key, exam);
    });
  return [...exams.values()];
}

// Column of every cell in the weekly grid, accounting for rowspans above it.
function columns(table: Element): Map<Element, number> {
  const map = new Map<Element, number>();
  const covered: number[] = [];
  table.querySelectorAll("tbody tr").forEach((tr) => {
    let col = 0;
    for (const cell of Array.from((tr as HTMLTableRowElement).cells)) {
      while ((covered[col] ?? 0) > 0) col++;
      map.set(cell, col);
      covered[col] = Number(cell.getAttribute("rowspan") || 1);
      col++;
    }
    for (let i = 0; i < covered.length; i++) {
      if (covered[i]) covered[i]!--;
    }
  });
  return map;
}

function parseWeek(
  html: string,
  term: string
): { monday: string; sessions: ClassSession[] } | null {
  const doc = parseHtml(html);
  const table = doc.querySelector("table.MainTb");
  const monday = isoDate(text(doc.querySelector(".config-alert")));
  if (!table || !monday) return null;

  const cols = columns(table);
  const sessions: ClassSession[] = [];
  table.querySelectorAll(".Content").forEach((div) => {
    const col = cols.get(div.closest("td")!) ?? 0;
    if (col < 1 || col > 7) return;

    const info: Record<string, string> = {};
    div.querySelectorAll("span").forEach((span) => {
      const t = text(span);
      const style = span.getAttribute("style") ?? "";
      if (style.includes("font-size:15px")) info.room = t;
      else if (style.includes("color: red")) info.subject = t;
      else if (t.startsWith("LHP:")) info.lhp = t.slice(4).trim();
      else if (t.startsWith("Tiết:")) info.periods = t.slice(5).trim();
      else if (t.startsWith("Giờ học:")) info.time = t.slice(8).trim();
      else if (t.startsWith("GV:")) info.teacher = t.slice(3).trim();
      else if (t.startsWith("Email:")) info.email = t.slice(6).trim();
      else if (t.startsWith("Hình thức học:")) info.mode = t.slice(14).trim();
    });

    const [from, to] = (info.time ?? "").split("->").map(clock);
    if (!info.subject || !from || !to) return;
    const named = info.subject.match(/^(.*?)\s*\(([A-Z]{2,4}\d{5,6})\)$/);
    const date = addDays(monday, col - 1);
    const lhp = info.lhp ?? "";
    sessions.push({
      key: `${term}|${lhp}|${date}|${info.periods ?? from}`,
      term,
      subject: named ? named[1]! : info.subject,
      code: named ? named[2]! : "",
      lhp,
      start: `${date}T${from}`,
      end: `${date}T${to}`,
      periods: info.periods ?? "",
      room: info.room ?? "",
      mode: info.mode ?? "",
      teacher: info.teacher ?? "",
      email: info.email ?? "",
      address: "",
    });
  });
  return { monday, sessions };
}

export async function readPortal(plan: Plan): Promise<PortalPayload | null> {
  const current = await currentTerm();
  if (!current) return null;
  const terms = [current, nextTerm(current)];
  const ids = terms.map((t) => t.year + t.term);
  const query = (t: Term) => `YearStudy=${t.year}&TermID=${t.term}`;

  const overviews = await Promise.all(
    terms.map(async (t) =>
      readTermOverview(await get(PORTAL, `/Home/DrawingStudentSchedule_Perior?${query(t)}`))
    )
  );
  const addresses = new Map<string, string>();
  overviews.forEach((o) => o.addresses.forEach((v, k) => addresses.set(k, v)));
  const addressOf = (room: string, campus = "") =>
    addresses.get(roomId(room)) ?? addresses.get(campus) ?? "";

  const payload: PortalPayload = { terms: ids };

  if (plan.exams) {
    const lists = await Promise.all(
      terms.map(async (t, i) =>
        parseExams(await get(PORTAL, `/Home/ShowExam?${query(t)}`), ids[i]!)
      )
    );
    if (lists.every(Boolean)) {
      payload.exams = lists
        .flat()
        .map((e) => ({ ...e!, address: addressOf(e!.room, e!.campus) }));
    }
  }

  if (plan.classes) {
    const sessions: ClassSession[] = [];
    const from: Record<string, string> = {};
    for (const [i, t] of terms.entries()) {
      const id = ids[i]!;
      if (overviews[i]!.sessions === 0) {
        from[id] = "";
        continue;
      }
      const weeks: { Week: number; WeekOfYear: number }[] = JSON.parse(
        await get(PORTAL, `/Home/GetWeek/${t.year}$${t.term}`)
      );
      const start = Math.max(
        0,
        weeks.findIndex((w) => w.Week === weeks[0]?.WeekOfYear)
      );
      // Week numbers repeat when a term's list runs past a year; each week is read once.
      const unique = weeks.slice(start).filter((w, i, all) => all.findIndex((x) => x.Week === w.Week) === i);
      const pages = await pool(unique, 4, async (w) =>
        parseWeek(await get(PORTAL, `/Home/DrawingSchedules?${query(t)}&Week=${w.Week}`), id)
      );
      if (pages.some((p) => !p)) return payload;
      from[id] = pages[0]?.monday ?? "";
      const keys = new Set(sessions.map((s) => s.key));
      pages.forEach((p) =>
        p!.sessions.forEach((s) => {
          if (keys.has(s.key)) return;
          keys.add(s.key);
          sessions.push({ ...s, address: addressOf(s.room) });
        })
      );
    }
    payload.classes = { sessions, from };
  }

  return payload;
}

// ---- LMS ----

interface MoodleEvent {
  id: number;
  name: string;
  eventtype: string;
  modulename?: string;
  timestart: number;
  url?: string;
  course?: { fullname?: string; shortname?: string };
}

export async function readLms(plan: Plan): Promise<LmsPayload | null> {
  // The calendar export form carries the session key, and is also how the private link is made.
  const form = parseHtml(await get(LMS, "/calendar/export.php"));
  const sesskey = form.querySelector<HTMLInputElement>('input[name="sesskey"]')?.value;
  if (!sesskey) return null;

  const call = async <T>(methodname: string, args: object): Promise<T> => {
    const [result] = JSON.parse(
      await get(LMS, `/lib/ajax/service.php?sesskey=${sesskey}&info=${methodname}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify([{ index: 0, methodname, args }]),
      })
    );
    if (result?.exception?.errorcode === "servicerequireslogin") throw new Expired();
    if (!result || result.error) throw new Error(methodname);
    return result.data as T;
  };

  // Every calendar event from the start of this month through the next three.
  const now = new Date();
  const month = (offset: number) =>
    new Date(now.getFullYear(), now.getMonth() + offset, 1);
  const from = month(0).getTime();
  const to = month(4).getTime();
  const views = await Promise.all(
    [0, 1, 2, 3].map((i) =>
      call<{ weeks: { days: { events: MoodleEvent[] }[] }[] }>(
        "core_calendar_get_calendar_monthly_view",
        {
          year: month(i).getFullYear(),
          month: month(i).getMonth() + 1,
          courseid: 1,
          categoryid: 0,
          includenavigation: false,
          mini: true,
        }
      )
    )
  );
  const all = new Map<number, MoodleEvent>();
  views.forEach((v) =>
    v.weeks.forEach((w) => w.days.forEach((d) => d.events.forEach((e) => all.set(e.id, e))))
  );

  // Activities still waiting on the student. Submitted ones drop out of this list.
  const open = new Set<number>();
  let complete = false;
  let after: number | undefined;
  for (let page = 0; page < 6 && !complete; page++) {
    const data = await call<{ events: MoodleEvent[]; lastid?: number }>(
      "core_calendar_get_action_events_by_timesort",
      {
        timesortfrom: Math.floor(from / 1000) - 14 * 86400,
        timesortto: Math.floor(to / 1000),
        limitnum: 50,
        ...(after ? { aftereventid: after } : {}),
      }
    );
    data.events.forEach((e) => open.add(e.id));
    complete = data.events.length < 50;
    after = data.lastid ?? data.events.at(-1)?.id;
  }

  const events: LmsEvent[] = [...all.values()]
    .filter((e) => e.eventtype !== "open")
    .map((e) => ({
      id: String(e.id),
      name: e.name,
      type: e.eventtype,
      course: [e.course?.fullname, e.course?.shortname].filter(Boolean).join(" | "),
      due: e.timestart * 1000,
      url: e.url ?? "",
      done:
        complete &&
        Boolean(e.modulename) &&
        ["due", "close", "expectcompletionon"].includes(e.eventtype) &&
        !open.has(e.id),
    }));

  const payload: LmsPayload = { events, from, to };

  if (plan.feed) {
    const page = await get(LMS, "/calendar/export.php", {
      method: "POST",
      body: new URLSearchParams({
        sesskey,
        _qf__core_calendar_export_form: "1",
        "events[exportevents]": "all",
        "period[timeperiod]": "recentupcoming",
        generateurl: "1",
      }),
    });
    const path = page.match(/\/calendar\/export_execute\.php\?[^"'<\s]+/)?.[0];
    if (path) payload.feed = LMS + path.replace(/&amp;/g, "&");
  }

  return payload;
}

// ---- Signing back in ----

// UEH's login hub remembers the student long after the portal and LMS sessions lapse. Going through it and
// pressing its "Tiếp tục / Continue" (what the student would click; no password involved) opens a fresh
// session. False when the hub has forgotten them too, so they need to sign in once themselves.
export async function renew(site: Site): Promise<boolean> {
  const origin = site === "portal" ? PORTAL : LMS;
  const entry = site === "portal" ? "/Login/LoginUEH" : "/ueh-login/student.php";
  const back = (url: string) => url.startsWith(origin) && !/\/login\/index\.php|\/Login\//.test(url);
  const hub = await fetch(origin + entry, { credentials: "include", cache: "no-store" });
  if (back(hub.url)) return true;
  if (!hub.url.startsWith(HUB) || !(await hub.text()).includes("onclickContinue")) return false;
  const done = await fetch(`${HUB}/continue`, { credentials: "include", cache: "no-store" });
  return back(done.url);
}

// Reads one site; when its session has lapsed, signs back in through the hub and reads again.
export async function readSite(site: Site, plan: Plan): Promise<{ payload: PortalPayload | LmsPayload | null } | { login: true }> {
  const read = () => (site === "portal" ? readPortal(plan) : readLms(plan));
  try {
    return { payload: await read() };
  } catch (err) {
    if (!(err instanceof Expired)) throw err;
  }
  if (!(await renew(site))) return { login: true };
  try {
    return { payload: await read() };
  } catch (err) {
    if (err instanceof Expired) return { login: true };
    throw err;
  }
}
