import { classColors, COLORS, colorHex, courseName, handIn, isOff, onlineExam, roomLabel, roomText } from "@/calendar";
import { Buddy } from "@/buddy";
import { atLocal, lapsed, load, SITE_NAMES, type Colors, type State } from "@/store";
import type { Message, Source } from "@/types";
import {
  MortarboardRegular,
  CheckRegular,
  CloseRegular,
  CopyRegular,
  DownloadRegular,
  ExitRegular,
  ExternalLinkRegular,
  Flag1Regular,
  HeartRegular,
  LeftRegular,
  More1Regular,
  PaletteRegular,
  PenRegular,
  Refresh2Regular,
  StarRegular,
} from "@mingcute/react/core-regular";
import { useEffect, useMemo, useState, type ReactNode } from "react";

const send = <T,>(message: Message) => chrome.runtime.sendMessage(message) as Promise<T>;

const PORTAL = "https://student.ueh.edu.vn/Home/Schedules";
const LMS = "https://lms.ueh.edu.vn/my/";
const REVIEW_URL =
  "https://chromewebstore.google.com/detail/unical/fiennkdjfbpjomlbeeoadaibellmooac/reviews";

const SOURCES: { id: Source; label: string; icon: ReactNode; open: string }[] = [
  { id: "classes", label: "Lịch học", icon: <MortarboardRegular />, open: PORTAL },
  { id: "exams", label: "Lịch thi", icon: <PenRegular />, open: PORTAL },
  { id: "deadlines", label: "Deadline", icon: <Flag1Regular />, open: LMS },
];

const BRAND = "#4C7CF0";
// Each kind's colour in the popup is the one its events get in Google Calendar. Classes coloured per course
// show the brand blue as a kind, and each course's own colour on its row.
const toneOf = (colors: Colors): Record<Source, string> => ({
  classes: colors.classes === "course" ? BRAND : colorHex(colors.classes),
  exams: colorHex(colors.exams),
  deadlines: colorHex(colors.deadlines),
});

// Google's settings page for one calendar, where it can be deleted.
const calendarSettings = (id: string, email: string) =>
  `https://calendar.google.com/calendar/r/settings/calendar/${btoa(id).replace(/=+$/, "")}?authuser=${encodeURIComponent(email)}`;

// Soft brand-tinted shadows only, never grey or black.
const LIFT = "shadow-lift ring-1 ring-edge";

const WEEKDAYS = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"];

