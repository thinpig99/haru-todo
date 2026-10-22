// 하루 할 일 알림 발송
// - mode "cron": pg_cron이 5분마다 호출. 각 사용자의 아침/저녁 시간이 되면 요약 알림 발송
// - mode "test": 로그인한 사용자가 앱에서 호출. 본인 기기로 테스트 알림 발송
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import webpush from "npm:web-push@3.6.7";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});
const APP_URL = "https://haru-todo-theta.vercel.app";
const WINDOW_MIN = 30; // 설정 시간부터 30분 안에만 보냄 (늦게 켠 날 몰아서 보내지 않도록)

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

type Settings = {
  user_id: string; morning_on: boolean; morning_time: string; evening_on: boolean; evening_time: string;
  tz: string; last_morning: string | null; last_evening: string | null;
};
const DEFAULTS = { morning_on: true, morning_time: "08:00", evening_on: true, evening_time: "21:00", tz: "Asia/Seoul", last_morning: null, last_evening: null };

function localNow(tz: string) {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
    .formatToParts(new Date());
  const g = (t: string) => p.find((x) => x.type === t)!.value;
  const hh = Number(g("hour")) % 24, mm = Number(g("minute"));
  return { date: `${g("year")}-${g("month")}-${g("day")}`, min: hh * 60 + mm };
}
const toMin = (s: string) => { const [h, m] = s.split(":").map(Number); return h * 60 + (m || 0); };

let cfgCache: Record<string, string> | null = null;
async function setup() {
  if (cfgCache) return cfgCache;
  const { data, error } = await sb.rpc("push_config");
  if (error || !data?.vapid_private) throw new Error("push config missing");
  webpush.setVapidDetails(APP_URL, data.vapid_public, data.vapid_private);
  cfgCache = data as Record<string, string>;
  return cfgCache;
}

async function sendTo(userId: string, payload: Record<string, unknown>) {
  const { data: subs } = await sb.from("push_subscriptions").select("*").eq("user_id", userId);
  let sent = 0;
  for (const s of subs || []) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), { TTL: 60 * 60 * 6, urgency: "normal" });
      sent++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) await sb.from("push_subscriptions").delete().eq("endpoint", s.endpoint);
      else console.error("push failed", code, (e as Error).message);
    }
  }
  return sent;
}

async function summary(userId: string, today: string) {
  const { data: mem } = await sb.from("members").select("calendar_id").eq("user_id", userId);
  const ids = (mem || []).map((m) => m.calendar_id);
  if (!ids.length) return { todayList: [], overdue: [] };
  const { data: rows } = await sb.from("tasks").select("title,date,created_at")
    .in("calendar_id", ids).eq("done", false).not("date", "is", null).lte("date", today);
  const list = (rows || []).sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
  return { todayList: list.filter((t) => t.date === today), overdue: list.filter((t) => t.date < today) };
}
const preview = (arr: { title: string }[], n = 3) =>
  arr.slice(0, n).map((t) => t.title).join(" · ") + (arr.length > n ? ` 외 ${arr.length - n}개` : "");

async function runCron() {
  const { data: subs } = await sb.from("push_subscriptions").select("user_id");
  const users = [...new Set((subs || []).map((s) => s.user_id))];
  if (!users.length) return { users: 0, sent: 0 };
  const { data: rows } = await sb.from("notif_settings").select("*").in("user_id", users);
  const byUser = new Map((rows || []).map((r: Settings) => [r.user_id, r]));
  let sent = 0;
  for (const uid of users) {
    const s: Settings = byUser.get(uid) || { user_id: uid, ...DEFAULTS };
    const now = localNow(s.tz || "Asia/Seoul");
    const due = (on: boolean, time: string, last: string | null) =>
      on && last !== now.date && now.min >= toMin(time) && now.min < toMin(time) + WINDOW_MIN;

    const doMorning = due(s.morning_on, s.morning_time, s.last_morning);
    const doEvening = due(s.evening_on, s.evening_time, s.last_evening);
    if (!doMorning && !doEvening) continue;

    const { todayList, overdue } = await summary(uid, now.date);
    if (doMorning) {
      if (todayList.length || overdue.length) {
        const title = todayList.length
          ? `오늘 할 일 ${todayList.length}개${overdue.length ? ` · 밀린 일 ${overdue.length}개` : ""}`
          : `밀린 일 ${overdue.length}개가 있어요`;
        sent += await sendTo(uid, { title, body: preview(todayList.length ? todayList : overdue), url: "/", tag: "haru-morning" });
      }
      await sb.from("notif_settings").upsert({ user_id: uid, last_morning: now.date });
      s.last_morning = now.date;
    }
    if (doEvening) {
      const left = [...todayList, ...overdue];
      if (left.length) {
        sent += await sendTo(uid, {
          title: `아직 ${left.length}개 남았어요`,
          body: preview(left) + (overdue.length ? ` (밀린 일 ${overdue.length}개 포함)` : ""),
          url: "/", tag: "haru-evening",
        });
      }
      await sb.from("notif_settings").upsert({ user_id: uid, last_evening: now.date });
    }
  }
  return { users: users.length, sent };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const cfg = await setup();
    const body = await req.json().catch(() => ({}));
    if (body.mode === "cron") {
      if (req.headers.get("x-cron-token") !== cfg.cron_token) return json({ error: "forbidden" }, 403);
      return json(await runCron());
    }
    if (body.mode === "test") {
      const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
      const { data: u } = await sb.auth.getUser(jwt);
      if (!u?.user) return json({ error: "not signed in" }, 401);
      const sent = await sendTo(u.user.id, {
        title: "알림이 켜졌어요",
        body: "아침에는 오늘 할 일을, 저녁에는 남은 일을 알려드릴게요.",
        url: "/", tag: "haru-test",
      });
      return json({ sent });
    }
    return json({ error: "unknown mode" }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: (e as Error).message }, 500);
  }
});
