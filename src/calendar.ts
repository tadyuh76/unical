// Turns timetable sessions, exams and LMS deadlines into calendar events.
// The same events feed Google Calendar sync and the .ics download.
import type { ClassSession, Deadline, Exam, Source } from "@/types";
import { atLocal, toLocal, type State } from "@/store";

export const TIMEZONE = "Asia/Ho_Chi_Minh";

export const CALENDARS: Record<Source, string> = {
  classes: "UEH · Lịch học",
  exams: "UEH · Lịch thi",
  deadlines: "UEH · Deadline",
};

interface GoogleTime {
  dateTime?: string;
  date?: string;
  timeZone?: string;
}

export interface GoogleEvent {
  summary: string;
  location?: string;
  description?: string;
  start: GoogleTime;
  end: GoogleTime;
  colorId?: string;
  transparency?: "transparent";
  reminders: {
    useDefault: boolean;
    overrides?: { method: "popup"; minutes: number }[];
  };
  source?: { title: string; url: string };
}

export interface CalendarEvent {
  key: string;
  start: number;
  body: GoogleEvent;
}

const EXAM_MINUTES = 90;
// Google event colors. UniCal may only touch its own calendars' events, not the
// calendar list, so colour is set per event: exams Tomato, deadlines Tangerine,
// and classes by subject from the rest, ordered so neighbours look different.
const EXAM_COLOR = "11";
const DEADLINE_COLOR = "6";
const PALETTE = ["7", "2", "9", "3", "5", "10", "1", "4", "8"];
const LHP = /\d{2}[DGC]\d[A-Z]{2,4}\d{8}/g;

const lines = (parts: (string | false | undefined)[]) =>
  parts.filter(Boolean).join("\n");

const roomId = (room: string) => room.replace(/\s*\(.*\)\s*$/, "").trim();

const nextDay = (date: string) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + 86400_000).toISOString().slice(0, 10);

const at = (local: string) => ({ dateTime: `${local}:00`, timeZone: TIMEZONE });

// "Bài tập 3 tới hạn" -> "Bài tập 3"
export const cleanTitle = (name: string) =>
  name.replace(/\s+(tới hạn|đến hạn|is due|due)$/i, "").trim();

