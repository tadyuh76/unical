// Reads the signed-in student's timetable and exams from the UEH student portal, and their deadlines
// from the LMS, with the student's own UEH cookies. Used on the pages themselves (content.ts) and by the
// background (offscreen.ts), so both read exactly the same way. Only DOM and fetch here, no chrome APIs.
import type { ClassSession, Exam, LmsEvent, LmsPayload, Plan, PortalPayload, Site, Term } from "@/types";

export const PORTAL = "https://student.ueh.edu.vn";
export const LMS = "https://lms.ueh.edu.vn";

// The portal or LMS session has lapsed.
export class Expired extends Error {}

// UEH answers a student's requests one at a time, so UniCal's reads must never hold up the student's own
// clicks. Opening a portal page reads only on the home page, timetable, exams and profile, and while a
// registration page is open (course registration, sign-ups), UniCal leaves the portal alone altogether.
export const CALM = /^\/(home(\/(index|schedules|exam|info))?)?\/?$/i;
export const REGISTERING = /^\/home\/(dangky|ghidanh|regist)/i;

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

// A GET with the student's UEH cookies. Ending up anywhere but the page asked for (the login hub, or
// Moodle's sign-in page) means the session has lapsed. The portal now and then answers one page of a read
// with a server error and serves it fine a moment later, so a server error is asked again twice.
async function get(origin: string, path: string, init: RequestInit = {}): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(origin + path, { credentials: "include", cache: "no-store", ...init });
    if (!res.url.startsWith(origin) || /\/login\/index\.php|\/Login\//.test(res.url)) throw new Expired();
    if (res.ok) return res.text();
    if (res.status < 500 || attempt === 2) throw new Error(`${res.status} ${path}`);
    await new Promise((done) => setTimeout(done, 1500 * (attempt + 1)));
  }
}

const roomId = (room: string) => room.replace(/\s*\(.*\)\s*$/, "").trim();

// Without accents, spaces or case: the portal spells one place differently on different pages
// ("Bãi 1" in the week grid, "Bai1" in the term overview).
const plain = (value: string) =>
  value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/gi, "d").replace(/\s+/g, " ").trim().toLowerCase();
const roomKey = (room: string) => plain(roomId(room)).replace(/ /g, "");

// Today and this week's Monday, Vietnam time.
function thisMonday(): string {
  const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
  return addDays(today, -((new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7));
}

// ---- Student portal ----

const nextTerm = ({ year, term }: Term): Term =>
  term === "HKD"
    ? { year, term: "HKG" }
    : term === "HKG"
      ? { year, term: "HKC" }
      : { year: String(Number(year) + 1), term: "HKD" };

const prevTerm = ({ year, term }: Term): Term =>
  term === "HKC"
    ? { year, term: "HKG" }
    : term === "HKG"
      ? { year, term: "HKD" }
      : { year: String(Number(year) - 1), term: "HKC" };

// The term the timetable page opens on, and the student signed in (their number heads the account menu).
async function currentTerm(): Promise<{ term: Term; who: string } | null> {
  const doc = parseHtml(await get(PORTAL, "/Home/Schedules"));
  const year = doc.querySelector<HTMLSelectElement>("#YearStudy")?.value;
  const term = doc.querySelector<HTMLSelectElement>("#TermID")?.value;
  const who = text(doc.querySelector("a[data-toggle=dropdown] span")).match(/\d{8,}/)?.[0] ?? "";
  return year && term ? { term: { year, term }, who } : null;
}

// Whole-term view: campus addresses, and the first and last day with classes ("Tuần" column), so only
// the weeks in between need reading.
function readTermOverview(html: string) {
  const addresses = new Map<string, string>();
  let sessions = 0;
  let first = "";
  let last = "";
  parseHtml(html)
    .querySelectorAll("tbody tr")
    .forEach((tr) => {
      const cells = Array.from(tr.querySelectorAll("td")).map(text);
      if (cells.length < 6) return;
      const [day, , room, span, campus, address] = cells.slice(-6) as string[];
      if (day) sessions++;
      for (const [d] of span!.matchAll(/\d{1,2}\/\d{1,2}\/\d{4}/g)) {
        const date = isoDate(d);
        if (!first || date < first) first = date;
        if (date > last) last = date;
      }
      const clean = address!.replace(/\s*\[Địa chỉ cũ:[^\]]*\]/i, "").trim();
      // Not a place: online, LMS, called off ("Nghỉ"), extracurricular ("Ngoại khóa").
      if (!clean || /\b(online|lms|nghi)\b|ngoai ?khoa/.test(plain(`${campus} ${clean}`))) return;
      // A bare district (the defence-training centre's "Thủ Đức") reads better with the campus name.
      const place = /\d/.test(clean) ? clean : [campus, clean].filter(Boolean).join(", ");
      if (room) addresses.set(roomKey(room), place);
      if (campus) addresses.set(campus, place);
    });
  return { addresses, sessions, first, last };
}

