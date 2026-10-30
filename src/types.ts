// Shared shapes passed between the UEH pages, the background worker and the popup.
// Times without a zone are Vietnam local time ("YYYY-MM-DDTHH:mm").

export type Source = "classes" | "exams" | "deadlines";

// The two UEH sites UniCal reads: the student portal (classes, exams) and the LMS (deadlines).
export type Site = "portal" | "lms";

export interface Term {
  year: string; // "2026"
  term: string; // "HKD" | "HKG" | "HKC"
}

export interface ClassSession {
  key: string;
  term: string; // "2026HKC"
  subject: string;
  code: string; // course code, e.g. INF509041
  lhp: string; // class section, e.g. 26D1INF50904103
  start: string;
  end: string;
  periods: string;
  room: string;
  mode: string; // "TẬP TRUNG" | "ONLINE" | "LMS"
  teacher: string;
  email: string;
  address: string;
}

export interface Exam {
  key: string;
  term: string;
  subject: string;
  lhp: string;
  sbd: string;
  attempt: string;
  date: string; // "YYYY-MM-DD"
  time: string; // "HH:mm" or "" when the portal has no time
  room: string;
  campus: string;
  format: string;
  kind: string;
  note: string;
  address: string;
}

export interface Deadline {
  id: string; // Moodle event id
  title: string;
  course: string;
  type: "due" | "close" | "other";
  due: number; // epoch ms
  url: string;
  done: boolean;
}

// What the student portal page hands to the background worker.
export interface PortalPayload {
  terms: string[]; // terms fully read this round, e.g. ["2026HKC", "2027HKD"]
  exams?: Exam[];
  classes?: { sessions: ClassSession[]; from: Record<string, string> }; // from: first day read per term
}

// One LMS calendar event as read from the logged-in LMS.
export interface LmsEvent {
  id: string;
  name: string;
  type: string; // Moodle eventtype: due, close, open, course, user...
  course: string;
  due: number;
  url: string;
  done: boolean;
}

export interface LmsPayload {
  events: LmsEvent[];
  from: number;
  to: number;
  feed?: string;
}

export interface Plan {
  exams: boolean;
  classes: boolean;
  deadlines: boolean;
  feed: boolean;
}

export interface SyncReport {
  changed: Record<Source, number>;
  connected: boolean;
  nudge: boolean; // ask the student to connect Google Calendar
}

// What a background read of one site comes back with: what it read, or that UEH wants the student to sign in.
export type ReadResult = { payload: PortalPayload | LmsPayload | null } | { login: true } | null;

export type Message =
  | { type: "PLAN" }
  | { type: "READ"; site: Site; plan: Plan }
  | { type: "PORTAL"; payload: PortalPayload }
  | { type: "LMS"; payload: LmsPayload }
  | { type: "CONNECT" }
  | { type: "DISCONNECT" }
  | { type: "SYNC" }
  | { type: "TOGGLE"; source: Source; on: boolean }
  | { type: "ICS" }
  | { type: "OPEN_POPUP" };