// Prefer the subject name from the timetable; otherwise tidy the LMS course name.
export function courseName(raw: string, subjects: Record<string, string>): string {
  for (const code of raw.match(LHP) ?? []) {
    if (subjects[code]) return subjects[code];
  }
  const full = raw.split(" | ")[0] ?? "";
  const tidy = full
    .replace(LHP, "")
    .replace(/\(\s*\)/g, "")
    .replace(/\s*[-–|]\s*(?=[-–|]|$)/g, "")
    .replace(/^\s*[-–|]\s*/, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return /\p{L}{4,}/u.test(tidy) ? tidy : full;
}

function classEvents(sessions: ClassSession[]): CalendarEvent[] {
  const colors = new Map<string, string>();
  const terms = new Map<string, Set<string>>();
  sessions.forEach((s) => {
    if (!terms.has(s.term)) terms.set(s.term, new Set());
    terms.get(s.term)!.add(s.subject);
  });
  terms.forEach((subjects, term) =>
    [...subjects]
      .sort((a, b) => a.localeCompare(b, "vi"))
      .forEach((subject, i) =>
        colors.set(`${term}|${subject}`, PALETTE[i % PALETTE.length]!)
      )
  );

  return sessions.map((s) => {
    const tag = s.room
      ? roomId(s.room)
      : /lms/i.test(s.mode)
        ? "LMS"
        : /online/i.test(s.mode)
          ? "Online"
          : "";
    return {
      key: s.key,
      start: atLocal(s.start),
      body: {
        summary: tag ? `[${tag}] ${s.subject}` : s.subject,
        location: s.address ? `${s.room}, ${s.address}` : s.room,
        description: lines([
          s.periods && `Tiết ${s.periods}`,
          s.teacher && `GV: ${s.teacher}${s.email ? ` · ${s.email}` : ""}`,
          s.mode && `Hình thức: ${s.mode}`,
          s.lhp && `LHP: ${s.lhp}`,
        ]),
        start: at(s.start),
        end: at(s.end),
        colorId: colors.get(`${s.term}|${s.subject}`),
        reminders: { useDefault: true },
      },
    };
  });
}

function examEvents(exams: Exam[]): CalendarEvent[] {
  return exams.map((e) => {
    const start = `${e.date}T${e.time || "00:00"}`;
    const [h = 0, m = 0] = (e.time || "00:00").split(":").map(Number);
    const eveningBefore = 4 * 60 + h * 60 + m; // 20:00 the day before
    return {
      key: e.key,
      start: atLocal(start),
      body: {
        summary: `Thi · ${e.subject}`,
        location: [e.room, e.address].filter(Boolean).join(", "),
        description: lines([
          e.sbd && `SBD: ${e.sbd}`,
          [e.kind, e.attempt].filter(Boolean).join(" · "),
          e.format && `Hình thức: ${e.format}`,
          e.note && e.note !== e.address && `Ghi chú: ${e.note}`,
          `LHP: ${e.lhp}`,
        ]),
        start: e.time ? at(start) : { date: e.date },
        colorId: EXAM_COLOR,
        end: e.time
          ? at(toLocal(atLocal(start) + EXAM_MINUTES * 60_000))
          : { date: nextDay(e.date) },
        reminders: {
          useDefault: false,
          overrides: [
            { method: "popup", minutes: eveningBefore },
            ...(e.time ? [{ method: "popup" as const, minutes: 60 }] : []),
          ],
        },
      },
    };
  });
}

function deadlineEvents(
  deadlines: Deadline[],
  subjects: Record<string, string>
): CalendarEvent[] {
  return deadlines.map((d) => {
    const course = courseName(d.course, subjects);
    const time = at(toLocal(d.due));
    return {
      key: d.id,
      start: d.due,
      body: {
        summary: `${d.done ? "✓ " : ""}${d.title}${course ? ` · ${course}` : ""}`,
        description: lines([course, d.url]),
        start: time,
        end: time,
        colorId: DEADLINE_COLOR,
        transparency: "transparent",
        reminders: d.done
          ? { useDefault: false, overrides: [] }
          : {
              useDefault: false,
              overrides: [
                { method: "popup", minutes: 1440 },
                { method: "popup", minutes: 120 },
              ],
            },
        ...(d.url ? { source: { title: "UEH LMS", url: d.url } } : {}),
      },
    };
  });
}

export function eventsFor(source: Source, state: State): CalendarEvent[] {
  if (source === "classes") return classEvents(state.data.classes);
  if (source === "exams") return examEvents(state.data.exams);
  return deadlineEvents(state.data.deadlines, state.subjects);
}

// ---- .ics ----

const icsText = (s: string) =>
  s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");

const icsUtc = (ms: number) =>
  new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

const icsTime = (name: string, t: GoogleTime) =>
  t.date
    ? `${name};VALUE=DATE:${t.date.replace(/-/g, "")}`
    : `${name}:${icsUtc(atLocal(t.dateTime!.slice(0, 16)))}`;

const fold = (line: string) =>
  line.length <= 74 ? line : line.match(/.{1,73}/g)!.join("\r\n ");

export function toIcs(events: (CalendarEvent & { id: string })[]): string {
  const stamp = icsUtc(Date.now());
  const out = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//UniCal//UEH//VI",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
  ];
  for (const { id, body } of events) {
    out.push(
      "BEGIN:VEVENT",
      `UID:${id}@unical`,
      `DTSTAMP:${stamp}`,
      icsTime("DTSTART", body.start),
      icsTime("DTEND", body.end),
      `SUMMARY:${icsText(body.summary)}`
    );
    if (body.location) out.push(`LOCATION:${icsText(body.location)}`);
    if (body.description) out.push(`DESCRIPTION:${icsText(body.description)}`);
    if (body.transparency) out.push("TRANSP:TRANSPARENT");
    for (const r of body.reminders.overrides ?? []) {
      out.push(
        "BEGIN:VALARM",
        "ACTION:DISPLAY",
        `DESCRIPTION:${icsText(body.summary)}`,
        `TRIGGER:-PT${r.minutes}M`,
        "END:VALARM"
      );
    }
    out.push("END:VEVENT");
  }
  out.push("END:VCALENDAR");
  return out.map(fold).join("\r\n") + "\r\n";
}