function when(ms: number, allDay = false): string {
  const d = new Date(ms + 7 * 3600_000); // Vietnam time
  const p = (n: number) => String(n).padStart(2, "0");
  const day = `${WEEKDAYS[d.getUTCDay()]} ${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}`;
  return allDay ? day : `${day} · ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

const DAY = 86400_000;
const vnDay = (ms: number) => Math.floor((ms + 7 * 3600_000) / DAY);

function until(ms: number, allDay = false): string {
  if (allDay) {
    const days = vnDay(ms) - vnDay(Date.now());
    return days <= 0 ? "Hôm nay" : days === 1 ? "Ngày mai" : `${days} ngày`;
  }
  const min = Math.round((ms - Date.now()) / 60_000);
  if (min < 60) return `${Math.max(min, 1)} phút`;
  if (min < 48 * 60) return `${Math.round(min / 60)} giờ`;
  return `${Math.round(min / 1440)} ngày`;
}

function ago(ms?: number): string {
  if (!ms) return "";
  const min = Math.round((Date.now() - ms) / 60_000);
  if (min < 1) return "vừa xong";
  if (min < 60) return `${min} phút trước`;
  if (min < 24 * 60) return `${Math.round(min / 60)} giờ trước`;
  if (min < 48 * 60) return "hôm qua";
  return `${Math.round(min / 1440)} ngày trước`;
}

// Whether UniCal sits on the toolbar, where its "!" shows when the student needs to sign in again.
function usePinned(): boolean {
  const [pinned, setPinned] = useState(true);
  useEffect(() => {
    const action = chrome.action as typeof chrome.action & {
      getUserSettings?: () => Promise<{ isOnToolbar: boolean }>;
      onUserSettingsChanged?: chrome.events.Event<(s: { isOnToolbar: boolean }) => void>;
    };
    action.getUserSettings?.().then((s) => setPinned(s.isOnToolbar)).catch(() => {});
    const changed = (s: { isOnToolbar: boolean }) => setPinned(s.isOnToolbar);
    action.onUserSettingsChanged?.addListener(changed);
    return () => action.onUserSettingsChanged?.removeListener(changed);
  }, []);
  return pinned;
}

function useStoredState(initial: State): State {
  const [state, setState] = useState(initial);
  useEffect(() => {
    const refresh = () => load().then(setState);
    chrome.storage.onChanged.addListener(refresh);
    return () => chrome.storage.onChanged.removeListener(refresh);
  }, []);
  return state;
}

export default function App({ initial }: { initial: State }) {
  const s = useStoredState(initial);
  const pinned = usePinned();
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<"main" | "donate" | "colors">("main");
  const tone = toneOf(s.colors);
  // A 1.x calendar may have been deleted since the last sync: look again so the reminder goes away.
  useEffect(() => {
    if (initial.oldCalendars.length) send({ type: "OLD" });
  }, [initial.oldCalendars.length]);
  const [asking, setAsking] = useState<Source | null>(null);

  const connected = Boolean(s.account) && s.problem !== "auth" && s.problem !== "scope";
  // A read or sync is running, here or in the background (a stuck flag stops counting after a few minutes).
  const syncing = busy || (s.busy > 0 && Date.now() - s.busy < 5 * 60_000);

  const counts = useMemo(() => {
    const now = Date.now();
    return {
      classes: s.data.classes.filter((c) => !isOff(c) && atLocal(c.start) > now).length,
      exams: s.data.exams.filter((e) => atLocal(`${e.date}T${e.time || "23:59"}`) > now).length,
      deadlines: s.data.deadlines.filter((d) => !d.done && d.due > now).length,
    };
  }, [s.data]);

  const upcoming = useMemo(() => {
    const now = Date.now();
    const nextClass = s.data.classes
      .filter((c) => !isOff(c) && atLocal(c.start) > now)
      .sort((a, b) => a.start.localeCompare(b.start))[0];
    const on = s.settings;
    return [
      ...(on.classes && nextClass
        ? [{
            key: nextClass.key,
            source: "classes" as Source,
            color: colorHex(classColors(s.data.classes, s.subjects, s.colors).get(`${nextClass.term}|${nextClass.subject}`) ?? ""),
            title: nextClass.subject,
            detail: nextClass.room ? roomText(nextClass.room) : /^t[aậ]p trung$/i.test(nextClass.mode.trim()) ? "" : roomLabel(nextClass.mode),
            at: atLocal(nextClass.start),
            allDay: false,
            url: PORTAL,
          }]
        : []),
      ...(on.exams ? s.data.exams : []).map((e) => ({
        key: e.key,
        source: "exams" as Source,
        color: tone.exams,
        title: e.subject,
        detail: handIn(e) ? e.kind || e.format : onlineExam(e) ? "Trực tuyến" : e.room ? roomText(e.room) : e.format,
        at: atLocal(`${e.date}T${e.time || "00:00"}`),
        allDay: !e.time,
        url: "https://student.ueh.edu.vn/Home/Exam",
      })),
      ...(on.deadlines ? s.data.deadlines : [])
        .filter((d) => !d.done)
        .map((d) => ({
          key: d.id,
          source: "deadlines" as Source,
          color: tone.deadlines,
          title: d.title,
          detail: courseName(d.course, s.subjects),
          at: d.due,
          allDay: false,
          url: d.url,
        })),
    ]
      .filter((i) => (i.allDay ? i.at + 86400_000 : i.at) > now)
      .sort((a, b) => a.at - b.at)
      .slice(0, 5);
  }, [s.data, s.subjects, s.settings, s.colors]);

  const run = async (message: Message) => {
    setBusy(true);
    try {
      await send(message);
    } finally {
      setBusy(false);
    }
  };

  const downloadIcs = async () => {
    const text = await send<string>({ type: "ICS" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([text], { type: "text/calendar" }));
    link.download = "unical-ueh.ics";
    link.click();
    URL.revokeObjectURL(link.href);
  };

  if (view === "donate") return <Donate onClose={() => setView("main")} />;
  if (view === "colors")
    return <ColorPicker colors={s.colors} onChange={(colors) => send({ type: "COLORS", colors })} onClose={() => setView("main")} />;

  const menu = (
    <Menu
      account={s.account}
      onIcs={downloadIcs}
      onDonate={() => setView("donate")}
      onColors={() => setView("colors")}
      onSignOut={() => run({ type: "DISCONNECT" })}
    />
  );

  if (!connected) {
    return (
      <div
        className="relative flex w-[360px] select-none flex-col bg-signin bg-cover bg-no-repeat text-ink"
        style={{ backgroundImage: "url(art/signin.webp)", backgroundPosition: "50% calc(100% + 34px)" }}
      >
        <Header>{menu}</Header>
        <section className={`relative z-10 mx-3 mt-1 rounded-[24px] bg-raised p-4 text-center ${LIFT}`}>
          <div className="mb-4 flex justify-center gap-1.5">
            {SOURCES.map((src) => (
              <div
                key={src.id}
                className="relative flex items-center gap-1.5 rounded-full py-1.5 pl-2 pr-3 text-[12px] font-medium [&_svg]:h-3.5 [&_svg]:w-3.5"
                style={{ background: `${tone[src.id]}14`, color: tone[src.id] }}
              >
                {src.icon}
                <span className="text-ink">{src.label}</span>
                {counts[src.id] > 0 && (
                  <span className="absolute -right-1.5 -top-2 h-4 min-w-4 rounded-full bg-ink px-1 text-center text-[10px] font-semibold leading-4 tabular-nums text-page ring-2 ring-raised">
                    {counts[src.id]}
                  </span>
                )}
              </div>
            ))}
          </div>
          {s.account && s.problem === "auth" && (
            <p className="-mt-1 mb-3 text-[12.5px] font-medium text-warn">Google Calendar đã ngưng cập nhật</p>
          )}
          <button
            onClick={() => run({ type: "CONNECT" })}
            disabled={busy}
            className="flex h-12 w-full items-center justify-center gap-2.5 rounded-full bg-ink px-5 text-[15px] font-medium text-page transition hover:bg-ink/85 active:scale-[0.97] disabled:opacity-60"
          >
            <span className="flex h-6 w-6 flex-none items-center justify-center rounded-full bg-white">
              <GoogleMark />
            </span>
            {s.account ? "Kết nối lại Google Calendar" : "Kết nối Google Calendar"}
          </button>
          {s.problem === "scope" && (
            <p className="mt-3 text-balance rounded-2xl bg-warn-bg px-3 py-2 text-[12px] leading-relaxed text-warn-ink">
              Nhớ bấm “Chọn tất cả” khi cấp quyền rồi thử lại nha
            </p>
          )}
          {syncing && !Object.values(s.seen).some(Boolean) && (
            <p className="mt-3 text-[12px] leading-relaxed text-muted">Đang đọc lịch từ UEH…</p>
          )}
          {!syncing && !Object.values(s.seen).some(Boolean) && (
            <p className="mt-3 text-balance text-[12px] leading-relaxed text-muted">
              Đăng nhập{" "}
              <a href={PORTAL} target="_blank" className="font-medium text-brand hover:underline">UEH Student</a> và{" "}
              <a href={LMS} target="_blank" className="font-medium text-brand hover:underline">LMS</a> một lần, sau đó UniCal tự cập nhật
            </p>
          )}
        </section>
        {/* The scene starts right under the card: hills, the path and Buddy on the cliff. */}
        <div className="relative h-[260px]">
          <div className="pointer-events-none absolute bottom-[110px] left-[56px] w-[68px]">
            <span className="absolute bottom-0 left-1/2 h-2 w-14 -translate-x-1/2 rounded-[50%] bg-[#0B7285]/25" />
            <Buddy size={68} look={{ x: 0.55, y: -0.75 }} className="relative block motion-safe:animate-bob" />
          </div>
          {!pinned && (
            <p className={`absolute inset-x-3 bottom-3 rounded-2xl bg-raised/95 px-3 py-2 text-center text-[12px] leading-relaxed text-muted backdrop-blur ${LIFT}`}>
              <span className="block font-medium text-ink">Ghim UniCal để thấy khi cần đăng nhập lại</span>
              Bấm <ChromeIcon d={PUZZLE} /> ở góc trên, rồi bấm <ChromeIcon d={PIN} /> cạnh UniCal
            </p>
          )}
        </div>
      </div>
    );
  }

  const signIn = lapsed(s).map((site) => SITE_NAMES[site]);
  const everRead = Object.values(s.seen).some(Boolean);
  const read = (id: Source) =>
    id === "deadlines" ? Math.max(s.seen.deadlines ?? 0, s.seen.feed ?? 0) : s.seen[id] ?? 0;
  // How current the calendar is: Google writes count only as far as UEH was read. Worth a colour after a day.
  const reading = SOURCES.filter((src) => s.settings[src.id] && read(src.id) > 0).length;
  const behind = SOURCES.filter((src) => s.settings[src.id] && read(src.id) > 0)
    .map((src) => read(src.id))
    .filter((t) => Date.now() - t > DAY);
  const anyOn = SOURCES.some((src) => s.settings[src.id]);
  const allBehind = reading > 0 && behind.length === reading;
  const cap = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

  return (
    <div className="relative w-[360px] select-none overflow-hidden bg-page text-ink">
      <Glow />
      <Header>
        <button
          onClick={() => run({ type: "SYNC" })}
          disabled={syncing}
          title="Đồng bộ ngay"
          aria-label={`Đồng bộ ngay · ${allBehind ? ago(Math.min(...behind)) : ago(s.synced)}`}
          className="flex h-8 items-center gap-1.5 rounded-full px-2.5 text-[12px] text-muted transition hover:bg-soft hover:text-ink disabled:hover:bg-transparent"
        >
          {syncing ? (
            <span>Đang đồng bộ</span>
          ) : s.problem === "google" ? (
            <span className="text-danger">Chưa đồng bộ được</span>
          ) : allBehind ? (
            <span className="text-warn">{cap(ago(Math.min(...behind)))}</span>
          ) : (
            everRead && <span>{cap(ago(s.synced))}</span>
          )}
          <Refresh2Regular className={`h-4 w-4 ${syncing ? "animate-spin" : ""}`} />
        </button>
        {menu}
      </Header>

      <main className="relative px-3 pb-3">
        {s.oldCalendars.length > 0 && s.account && (
          <a
            href={calendarSettings(s.oldCalendars[0]!.id, s.account.email)}
            target="_blank"
            className="mb-2 flex items-center gap-2 rounded-2xl bg-warn-bg px-3 py-2.5 text-[12.5px] text-warn-ink"
          >
            <span className="min-w-0 flex-1 truncate">
              {s.oldCalendars.length > 1 ? `${s.oldCalendars.length} lịch cũ đang bị trùng` : `Lịch cũ “${s.oldCalendars[0]!.name}” đang bị trùng`}
            </span>
            <span className="flex-none font-semibold underline underline-offset-2">Xoá</span>
          </a>
        )}
        {signIn.length > 0 && (
          <div className="mb-2 flex items-center gap-2 rounded-2xl bg-warn-bg py-1.5 pl-3 pr-1.5 text-[12.5px] leading-snug text-warn-ink">
            <span className="min-w-0 flex-1">
              {everRead ? "UEH cần bạn bấm “Tiếp tục”" : `Đăng nhập ${signIn.join(" và ")} một lần`}
            </span>
            <button
              onClick={() => send({ type: "REENTER" }).finally(() => window.close())}
              className="h-8 flex-none rounded-full bg-ink px-3.5 text-[12.5px] font-medium text-page transition hover:bg-ink/85 active:scale-[0.97]"
            >
              Mở UEH
            </button>
          </div>
        )}

        {upcoming.length > 0 ? (
          <ul className="mb-2">
            {upcoming.map((item) => (
              <li key={item.key}>
                <a href={item.url} target="_blank" title={item.title} className="flex items-center gap-3 rounded-2xl px-3 py-2 transition hover:bg-soft">
                  <Tile source={item.source} color={item.color} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] font-medium tracking-[-0.01em]">{item.title}</span>
                    <span className="block truncate text-[11.5px] text-muted">
                      {when(item.at, item.allDay)}
                      {item.detail ? ` · ${item.detail}` : ""}
                    </span>
                  </span>
                  <span className="flex-none text-[12px] font-medium tabular-nums text-muted">{until(item.at, item.allDay)}</span>
                </a>
              </li>
            ))}
          </ul>
        ) : !anyOn ? null : signIn.length ? (
          <div className="flex justify-center pb-4 pt-2">
            <Buddy mood="alert" size={56} />
          </div>
        ) : (
          <div className="flex flex-col items-center pb-5 pt-3">
            {everRead ? (
              <>
                <Buddy mood="sleepy" size={56} />
                <p className="mt-2 text-[12.5px] text-muted">Chưa có gì sắp tới. Thảnh thơi nha</p>
              </>
            ) : syncing ? (
              <>
                <Buddy size={56} className="motion-safe:animate-bob" />
                <p className="mt-2 text-[12.5px] text-muted">Đang đọc lịch từ UEH…</p>
              </>
            ) : (
              <>
                <Buddy mood="alert" size={56} />
                <p className="mt-2 text-[12.5px] text-muted">Chưa đọc được lịch UEH, thử đồng bộ lại nha</p>
              </>
            )}
          </div>
        )}

        <section className="rounded-[20px] bg-soft p-1.5">
          {SOURCES.map((src) => {
            const seen = read(src.id);
            const on = s.settings[src.id];
            // Only worth a word when UEH hasn't been read for a day, and when the header doesn't already say it all.
            const stale = on && seen > 0 && Date.now() - seen > DAY && !allBehind;
            const toggle = (value: boolean) => send({ type: "TOGGLE", source: src.id, on: value });
            if (asking === src.id) {
              return (
                <div key={src.id} className="flex items-center gap-2 rounded-2xl bg-raised px-1.5 py-1.5">
                  <Tile source={src.id} color={tone[src.id]} solid />
                  <span className="min-w-0 flex-1 truncate text-[12.5px]">Xóa khỏi Google Calendar?</span>
                  <button
                    onClick={() => setAsking(null)}
                    className="h-7 rounded-full px-2.5 text-[12.5px] font-medium text-muted transition hover:bg-soft hover:text-ink"
                  >
                    Hủy
                  </button>
                  <button
                    onClick={() => {
                      setAsking(null);
                      toggle(false);
                    }}
                    className="h-7 rounded-full bg-[#D92D20] px-3 text-[12.5px] font-medium text-white transition hover:bg-[#B42318]"
                  >
                    Xóa
                  </button>
                </div>
              );
            }
            return (
              <div key={src.id} className="flex items-center gap-3 rounded-2xl px-1.5 py-1.5">
                <div
                  className="flex h-8 w-8 flex-none items-center justify-center rounded-xl transition-colors [&_svg]:h-4 [&_svg]:w-4"
                  style={on ? { background: tone[src.id], color: "#fff" } : { background: "rgb(var(--line))", color: "rgb(var(--faint))" }}
                >
                  {src.icon}
                </div>
                <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
                  <span className="text-[13.5px] font-medium tracking-[-0.01em]">{src.label}</span>
                  {on && counts[src.id] > 0 && (
                    <span className="text-[12px] tabular-nums text-faint">{counts[src.id]}</span>
                  )}
                  {stale && <span className="truncate text-[11.5px] text-warn">· {ago(seen)}</span>}
                </div>
                <Switch
                  on={on}
                  color={tone[src.id]}
                  label={src.label}
                  onChange={(value) => (!value && s.calendars[src.id] ? setAsking(src.id) : toggle(value))}
                />
              </div>
            );
          })}
        </section>

        <a
          href={`https://calendar.google.com/calendar/r?authuser=${encodeURIComponent(s.account?.email ?? "")}`}
          target="_blank"
          className={`mt-3 flex h-11 items-center justify-center gap-1.5 rounded-full bg-raised text-[14px] font-medium text-ink transition hover:-translate-y-0.5 active:scale-[0.97] ${LIFT}`}
        >
          Mở Google Calendar
          <ExternalLinkRegular size={16} color="currentColor" className="text-brand" />
        </a>
      </main>
    </div>
  );
}

