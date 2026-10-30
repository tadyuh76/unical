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
