import { courseName } from "@/calendar";
import { Buddy } from "@/buddy";
import { DEFAULTS, atLocal, load, type State } from "@/store";
import type { Message, Source } from "@/types";
import {
  BookRegular,
  CheckRegular,
  CloseRegular,
  CopyRegular,
  DownloadRegular,
  ExitRegular,
  ExternalLinkRegular,
  Flag1Regular,
  HeartRegular,
  More1Regular,
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

const SOURCES: { id: Source; label: string; color: string; icon: ReactNode; open: string }[] = [
  { id: "classes", label: "Lịch học", color: "#4C7CF0", icon: <BookRegular />, open: PORTAL },
  { id: "exams", label: "Lịch thi", color: "#EF5350", icon: <PenRegular />, open: PORTAL },
  { id: "deadlines", label: "Deadline", color: "#F59E0B", icon: <Flag1Regular />, open: LMS },
];

// Soft brand-tinted shadows only, never grey or black.
const LIFT = "shadow-[0_18px_40px_-18px_rgba(79,127,239,0.45)] ring-1 ring-[#4F7FEF]/10";

const WEEKDAYS = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"];

function when(ms: number): string {
  const d = new Date(ms + 7 * 3600_000); // Vietnam time
  const p = (n: number) => String(n).padStart(2, "0");
  return `${WEEKDAYS[d.getUTCDay()]} ${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)} · ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

function until(ms: number): string {
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
  if (min < 48 * 60) return `${Math.round(min / 60)} giờ trước`;
  return `${Math.round(min / 1440)} ngày trước`;
}

function useStoredState(): State | null {
  const [state, setState] = useState<State | null>(null);
  useEffect(() => {
    const refresh = () => load().then(setState);
    refresh();
    chrome.storage.onChanged.addListener(refresh);
    return () => chrome.storage.onChanged.removeListener(refresh);
  }, []);
  return state;
}

export default function App() {
  const state = useStoredState();
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<"main" | "donate">("main");

  const s = state ?? DEFAULTS;
  const connected = Boolean(s.account) && s.problem !== "auth";

  const counts = useMemo(() => {
    const now = Date.now();
    return {
      classes: s.data.classes.filter((c) => atLocal(c.start) > now).length,
      exams: s.data.exams.filter((e) => atLocal(`${e.date}T${e.time || "23:59"}`) > now).length,
      deadlines: s.data.deadlines.filter((d) => !d.done && d.due > now).length,
    };
  }, [s.data]);

  const upcoming = useMemo(() => {
    const now = Date.now();
    const nextClass = s.data.classes
      .filter((c) => atLocal(c.start) > now)
      .sort((a, b) => a.start.localeCompare(b.start))[0];
    return [
      ...(nextClass
        ? [{
            key: nextClass.key,
            color: "#4C7CF0",
            title: nextClass.subject,
            detail: nextClass.room || nextClass.mode,
            at: atLocal(nextClass.start),
            url: PORTAL,
          }]
        : []),
      ...s.data.exams.map((e) => ({
        key: e.key,
        color: "#EF5350",
        title: `Thi · ${e.subject}`,
        detail: e.room,
        at: atLocal(`${e.date}T${e.time || "00:00"}`),
        url: "https://student.ueh.edu.vn/Home/Exam",
      })),
      ...s.data.deadlines
        .filter((d) => !d.done)
        .map((d) => ({
          key: d.id,
          color: "#F59E0B",
          title: d.title,
          detail: courseName(d.course, s.subjects),
          at: d.due,
          url: d.url,
        })),
    ]
      .filter((i) => i.at > now)
      .sort((a, b) => a.at - b.at)
      .slice(0, 5);
  }, [s.data, s.subjects]);

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

  if (!state) return <div className="h-[420px] w-[360px] bg-white" />;
  if (view === "donate") return <Donate onClose={() => setView("main")} />;

  const menu = (
    <Menu
      account={s.account}
      onIcs={downloadIcs}
      onDonate={() => setView("donate")}
      onSignOut={() => run({ type: "DISCONNECT" })}
    />
  );

  if (!connected) {
    return (
      <div
        className="relative flex h-[540px] w-[360px] select-none flex-col bg-[#E8F0FF] bg-cover bg-bottom text-[#0F1424]"
        style={{ backgroundImage: "url(art/signin.webp)" }}
      >
        <Header>{menu}</Header>
        <section className={`relative z-10 mx-4 mt-1 rounded-[24px] bg-white p-4 text-center ${LIFT}`}>
          <div className="mb-4 flex justify-center gap-1.5">
            {SOURCES.map((src) => (
              <div
                key={src.id}
                className="relative flex items-center gap-1.5 rounded-full py-1.5 pl-2 pr-3 text-[12px] font-medium [&_svg]:h-3.5 [&_svg]:w-3.5"
                style={{ background: `${src.color}14`, color: src.color }}
              >
                {src.icon}
                <span className="text-[#0F1424]">{src.label}</span>
                {counts[src.id] > 0 && (
                  <span className="absolute -right-1.5 -top-2 h-4 min-w-4 rounded-full bg-[#0F1424] px-1 text-center text-[10px] font-semibold leading-4 tabular-nums text-white ring-2 ring-white">
                    {counts[src.id]}
                  </span>
                )}
              </div>
            ))}
          </div>
          <button
            onClick={() => run({ type: "CONNECT" })}
            disabled={busy}
            className="flex h-12 w-full items-center justify-center gap-2.5 rounded-full bg-[#0F1424] px-5 text-[15px] font-medium text-white transition hover:bg-[#0F1424]/85 active:scale-[0.97] disabled:opacity-60"
          >
            <span className="flex h-6 w-6 flex-none items-center justify-center rounded-full bg-white">
              <GoogleMark />
            </span>
            {s.problem === "auth" ? "Kết nối lại Google Calendar" : "Kết nối Google Calendar"}
          </button>
          {s.problem === "scope" && (
            <p className="mt-3 text-balance rounded-2xl bg-[#FFF6E5] px-3 py-2 text-[12px] leading-relaxed text-[#8A5300]">
              Nhớ tick ô Google Calendar lúc cấp quyền rồi thử lại nha
            </p>
          )}
          <p className="mt-3 text-balance text-[12px] leading-relaxed text-[#667085]">
            Đăng nhập{" "}
            <a href={PORTAL} target="_blank" className="font-medium text-[#4F7FEF] hover:underline">UEH Student</a> và{" "}
            <a href={LMS} target="_blank" className="font-medium text-[#4F7FEF] hover:underline">LMS</a> một lần, sau đó UniCal tự cập nhật
          </p>
        </section>
        <div className="pointer-events-none absolute left-[56px] top-[328px] w-[68px]">
          <span className="absolute bottom-0 left-1/2 h-2 w-14 -translate-x-1/2 rounded-[50%] bg-[#0B7285]/25" />
          <Buddy size={68} look={{ x: 0.55, y: -0.75 }} className="relative block motion-safe:animate-bob" />
        </div>
      </div>
    );
  }

  return (
    <div className="relative w-[360px] select-none overflow-hidden bg-white text-[#0F1424]">
      <Glow />
      <Header>
        <button
          onClick={() => run({ type: "SYNC" })}
          disabled={busy}
          title="Đồng bộ ngay"
          className="flex h-8 items-center gap-1.5 rounded-full px-2.5 text-[12px] text-[#667085] transition hover:bg-[#F3F6FC] hover:text-[#0F1424]"
        >
          {s.problem === "google" ? (
            <span className="text-[#EF5350]">Chưa được, thử lại nha</span>
          ) : (
            <span>{busy ? "Đang đồng bộ" : ago(s.synced)}</span>
          )}
          <Refresh2Regular className={`h-4 w-4 ${busy ? "animate-spin" : ""}`} />
        </button>
        {menu}
      </Header>

      <main className="relative px-3 pb-3">
        {upcoming.length > 0 ? (
          <ul className="mb-2">
            {upcoming.map((item) => (
              <li key={item.key}>
                <a href={item.url} target="_blank" className="flex items-center gap-3 rounded-2xl px-2 py-2 transition hover:bg-[#F3F6FC]">
                  <span className="h-8 w-1 flex-none rounded-full" style={{ background: item.color }} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] font-medium tracking-[-0.01em]">{item.title}</span>
                    <span className="block truncate text-[11.5px] text-[#667085]">
                      {when(item.at)}
                      {item.detail ? ` · ${item.detail}` : ""}
                    </span>
                  </span>
                  <span className="flex-none text-[12px] font-medium tabular-nums text-[#98A2B3]">{until(item.at)}</span>
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <div className="flex flex-col items-center pb-5 pt-3">
            <Buddy mood="sleepy" size={56} />
            <p className="mt-2 text-[12.5px] text-[#667085]">Chưa có gì sắp tới. Thảnh thơi nha</p>
          </div>
        )}

        <section className="rounded-[20px] bg-[#F3F6FC] p-1.5">
          {SOURCES.map((src) => {
            const seen =
              src.id === "deadlines"
                ? Math.max(s.seen.deadlines ?? 0, s.seen.feed ?? 0)
                : s.seen[src.id];
            const on = s.settings[src.id];
            // UEH signed the student out: only they can sign back in (deadlines still come via the private link)
            const site = src.id === "deadlines" ? "lms" : "portal";
            const signIn = s.login[site] && (src.id !== "deadlines" || !s.feed);
            return (
              <div key={src.id} className="flex items-center gap-3 rounded-2xl px-2 py-2">
                <div
                  className="flex h-8 w-8 flex-none items-center justify-center rounded-xl text-white transition-colors [&_svg]:h-4 [&_svg]:w-4"
                  style={{ background: on ? src.color : "#D0D5DD" }}
                >
                  {src.icon}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-[13.5px] font-medium tracking-[-0.01em]">{src.label}</span>
                    {counts[src.id] > 0 && (
                      <span className="text-[12px] tabular-nums text-[#98A2B3]">{counts[src.id]}</span>
                    )}
                  </div>
                  {signIn ? (
                    <a href={src.open} target="_blank" className="text-[11.5px] font-medium text-[#D97706] hover:underline">
                      Đăng nhập {site === "lms" ? "LMS" : "UEH Student"} lại nha
                    </a>
                  ) : seen ? (
                    <div className="text-[11.5px] text-[#98A2B3]">{ago(seen)}</div>
                  ) : (
                    <a href={src.open} target="_blank" className="text-[11.5px] font-medium text-[#4F7FEF] hover:underline">
                      Mở {src.id === "deadlines" ? "LMS" : "UEH Student"} một lần nha
                    </a>
                  )}
                </div>
                <Switch
                  on={on}
                  color={src.color}
                  label={src.label}
                  onChange={(value) => send({ type: "TOGGLE", source: src.id, on: value })}
                />
              </div>
            );
          })}
        </section>

        <a
          href="https://calendar.google.com/"
          target="_blank"
          className={`mt-3 flex h-11 items-center justify-center gap-1.5 rounded-full bg-white text-[14px] font-medium text-[#0F1424] transition hover:-translate-y-0.5 active:scale-[0.97] ${LIFT}`}
        >
          Mở Google Calendar
          <ExternalLinkRegular size={16} color="#4F7FEF" />
        </a>
      </main>
    </div>
  );
}

function Header({ children }: { children: ReactNode }) {
  return (
    <header className="relative z-20 flex items-center justify-between py-3 pl-4 pr-3">
      <a href="https://unical.tadyuh.dev" target="_blank" className="flex items-center gap-2">
        <Buddy size={28} />
        <span className="text-[16px] font-semibold tracking-[-0.02em]">UniCal</span>
      </a>
      <div className="flex items-center gap-1">{children}</div>
    </header>
  );
}

// Flat page with two soft, blurred brand glows, like the website.
function Glow() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      <div className="absolute -right-20 -top-24 h-56 w-56 rounded-full bg-[#4F7FEF]/[0.14] blur-3xl" />
      <div className="absolute -left-24 top-40 h-48 w-48 rounded-full bg-[#8B7CF6]/[0.08] blur-3xl" />
    </div>
  );
}