// What kind of item a row is, by icon as well as colour.
// `solid`: the filled look of the switch rows.
function Tile({ source, color, solid = false }: { source: Source; color: string; solid?: boolean }) {
  const src = SOURCES.find((x) => x.id === source)!;
  return (
    <span
      className="flex h-8 w-8 flex-none items-center justify-center rounded-xl [&_svg]:h-4 [&_svg]:w-4"
      style={solid ? { background: color, color: "#fff" } : { background: `${color}1A`, color }}
    >
      {src.icon}
    </span>
  );
}

function Header({ children }: { children: ReactNode }) {
  return (
    <header className="relative z-20 flex items-center justify-between px-6 py-3">
      <a href="https://unical.tadyuh.dev" target="_blank" className="flex items-center gap-2">
        <Buddy size={28} />
        <span className="text-[16px] font-semibold tracking-[-0.02em]">UniCal</span>
      </a>
      <div className="flex items-center gap-1">{children}</div>
    </header>
  );
}

// Flat page with two soft, blurred brand glows, like the website: blue drifting in from the top right toward
// the middle, violet from the left, overlapping along the diagonal.
function Glow() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      <div className="absolute -right-10 -top-10 h-64 w-64 rounded-full blur-3xl" style={{ background: "var(--glow-a)" }} />
      <div className="absolute -left-10 top-48 h-56 w-56 rounded-full blur-3xl" style={{ background: "var(--glow-b)" }} />
    </div>
  );
}