// Both of the page's tables (upcoming, and all with their status); an exam UEH excused the student from
// ("Đã duyệt" on their absence request) is left out.
function parseExams(html: string, term: string): Exam[] | null {
  if (!/<table/i.test(html)) return null;
  const exams = new Map<string, Exam>();
  const excused = new Set<string>();
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
      if (c.length >= 12 && /^đã duyệt/i.test(text(c[10])) && !/xin vắng/i.test(text(c[11]))) excused.add(exam.key);
    });
  excused.forEach((key) => exams.delete(key));
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

type Week = { monday: string; sessions: ClassSession[] };

function parseWeek(html: string, term: string): Week | null {
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
  const opened = await currentTerm();
  if (!opened) return null;
  const current = opened.term;
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
    addresses.get(roomKey(room)) ?? addresses.get(campus) ?? "";

  // Exams also from the term before: its exams can run weeks into the portal's next term.
  const examTerms = [prevTerm(current), ...terms];
  const payload: PortalPayload = { who: opened.who, terms: examTerms.map((t) => t.year + t.term) };

  if (plan.exams) {
    const lists = await Promise.all(
      examTerms.map(async (t) => parseExams(await get(PORTAL, `/Home/ShowExam?${query(t)}`), t.year + t.term))
    );
    if (lists.every(Boolean)) {
      // An exam room the term's classes never used has no address there; the exam row's own note then
      // carries the campus address (or, for online exams, a note about the "virtual campus").
      const noted = (e: Exam) =>
        /\d/.test(e.note) && !/co so ao/.test(plain(e.note)) ? e.note.replace(/\s*\[Địa chỉ cũ:[^\]]*\]/i, "").trim() : "";
      payload.exams = lists
        .flat()
        .map((e) => ({ ...e!, address: addressOf(e!.room, e!.campus) || noted(e!) }));
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
      const weeks: { Week: number; DisPlayWeek: number }[] = JSON.parse(
        await get(PORTAL, `/Home/GetWeek/${t.year}$${t.term}`)
      );
      // Week numbers repeat when a term's list runs past a year (the spring term's runs December to
      // December); the portal only serves the first of each, so each is read once.
      const unique = weeks.filter((w, i, all) => all.findIndex((x) => x.Week === w.Week) === i);
      // The current term is read from this week on (what's past stays as it was), the next one whole.
      // Dates, not week numbers, decide: the list's "WeekOfYear" is just today's week number.
      const since = i === 0 ? thisMonday() : "";
      // One page at a time: UEH answers a student's requests one by one anyway, and in parallel they're slower.
      // The term's weeks run back to back, so the first page dates the rest, and the weeks outside the
      // term's class days are skipped. Should a page's date say otherwise, every week is read instead.
      const { first, last } = overviews[i]!;
      const lo = since > first ? since : first;
      let pages: (Week | null)[] = [];
      for (const skip of first ? [true, false] : [false]) {
        pages = [];
        let dated = true;
        for (const w of unique) {
          const monday = pages[0] ? addDays(pages[0].monday, 7 * (w.DisPlayWeek - unique[0]!.DisPlayWeek)) : "";
          if (skip && monday && (addDays(monday, 6) < lo || monday > last)) continue;
          const p = parseWeek(await get(PORTAL, `/Home/DrawingSchedules?${query(t)}&Week=${w.Week}`), id);
          pages.push(p);
          if (!p) break;
          if (skip && monday && p.monday !== monday) {
            dated = false;
            break;
          }
        }
        if (dated) break;
      }
      if (!pages.length || pages.some((p) => !p)) return payload;
      // From this day on, the term is what was just read; anything earlier stays as it was synced.
      const start = since > pages[0]!.monday ? since : pages[0]!.monday;
      from[id] = start;
      const keys = new Set(sessions.map((s) => s.key));
      pages.forEach((p) =>
        p!.sessions.forEach((s) => {
          if (s.start < start || keys.has(s.key)) return;
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

  const who = form.querySelector("[data-userid]")?.getAttribute("data-userid") ?? "";
  const payload: LmsPayload = { who, events, from, to };

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

// A lapsed portal or LMS session: going through the site's UEH sign-in sometimes lets the student straight
// back in. Otherwise UEH's login page wants them: its "Tiếp tục" is checked by reCAPTCHA, so only the student
// presses it (or signs in with their password), and the popup asks them to.
// UEH sends the student back to the portal over plain http first, hence the manifest's http permission.
export async function renew(site: Site): Promise<boolean> {
  const origin = site === "portal" ? PORTAL : LMS;
  const entry = site === "portal" ? "/Login/LoginUEH" : "/ueh-login/student.php";
  const res = await fetch(origin + entry, { credentials: "include", cache: "no-store" });
  return res.url.startsWith(origin) && !/\/login\/index\.php|\/Login\//.test(res.url);
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