function Menu({
  account,
  onIcs,
  onDonate,
  onSignOut,
}: {
  account: State["account"];
  onIcs: () => void;
  onDonate: () => void;
  onSignOut: () => void;
}) {
  const [open, setOpen] = useState(false);
  const item =
    "flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-[13px] text-[#0F1424] transition hover:bg-[#F3F6FC] [&_svg]:h-4 [&_svg]:w-4";
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
        className={`flex h-8 w-8 items-center justify-center rounded-full transition ${
          account ? "ring-1 ring-[#4F7FEF]/15 hover:ring-2 hover:ring-[#4F7FEF]/25" : "bg-white/70 text-[#667085] hover:bg-white hover:text-[#0F1424]"
        }`}
      >
        {account?.picture ? (
          <img src={account.picture} alt="" className="h-8 w-8 rounded-full" />
        ) : account ? (
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[#EAF1FF] text-[12px] font-semibold text-[#4F7FEF]">
            {account.name.charAt(0).toUpperCase()}
          </span>
        ) : (
          <More1Regular className="h-[18px] w-[18px]" />
        )}
      </button>
      {open && (
        <>
          <button aria-hidden tabIndex={-1} className="fixed inset-0 z-20 cursor-default" onClick={() => setOpen(false)} />
          <div className={`absolute right-0 top-10 z-30 w-56 rounded-[20px] bg-white p-1.5 ${LIFT}`}>
            {account && <div className="truncate px-2.5 pb-1.5 pt-1 text-[12px] text-[#98A2B3]">{account.email}</div>}
            <button onClick={pick(onIcs)} className={item}>
              <DownloadRegular color="#667085" />
              Tải file .ics
            </button>
            <a href={REVIEW_URL} target="_blank" onClick={() => setOpen(false)} className={item}>
              <StarRegular color="#667085" />
              Đánh giá
            </a>
            <button onClick={pick(onDonate)} className={item}>
              <HeartRegular color="#667085" />
              Ủng hộ
            </button>
            {account && (
              <button onClick={pick(onSignOut)} className={item}>
                <ExitRegular color="#667085" />
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
      style={{ background: on ? color : "#E4E7EC" }}
    >
      <span
        className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${on ? "left-[18px]" : "left-0.5"}`}
      />
    </button>
  );
}

function Donate({ onClose }: { onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative w-[360px] select-none overflow-hidden bg-white px-5 pb-6 pt-3 text-center text-[#0F1424]">
      <Glow />
      <div className="relative flex justify-end">
        <button
          onClick={onClose}
          aria-label="Đóng"
          className="flex h-8 w-8 items-center justify-center rounded-full text-[#667085] transition hover:bg-[#F3F6FC] hover:text-[#0F1424]"
        >
          <CloseRegular className="h-[18px] w-[18px]" />
        </button>
      </div>
      <div className="relative">
        <Buddy mood="cheer" size={52} className="mx-auto -mb-3" />
        <img src="donate_qr.png" alt="" className={`relative mx-auto h-52 w-52 rounded-[24px] bg-white object-contain p-3 ${LIFT}`} />
        <div className="mt-5 text-[12px] font-medium tracking-[0.04em] text-[#667085]">HUONG DAT HUY</div>
        <button
          onClick={() => {
            navigator.clipboard.writeText("8888070605");
            setCopied(true);
          }}
          className="mx-auto mt-1.5 flex h-10 items-center gap-2 rounded-full bg-[#F3F6FC] px-4 text-[15px] font-semibold tabular-nums tracking-[0.02em] transition hover:bg-[#EAF1FF]"
        >
          8888070605
          {copied ? (
            <CheckRegular size={16} color="#16A34A" />
          ) : (
            <CopyRegular size={16} color="#98A2B3" />
          )}
        </button>
        <p className="mt-3 text-[12.5px] text-[#667085]">Cảm ơn bạn nhiều 💙</p>
      </div>
    </div>
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