function Menu({
  account,
  onIcs,
  onDonate,
  onColors,
  onSignOut,
}: {
  account: State["account"];
  onIcs: () => void;
  onDonate: () => void;
  onColors: () => void;
  onSignOut: () => void;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [open]);
  const item =
    "flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-[13px] text-ink transition hover:bg-soft [&_svg]:h-4 [&_svg]:w-4";
  const pick = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };
  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        title={account?.email ?? "Thêm"}
        aria-label={account?.email ?? "Thêm"}
        aria-expanded={open}
        aria-haspopup="menu"
        className={`flex h-8 w-8 items-center justify-center rounded-full transition ${
          account ? "ring-1 ring-brand/15 hover:ring-2 hover:ring-brand/25" : "bg-raised/70 text-muted hover:bg-raised hover:text-ink"
        }`}
      >
        {account?.picture ? (
          <img src={account.picture} alt="" className="h-8 w-8 rounded-full" />
        ) : account ? (
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-soft text-[12px] font-semibold text-brand">
            {account.name.charAt(0).toUpperCase()}
          </span>
        ) : (
          <More1Regular className="h-[18px] w-[18px]" />
        )}
      </button>
      {open && (
        <>
          <button aria-hidden tabIndex={-1} className="fixed inset-0 z-20 cursor-default" onClick={() => setOpen(false)} />
          <div className={`absolute right-0 top-10 z-30 w-56 rounded-[20px] bg-raised p-1.5 ${LIFT}`}>
            {account && (
              <div className="mb-1 truncate border-b border-line px-2.5 pb-2 pt-1 text-[12px] text-muted">{account.email}</div>
            )}
            <button onClick={pick(onColors)} className={item}>
              <PaletteRegular color="currentColor" />
              Màu sắc
            </button>
            <button onClick={pick(onIcs)} className={item}>
              <DownloadRegular color="currentColor" />
              Tải lịch (.ics)
            </button>
            <a href={REVIEW_URL} target="_blank" onClick={() => setOpen(false)} className={item}>
              <StarRegular color="currentColor" />
              Đánh giá
            </a>
            <button onClick={pick(onDonate)} className={item}>
              <HeartRegular color="currentColor" />
              Ủng hộ
            </button>
            {account && (
              <button onClick={pick(onSignOut)} className={item}>
                <ExitRegular color="currentColor" />
                Ngắt kết nối
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Switch({
  on,
  color,
  label,
  onChange,
}: {
  on: boolean;
  color: string;
  label: string;
  onChange: (on: boolean) => void;
}) {
  return (
    <button
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className="relative h-5 w-9 flex-none rounded-full transition-colors"
      style={{ background: on ? color : "rgb(var(--track))" }}
    >
      <span
        className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${on ? "left-[18px]" : "left-0.5"}`}
      />
    </button>
  );
}

// Event colours, from Google Calendar's own list. Classes can instead take one colour per course.
const COURSE_DOT = "conic-gradient(#039BE5, #33B679, #F6BF26, #E67C73, #8E24AA, #3F51B5, #039BE5)";

function ColorPicker({ colors, onChange, onClose }: { colors: Colors; onChange: (colors: Colors) => void; onClose: () => void }) {
  const tone = toneOf(colors);
  const perCourse = colors.classes === "course";
  return (
    <div className="relative w-[360px] select-none overflow-hidden bg-page pb-3 text-ink">
      <Glow />
      <header className="relative flex items-center gap-1 px-3 py-3">
        <button
          onClick={onClose}
          aria-label="Quay lại"
          className="flex h-8 w-8 items-center justify-center rounded-full text-muted transition hover:bg-soft hover:text-ink"
        >
          <LeftRegular className="h-[18px] w-[18px]" />
        </button>
        <span className="text-[15px] font-semibold tracking-[-0.01em]">Màu sắc</span>
      </header>
      <section className="relative mx-3 rounded-[20px] bg-soft p-1.5">
        {SOURCES.map((src) => {
          const value = colors[src.id];
          return (
            <div key={src.id} className="rounded-2xl px-1.5 pb-2.5 pt-1.5">
              <div className="flex h-8 items-center gap-3">
                <Tile source={src.id} color={tone[src.id]} solid />
                <span className="text-[13.5px] font-medium tracking-[-0.01em]">{src.label}</span>
                {src.id === "classes" ? (
                  <button
                    aria-pressed={perCourse}
                    onClick={() => onChange({ ...colors, classes: "course" })}
                    className={`ml-auto flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[12px] font-medium transition ${
                      perCourse ? `bg-raised text-ink ${LIFT}` : "text-muted hover:bg-raised/70 hover:text-ink"
                    }`}
                  >
                    <span className="h-3 w-3 rounded-full" style={{ background: COURSE_DOT }} />
                    Mỗi môn một màu
                  </button>
                ) : (
                  <span className="ml-auto text-[12px] text-muted">{COLORS.find((c) => c.id === value)?.name}</span>
                )}
              </div>
              <div role="radiogroup" aria-label={src.label} className="mt-2.5 flex justify-between px-1">
                {COLORS.map((c) => {
                  const picked = c.id === value;
                  return (
                    <button
                      key={c.id}
                      role="radio"
                      aria-checked={picked}
                      aria-label={c.name}
                      title={c.name}
                      onClick={() => onChange({ ...colors, [src.id]: c.id })}
                      className={`flex h-[22px] w-[22px] items-center justify-center rounded-full transition hover:scale-110 ${
                        picked ? "ring-2 ring-offset-2 ring-offset-soft" : ""
                      }`}
                      style={{ background: c.hex, ["--tw-ring-color" as string]: c.hex }}
                    >
                      {picked && <CheckRegular color="#fff" className="h-3 w-3" />}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </section>
    </div>
  );
}

function Donate({ onClose }: { onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative w-[360px] select-none overflow-hidden bg-page px-6 pb-6 pt-3 text-center text-ink">
      <Glow />
      <div className="relative flex justify-end">
        <button
          onClick={onClose}
          aria-label="Đóng"
          className="flex h-8 w-8 items-center justify-center rounded-full text-muted transition hover:bg-soft hover:text-ink"
        >
          <CloseRegular className="h-[18px] w-[18px]" />
        </button>
      </div>
      <div className="relative">
        <Buddy mood="cheer" size={52} className="mx-auto -mb-3" />
        <img src="donate_qr.png" alt="" className={`relative mx-auto h-52 w-52 rounded-[24px] bg-white object-contain p-3 ${LIFT}`} />
        <div className="mt-5 text-[12px] font-medium tracking-[0.04em] text-muted">HUONG DAT HUY</div>
        <button
          onClick={() => {
            navigator.clipboard.writeText("8888070605");
            setCopied(true);
          }}
          className="mx-auto mt-1.5 flex h-10 items-center gap-2 rounded-full bg-soft px-4 text-[15px] font-semibold tabular-nums tracking-[0.02em] transition hover:bg-brand-soft"
        >
          8888070605
          {copied ? (
            <CheckRegular size={16} color="#16A34A" />
          ) : (
            <CopyRegular size={16} color="currentColor" className="text-faint" />
          )}
        </button>
        <p className="mt-3 text-[12.5px] text-muted">Cảm ơn bạn nhiều 💙</p>
      </div>
    </div>
  );
}

// The browser's own toolbar icons (Google's Material Symbols, as Chrome draws them): the extensions puzzle
// piece, and the pin beside each extension in its menu.
const PUZZLE =
  "M200-200h520v-184l45-22q16-8 25.5-22t9.5-32q0-17-9.5-31.5T765-514l-45-21v-185H528l-10-68q-3-22-19.5-37T460-840q-23 0-39.5 15T401-788l-10 68H200v86q56 21 88 68t32 106q0 60-32 107t-88 68v85Zm0 80q-34 0-57-23t-23-57v-152q48 0 84-30.5t36-77.5q0-46-36-76t-84-32v-152q0-33 23.5-56.5T200-800h122q7-51 46-85.5t92-34.5q52 0 91 34.5t47 85.5h122q33 0 56.5 23.5T800-720v134q36 18 58 52t22 74q0 41-22 75t-58 51v134q0 34-23.5 57T720-120H200Zm300-340Z";
const PIN = "m640-480 80 80v80H520v240l-40 40-40-40v-240H240v-80l80-80v-280h-40v-80h400v80h-40v280Zm-286 80h252l-46-46v-314H400v314l-46 46Zm126 0Z";

function ChromeIcon({ d }: { d: string }) {
  return (
    <svg viewBox="0 -960 960 960" aria-hidden className="mx-px inline-block h-[15px] w-[15px] align-[-3px]" fill="#444746">
      <path d={d} />
    </svg>
  );
}

// Google's own mark, kept in its brand colours as Google's sign-in guidelines require.
function GoogleMark() {
  return (
    <svg viewBox="0 0 48 48" className="h-4 w-4" aria-hidden>
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}
