// Runs on the UEH student portal and LMS. When the student opens either one, reads their latest timetable,
// exams and LMS deadlines right away (ueh.ts) and hands them to the background worker, which keeps Google
// Calendar in sync. Also runs on UEH's login page, for the tabs UniCal opens to get back in. Bundled as a
// single classic script.
import type { LmsPayload, Message, Plan, PortalPayload, SyncReport } from "@/types";
import { CALM, readLms, readPortal } from "@/ueh";

const send = <T>(message: Message) =>
  chrome.runtime.sendMessage(message) as Promise<T>;

// ---- Toast ----

function toast(message: string, action?: { label: string; run: () => void }) {
  document.getElementById("unical-toast")?.remove();
  const host = document.createElement("div");
  host.id = "unical-toast";
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `
    <style>
      .t { position: fixed; right: 20px; bottom: 20px; z-index: 2147483647;
        display: flex; align-items: center; gap: 10px; max-width: calc(100vw - 40px);
        padding: 8px 8px 8px 10px; border-radius: 22px; background: #fff; color: #0F1424;
        font: 500 13.5px/1.4 "Inter Variable", Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        letter-spacing: -0.005em;
        box-shadow: 0 18px 40px -16px rgba(79, 127, 239, .45), 0 0 0 1px rgba(79, 127, 239, .12);
        animation: in .35s cubic-bezier(.2,.9,.3,1.2); }
      .t.out { animation: out .25s ease-in forwards; }
      img { width: 32px; height: 32px; flex: none; }
      span { padding-right: 6px; text-wrap: balance; min-width: 0; }
      button { all: unset; cursor: pointer; padding: 8px 14px; border-radius: 999px;
        background: #0F1424; color: #fff; font-weight: 500; white-space: nowrap; transition: background .15s; }
      button:hover { background: rgba(15, 20, 36, .85); }
      button:active { transform: scale(.97); }
      @keyframes in { from { opacity: 0; transform: translateY(12px) scale(.96); } }
      @keyframes out { to { opacity: 0; transform: translateY(12px) scale(.96); } }
    </style>
    <div class="t"><img alt=""><span></span></div>`;
  const box = root.querySelector(".t")!;
  root.querySelector("img")!.src = chrome.runtime.getURL("logo/logo-64.png");
  root.querySelector("span")!.textContent = message;
  if (action) {
    const button = document.createElement("button");
    button.textContent = action.label;
    button.addEventListener("click", () => {
      action.run();
      hide();
    });
    box.appendChild(button);
  }
  const hide = () => {
    box.classList.add("out");
    setTimeout(() => host.remove(), 250);
  };
  document.body.appendChild(host);
  setTimeout(hide, action ? 12000 : 5000);
}

function report({ changed, connected, nudge, lost, closing }: SyncReport) {
  if (closing) {
    toast("Xong rồi, lịch đã cập nhật");
    return;
  }
  if (!connected) {
    if (nudge) {
      toast(lost ? "Google Calendar đã ngưng cập nhật" : "Lịch của bạn đã sẵn sàng", {
        label: lost ? "Kết nối lại" : "Kết nối Google Calendar",
        run: () => send({ type: "OPEN_POPUP" }),
      });
    }
    return;
  }
  const parts = [
    changed.classes && `${changed.classes} buổi học`,
    changed.exams && `${changed.exams} lịch thi`,
    changed.deadlines && `${changed.deadlines} deadline`,
  ].filter(Boolean);
  if (parts.length) toast(`Google Calendar vừa cập nhật · ${parts.join(" · ")}`);
}

// ---- Entry ----

// UEH's login page. In a tab UniCal opened to get back in (background.ts), its "Tiếp tục" is pressed for the
// student once UEH's bot check has loaded, so the check runs exactly as when they press it. The page's account
// goes along only when it offers that one click; anything else there (a password, a checkbox) is theirs.
async function hub() {
  const button = document.querySelector<HTMLButtonElement>("#frmCaptcha #btnCaptcha");
  const offered = Boolean(button && !button.disabled && document.getElementById("recaptchaV3"));
  const account = offered ? (document.body.innerText.match(/[\w.+-]+@[\w.-]*ueh\.edu\.vn/i)?.[0] ?? "") : "";
  if (!(await send<boolean>({ type: "HUB", account }))) return;
  for (let waited = 0; !document.querySelector(".grecaptcha-badge iframe") && waited < 10_000; waited += 250) {
    await new Promise((done) => setTimeout(done, 250));
  }
  await new Promise((done) => setTimeout(done, 1200));
  button!.click();
}

async function run() {
  if (location.hostname === "loginst.ueh.edu.vn") return hub();
  const plan = await send<Plan>({ type: "PLAN" });
  let result: SyncReport | undefined;

  if (location.hostname === "student.ueh.edu.vn" && (plan.exams || plan.classes) && CALM.test(location.pathname)) {
    const payload: PortalPayload | null = await readPortal(plan);
    if (payload) result = await send({ type: "PORTAL", payload });
  } else if (location.hostname === "lms.ueh.edu.vn" && (plan.deadlines || plan.feed)) {
    const payload: LmsPayload | null = await readLms(plan);
    if (payload) result = await send({ type: "LMS", payload });
  }

  if (result) report(result);
}

run().catch(() => {});
