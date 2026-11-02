// Everything UniCal remembers lives in chrome.storage.local, on this device only.
import type { ClassSession, Deadline, Exam, Site, Source } from "@/types";

export interface Account {
  email: string;
  name: string;
  picture?: string;
}

export interface CalendarState {
  id: string;
  // Google event id -> content hash and start time of what was last written.
  events: Record<string, { h: string; s: number }>;
}

// Event colours, as Google Calendar colour ids ("1"–"11"). Classes either take one colour per course or one
// colour for all of them.
export interface Colors {
  classes: "course" | string;
  exams: string;
  deadlines: string;
}

export interface State {
  data: { classes: ClassSession[]; exams: Exam[]; deadlines: Deadline[] };
  subjects: Record<string, string>; // class section (LHP) -> subject name
  seen: Partial<Record<Source | "feed", number>>; // last successful read per source
  feed: string; // private LMS calendar link, works without an LMS session
  settings: Record<Source, boolean>;
  account: Account | null;
  calendars: Partial<Record<Source, CalendarState>>;
  synced: number;
  problem: "" | "auth" | "google" | "scope";
  nudged: number;
  login: Partial<Record<Site, boolean>>; // UEH signed the student out of this site completely
  busy: number; // when the running read/sync started, 0 when idle
  who: Partial<Record<Site, string>>; // whose UEH data this is: student number, LMS user id
  doubt: Record<string, number>; // "classes|2026HKC" -> when a read first came back empty for a term with things ahead
  colors: Colors;
  old: string; // the calendar UniCal 1.x made ("Lịch Học UEH") while it's still in Google, else ""
}

export const DEFAULTS: State = {
  data: { classes: [], exams: [], deadlines: [] },
  subjects: {},
  seen: {},
  feed: "",
  settings: { classes: true, exams: true, deadlines: true },
  account: null,
  calendars: {},
  synced: 0,
  problem: "",
  nudged: 0,
  login: {},
  busy: 0,
  who: {},
  doubt: {},
  colors: { classes: "7", exams: "11", deadlines: "5" }, // classes blue (Lông công), exams red (Cà chua), deadlines yellow (Chuối)
  old: "",
};

export async function load(): Promise<State> {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  return { ...structuredClone(DEFAULTS), ...stored } as State;
}

export const save = (patch: Partial<State>) => chrome.storage.local.set(patch);

export const SOURCES: Source[] = ["classes", "exams", "deadlines"];

// Vietnam has no daylight saving time, so local time is always UTC+7.
export const atLocal = (local: string) => Date.parse(`${local}:00+07:00`);
export const toLocal = (ms: number) =>
  new Date(ms + 7 * 3600_000).toISOString().slice(0, 16);

// UEH signed the student out of a site completely: only they can sign back in. Deadlines keep coming
// through the private LMS link while it works, so the LMS only matters without it.
export function signInNeeded({ login, settings, feed }: Pick<State, "login" | "settings" | "feed">): string[] {
  return [
    login.portal && (settings.classes || settings.exams) && "UEH Student",
    login.lms && settings.deadlines && !feed && "LMS",
  ].filter((x): x is string => Boolean(x));
}
