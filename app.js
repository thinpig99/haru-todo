(() => {
'use strict';

/* ---------- constants ---------- */
const CATS = [
  {id:'life', name:'개인', v:'--c-life'},
  {id:'home', name:'집',   v:'--c-home'},
  {id:'work', name:'업무', v:'--c-work'},
  {id:'etc',  name:'기타', v:'--c-etc'},
];
const catOf = id => CATS.find(c => c.id === id) || CATS[3];
const DOW = ['일','월','화','수','목','금','토'];
const DOW_FULL = ['일요일','월요일','화요일','수요일','목요일','금요일','토요일'];
const PCOL = ['--p0','--p1','--p2','--p3'];

const hol = s => (window.KHoliday ? window.KHoliday.holidayName(s) : null);

/* ---------- helpers ---------- */
const pad = n => String(n).padStart(2,'0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const parse = s => { const [y,m,d] = s.split('-').map(Number); return new Date(y, m-1, d); };
const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate()+n); return ymd(d); };
const today = () => ymd(new Date());
const diffDays = (a, b) => Math.round((parse(a) - parse(b)) / 86400000);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() :
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random()*16|0; return (c === 'x' ? r : (r&3|8)).toString(16); }));
const doneDay = t => t.doneAt ? ymd(new Date(t.doneAt)) : null;
const hhmm = ms => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const ls = {
  get(k){ try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v){ try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

/* ---------- supabase ---------- */
const CFG = window.HARU_CONFIG || {};
const $app = document.getElementById('app');
if (!CFG.supabaseUrl || !CFG.supabaseAnonKey || !window.supabase) {
  $app.innerHTML = '<div class="empty"><strong>설정이 필요해요</strong><p>config.js에 Supabase 주소와 키를 넣어주세요.</p></div>';
  return;
}
const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

/* ---------- state ---------- */
const tasks = new Map();
const people = new Map();   // user_id -> {name, email, color}
let me = null;              // auth user
let cal = null;             // {id, name}
let calendars = [];         // [{id, name}]
let invites = [];
let channel = null;
let live = false;
const annivs = new Map();   // anniversaries
const KINDS = [
  {id:'birthday', name:'생일'},
  {id:'wedding',  name:'결혼기념일'},
  {id:'etc',      name:'기념일'},
];
const kindName = id => (KINDS.find(k => k.id === id) || KINDS[2]).name;

const st = {
  view:'day', sel: today(), cat:'all', showDone:true, logMore:false,
  cal: ls.get('haru-cal') === 'week' ? 'week' : 'month',
  big: ls.get('haru-big') === true,
};

const rowToTask = r => ({
  id:r.id, title:r.title, note:r.note || '', date:r.date || null, cat:r.cat,
  done:!!r.done, doneAt:r.done_at ? Date.parse(r.done_at) : null, doneBy:r.done_by,
  createdBy:r.created_by, createdAt:r.created_at ? Date.parse(r.created_at) : 0,
  annivId:r.anniv_id || null, annivOcc:r.anniv_occ || null,
});
const taskToRow = t => ({
  id:t.id, calendar_id:cal.id, title:t.title, note:t.note || '', date:t.date || null, cat:t.cat,
  done:!!t.done, done_at:t.doneAt ? new Date(t.doneAt).toISOString() : null, done_by:t.done ? (t.doneBy || null) : null,
  created_by:t.createdBy || me.id, created_at:new Date(t.createdAt || Date.now()).toISOString(),
  updated_by:me.id, updated_at:new Date().toISOString(),
  anniv_id:t.annivId || null, anniv_occ:t.annivOcc || null,
});

function cacheKey(){ return 'haru-cache-' + (cal && cal.id); }
function writeCache(){ if (cal) ls.set(cacheKey(), [...tasks.values()]); }
function writeAnnivCache(){ if (cal) ls.set('haru-anniv-' + cal.id, [...annivs.values()]); }

const rowToAnniv = r => ({
  id:r.id, title:r.title, kind:r.kind, date:r.date, lunar:!!r.lunar, yearly:!!r.yearly, dday:!!r.dday,
  prepTitle:r.prep_title || '', prepDays:r.prep_days || 0, prepLastOcc:r.prep_last_occ || null, createdBy:r.created_by,
});
const annivToRow = a => ({
  id:a.id, calendar_id:cal.id, title:a.title, kind:a.kind, date:a.date, lunar:!!a.lunar, yearly:!!a.yearly, dday:!!a.dday,
  prep_title:a.prepTitle || '', prep_days:a.prepDays || 0, prep_last_occ:a.prepLastOcc || null,
  created_by:a.createdBy || me.id, updated_at:new Date().toISOString(),
});

/* ---------- anniversaries & D-Day ---------- */
const DAY = 86400000;
// 실제 시작일(양력). 음력 기념일은 그 해의 음력 월/일을 양력으로 바꾼 날
function annivStart(a){
  if (!a.lunar) return a.date;
  const [y,m,d] = a.date.split('-').map(Number);
  return (window.KHoliday && window.KHoliday.lunarToSolar(y, m, d)) || a.date;
}
// y년의 기념일 날짜(양력)
function occurrenceIn(a, y){
  const [y0,m,d] = a.date.split('-').map(Number);
  if (y < y0) return null;
  if (a.lunar) return window.KHoliday ? window.KHoliday.lunarToSolar(y, m, d) : null;
  if (m === 2 && d === 29 && !(y%4===0 && (y%100!==0 || y%400===0))) return `${y}-02-28`;
  return `${y}-${pad(m)}-${pad(d)}`;
}
// 처음 날을 1일로 세는 한국식 D-Day: n일째 = 시작일 + (n-1)일
const dayCount = (start, s) => diffDays(s, start) + 1;
const MILESTONES = (() => { const m = []; for (let k = 100; k <= 3000; k += 100) m.push(k); for (let k = 4000; k <= 20000; k += 1000) m.push(k); return m; })();

let evCache = {};
function eventsForYear(y){
  if (evCache[y]) return evCache[y];
  const map = {};
  const push = (date, ev) => { if (date && date.startsWith(y + '-')) (map[date] = map[date] || []).push(ev); };
  annivs.forEach(a => {
    const y0 = Number(a.date.slice(0,4));
    if (a.yearly || a.dday) {
      const occ = occurrenceIn(a, y);
      if (occ) {
        const n = y - y0;
        let label = a.title;
        if (n > 0 && a.kind !== 'birthday') label += ` ${n}주년`;
        if (a.yearly || n > 0) push(occ, {aid:a.id, label, kind:a.kind, main:true});
      }
    } else if (a.date.startsWith(y + '-')) {
      push(a.date, {aid:a.id, label:a.title, kind:a.kind, main:true});
    }
    if (a.dday) {
      const st0 = annivStart(a);
      MILESTONES.forEach(k => push(addDays(st0, k - 1), {aid:a.id, label:`${a.title} ${k.toLocaleString('ko-KR')}일`, kind:a.kind, main:false}));
    }
  });
  return (evCache[y] = map);
}
const eventsOn = s => eventsForYear(Number(s.slice(0,4)))[s] || [];
function resetEvents(){ evCache = {}; }

// 오늘 이후 가장 가까운 기념일 날짜
function nextOccurrence(a){
  const T = today(), y = Number(T.slice(0,4));
  if (!a.yearly) return a.date >= T ? a.date : null;
  for (let yy = y; yy <= y + 2; yy++){ const o = occurrenceIn(a, yy); if (o && o >= T) return o; }
  return null;
}
// 다음 D-Day 기념 숫자
function nextMilestone(a){
  const st0 = annivStart(a), n = dayCount(st0, today());
  const k = MILESTONES.find(x => x >= n);
  return k ? {k, date:addDays(st0, k-1)} : null;
}
function dLabel(s){ const d = diffDays(s, today()); return d === 0 ? 'D-DAY' : d > 0 ? `D-${d}` : `D+${-d}`; }

async function loadAnnivs(){
  const { data, error } = await sb.from('anniversaries').select('*').eq('calendar_id', cal.id);
  if (error) return;
  annivs.clear(); data.forEach(r => annivs.set(r.id, rowToAnniv(r)));
  resetEvents(); writeAnnivCache();
}
async function saveAnniv(a){
  annivs.set(a.id, a); resetEvents(); writeAnnivCache(); render();
  const { error } = await sb.from('anniversaries').upsert(annivToRow(a));
  if (error) { toast('기념일을 저장하지 못했어요.'); return; }
  ensurePrepTasks();
}
async function removeAnniv(id){
  annivs.delete(id); resetEvents(); writeAnnivCache(); render();
  const { error } = await sb.from('anniversaries').delete().eq('id', id);
  if (error) toast('기념일을 삭제하지 못했어요.');
}

// 기념일 '미리 할 일' 자동 추가: 다가오는 기념일마다 한 번만 만든다
const prepBusy = new Set();
async function ensurePrepTasks(){
  if (!cal) return;
  const T = today();
  for (const a of annivs.values()){
    if (!a.prepTitle) continue;
    const occ = nextOccurrence(a);
    if (!occ) continue;
    if (a.prepLastOcc && a.prepLastOcc >= occ) continue;
    const prepDate = addDays(occ, -(a.prepDays || 0));
    if (diffDays(prepDate, T) > 30) continue;           // 30일 안으로 다가오면 추가
    const key = a.id + occ;
    if (prepBusy.has(key)) continue;
    prepBusy.add(key);
    const exists = [...tasks.values()].some(t => t.annivId === a.id && t.annivOcc === occ);
    if (!exists) {
      const t = {id:uuid(), title:`${a.title}: ${a.prepTitle}`, note:`${occ.slice(5).replace('-','/')} ${a.title}을 위한 할 일`, date: prepDate < T ? T : prepDate,
        cat:'life', done:false, doneAt:null, doneBy:null, createdBy:me.id, createdAt:Date.now(), annivId:a.id, annivOcc:occ};
      const { error } = await sb.from('tasks').upsert(taskToRow(t), {onConflict:'anniv_id,anniv_occ', ignoreDuplicates:true});
      if (!error) tasks.set(t.id, t);
    }
    const na = {...a, prepLastOcc: occ};
    annivs.set(a.id, na);
    await sb.from('anniversaries').update({prep_last_occ: occ}).eq('id', a.id);
  }
  writeAnnivCache(); writeCache(); render();
}


/* ---------- auth flow ---------- */
let authMode = 'login';
let authMsg = null;

function renderAuth(){
  document.getElementById('tabbar').hidden = true;
  document.getElementById('fab').hidden = true;
  const isUp = authMode === 'signup';
  const d = new Date();
  $app.innerHTML = `<div class="auth">
    <div class="brand"><div class="num">${d.getDate()}</div><h1>하루 할 일</h1>
      <p>함께 쓰는 캘린더 할 일. 누가 무엇을 추가하고 끝냈는지 같이 봐요.</p></div>
    <form id="authForm" novalidate>
      ${isUp ? '<input class="field" id="auName" placeholder="이름 (상대에게 보이는 이름)" autocomplete="nickname" required>' : ''}
      <input class="field" id="auEmail" type="email" placeholder="이메일" autocomplete="email" inputmode="email" required>
      <input class="field" id="auPw" type="password" placeholder="비밀번호 (6자 이상)" autocomplete="${isUp?'new-password':'current-password'}" required>
      ${authMsg ? `<p class="msg ${authMsg.ok?'ok':'err'}">${esc(authMsg.text)}</p>` : ''}
      <button class="btn primary" id="auBtn" type="submit">${isUp ? '가입하기' : '로그인'}</button>
    </form>
    <p class="switch">${isUp ? '이미 계정이 있나요?' : '처음이신가요?'} <button id="auSwitch" type="button">${isUp ? '로그인' : '가입하기'}</button></p>
  </div>`;
  document.getElementById('auSwitch').onclick = () => { authMode = isUp ? 'login' : 'signup'; authMsg = null; renderAuth(); };
  document.getElementById('authForm').onsubmit = async e => {
    e.preventDefault();
    const email = document.getElementById('auEmail').value.trim();
    const pw = document.getElementById('auPw').value;
    const name = isUp ? document.getElementById('auName').value.trim() : '';
    if (!email || !pw || (isUp && !name)) { authMsg = {text:'빈 칸을 모두 채워주세요.'}; return renderAuth(); }
    const btn = document.getElementById('auBtn'); btn.disabled = true; btn.textContent = '잠시만요';
    if (isUp) {
      const { data, error } = await sb.auth.signUp({ email, password: pw, options: { data: { name }, emailRedirectTo: location.origin } });
      if (error) { authMsg = {text: authError(error)}; return renderAuth(); }
      if (!data.session) { authMode = 'login'; authMsg = {ok:true, text:'인증 메일을 보냈어요. 메일의 링크를 누른 뒤 로그인하세요.'}; return renderAuth(); }
    } else {
      const { error } = await sb.auth.signInWithPassword({ email, password: pw });
      if (error) { authMsg = {text: authError(error)}; return renderAuth(); }
    }
  };
}
function authError(e){
  const m = (e && e.message || '').toLowerCase();
  if (m.includes('invalid login')) return '이메일 또는 비밀번호가 맞지 않아요.';
  if (m.includes('already registered') || m.includes('already been registered')) return '이미 가입된 이메일이에요. 로그인해 주세요.';
  if (m.includes('password')) return '비밀번호는 6자 이상으로 정해주세요.';
  if (m.includes('email not confirmed')) return '메일함에서 인증 링크를 먼저 눌러주세요.';
  if (m.includes('valid email') || m.includes('invalid email')) return '이메일 주소를 다시 확인해 주세요.';
  if (m.includes('rate limit')) return '요청이 많아요. 잠시 후 다시 시도해 주세요.';
  return '문제가 생겼어요: ' + (e.message || '알 수 없는 오류');
}

/* ---------- data loading ---------- */
async function start(user){
  me = user;
  $app.innerHTML = '<div class="boot">불러오는 중</div>';
  const { data: firstCid, error } = await sb.rpc('bootstrap');
  if (error) { $app.innerHTML = `<div class="empty"><strong>연결하지 못했어요</strong><p>${esc(error.message)}</p><button class="pill-btn" onclick="location.reload()">다시 시도</button></div>`; return; }
  await loadCalendars(firstCid);
  await openCalendar();
}

async function loadCalendars(fallback){
  const { data } = await sb.from('members').select('calendar_id, joined_at, calendars(id, name, personal, created_by)').eq('user_id', me.id).order('joined_at');
  calendars = (data || []).map(r => r.calendars).filter(Boolean)
    .sort((a, b) => (b.personal ? 1 : 0) - (a.personal ? 1 : 0));
  const saved = ls.get('haru-calid');
  const pick = calendars.find(c => c.id === saved) || calendars.find(c => c.id === fallback) || calendars[0];
  cal = pick ? {...pick} : null;
}

async function openCalendar(){
  if (!cal) return;
  ls.set('haru-calid', cal.id);
  tasks.clear();
  (ls.get(cacheKey()) || []).forEach(t => t && t.id && tasks.set(t.id, t));
  annivs.clear(); (ls.get('haru-anniv-' + cal.id) || []).forEach(a => a && a.id && annivs.set(a.id, a)); resetEvents();
  showMain(); render();
  await Promise.all([loadPeople(), loadTasks(), loadInvites(), loadAnnivs()]);
  subscribe();
  render();
  ensurePrepTasks();
}

async function loadTasks(){
  const { data, error } = await sb.from('tasks').select('*').eq('calendar_id', cal.id);
  if (error) { toast('할 일을 불러오지 못했어요.'); return; }
  tasks.clear(); data.forEach(r => tasks.set(r.id, rowToTask(r)));
  writeCache();
}
async function loadPeople(){
  const { data } = await sb.from('members').select('user_id, joined_at, profiles(name, email)').eq('calendar_id', cal.id).order('joined_at');
  people.clear();
  (data || []).forEach((r, i) => people.set(r.user_id, {
    name: (r.profiles && r.profiles.name) || '이름 없음', email: r.profiles && r.profiles.email, color: PCOL[i % PCOL.length],
  }));
}
async function loadInvites(){
  const { data } = await sb.from('invites').select('email').eq('calendar_id', cal.id).is('accepted_at', null);
  invites = (data || []).map(r => r.email);
}

function subscribe(){
  if (channel) sb.removeChannel(channel);
  live = false;
  channel = sb.channel('tasks-' + cal.id)
    .on('postgres_changes', {event:'INSERT', schema:'public', table:'tasks', filter:`calendar_id=eq.${cal.id}`}, p => { tasks.set(p.new.id, rowToTask(p.new)); writeCache(); render(); })
    .on('postgres_changes', {event:'UPDATE', schema:'public', table:'tasks', filter:`calendar_id=eq.${cal.id}`}, p => { tasks.set(p.new.id, rowToTask(p.new)); writeCache(); render(); })
    .on('postgres_changes', {event:'DELETE', schema:'public', table:'tasks'}, p => { if (p.old && tasks.delete(p.old.id)) { writeCache(); render(); } })
    .on('postgres_changes', {event:'*', schema:'public', table:'anniversaries', filter:`calendar_id=eq.${cal.id}`}, p => {
      if (p.eventType === 'DELETE') annivs.delete(p.old.id); else annivs.set(p.new.id, rowToAnniv(p.new));
      resetEvents(); writeAnnivCache(); render(); })
    .on('postgres_changes', {event:'DELETE', schema:'public', table:'anniversaries'}, p => { if (p.old && annivs.delete(p.old.id)) { resetEvents(); writeAnnivCache(); render(); } })
    .subscribe(status => {
      const was = live; live = status === 'SUBSCRIBED';
      if (was !== live && st.view) render();
    });
}

/* ---------- writes ---------- */
async function save(t){
  tasks.set(t.id, t); writeCache(); render();
  const { error } = await sb.from('tasks').upsert(taskToRow(t));
  if (error) toast('저장하지 못했어요. 연결을 확인해 주세요.');
}
async function saveMany(list){
  list.forEach(t => tasks.set(t.id, t)); writeCache(); render();
  const { error } = await sb.from('tasks').upsert(list.map(taskToRow));
  if (error) toast('저장하지 못했어요. 연결을 확인해 주세요.');
}
async function remove(id){
  tasks.delete(id); writeCache(); render();
  const { error } = await sb.from('tasks').delete().eq('id', id);
  if (error) toast('삭제하지 못했어요.');
}

/* ---------- icons ---------- */
const CHECK = '<svg viewBox="0 0 16 16" fill="none" stroke="var(--surface)" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.5l3 3 6-7"/></svg>';
const ICON = {
  day:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>',
  box:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M4 13l2.5-7.5h11L20 13v6H4z"/><path d="M4 13h5l1 2h4l1-2h5"/></svg>',
  log:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19V9M10 19V5M16 19v-7M21 19H3"/></svg>',
  anniv:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/></svg>',
};

/* ---------- rendering ---------- */
function showMain(){
  document.getElementById('tabbar').hidden = false;
  document.getElementById('fab').hidden = false;
}
const person = id => people.get(id) || {name:'알 수 없음', color:'--muted'};
const multi = () => people.size > 1;
const whoTag = (id, suffix) => { const p = person(id); return `<span class="who" style="--pc:var(${p.color})"><i></i>${esc(p.name)} ${suffix}</span>`; };

function relLabel(s){
  const d = diffDays(s, today());
  if (d === 0) return '오늘';
  if (d === 1) return '내일';
  if (d === -1) return '어제';
  return d > 0 ? `${d}일 뒤` : `${-d}일 전`;
}

function taskRow(t, opts = {}){
  const c = catOf(t.cat);
  const meta = [`<span>${esc(c.name)}</span>`];
  if (opts.late) meta.push(`<span class="late">${opts.late}일 지남</span>`);
  if (opts.showDate && t.date) { const d = parse(t.date); meta.push(`<span>${d.getMonth()+1}/${d.getDate()}</span>`); }
  if (t.done && t.doneBy) meta.push(whoTag(t.doneBy, `완료 ${t.doneAt ? hhmm(t.doneAt) : ''}`));
  else if (!t.done && multi() && t.createdBy) meta.push(whoTag(t.createdBy, '추가'));
  if (t.note) meta.push('<span>메모 있음</span>');
  const act = opts.action ? `<button class="t-act" data-act="${opts.action.k}" data-id="${t.id}">${opts.action.label}</button>` : '';
  return `<div class="task${t.done?' done':''}" style="--cc:var(${c.v})" data-row="${t.id}">
    <button class="chk" data-act="toggle" data-id="${t.id}" aria-label="${t.done?'완료 취소':'완료'}: ${esc(t.title)}">${CHECK}</button>
    <button class="t-body" data-act="edit" data-id="${t.id}"><span class="t-title">${esc(t.title)}</span><span class="t-meta">${meta.join('')}</span></button>
    ${act}</div>`;
}

const byCreated = (a,b) => (a.createdAt||0) - (b.createdAt||0);
const inCat = t => st.cat === 'all' || t.cat === st.cat;

function catChips(pool){
  const cnt = id => pool.filter(t => id === 'all' || t.cat === id).length;
  return `<div class="chips" role="group" aria-label="분류">
    <button class="chip" data-act="cat" data-cat="all" aria-pressed="${st.cat==='all'}">전체 <span class="ct">${cnt('all')}</span></button>
    ${CATS.map(c => `<button class="chip" data-act="cat" data-cat="${c.id}" aria-pressed="${st.cat===c.id}"><span class="sw" style="background:var(${c.v})"></span>${c.name} <span class="ct">${cnt(c.id)}</span></button>`).join('')}
  </div>`;
}

function peopleBtn(){
  const avs = [...people.values()].slice(0,4).map(p => `<span class="av" style="--pc:var(${p.color})">${esc(p.name.slice(0,1))}</span>`).join('');
  return `<button class="people" data-act="settings" aria-label="캘린더 설정과 멤버">
    <span class="live${live?' on':''}" title="${live?'실시간 연결됨':'연결 중'}"></span>
    <span class="cal-tag">${cal && cal.personal ? '개인' : '공유'}</span>
    <span>${esc(cal ? cal.name : '')}</span>${cal && !cal.personal ? `<span class="avs">${avs}</span>` : ''}
    <svg class="chev" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3 4.5l3 3 3-3"/></svg></button>`;
}

function renderDay(){
  const T = today(), sel = st.sel, d = parse(sel);
  const all = [...tasks.values()];
  const isToday = sel === T;
  const undoneOn = s => all.filter(t => !t.done && t.date === s).length;
  const dots = (n, s) => `<span class="dots">${eventsOn(s).length ? '<b class="evm"></b>' : ''}${'<i></i>'.repeat(Math.min(n,3))}</span>`;

  let calHTML = '';
  if (st.cal === 'week') {
    const start = addDays(sel, -d.getDay());
    let week = '';
    for (let i = 0; i < 7; i++){
      const s = addDays(start, i), n = undoneOn(s), dd = parse(s);
      const cls = ['day', i===0?'sun':'', hol(s)?'hol':'', s===T?'today':'', s===sel?'sel':''].join(' ');
      week += `<button class="${cls}" data-act="pick" data-date="${s}" aria-label="${dd.getMonth()+1}월 ${dd.getDate()}일${hol(s)?' '+hol(s):''}, 할 일 ${n}개">
        <span class="dw">${DOW[i]}</span><span class="dn">${dd.getDate()}</span>${dots(n, s)}</button>`;
    }
    calHTML = `<div class="week cal-swipe">
      <button class="wk-nav" data-act="week" data-dir="-1" aria-label="이전 주">‹</button>${week}
      <button class="wk-nav" data-act="week" data-dir="1" aria-label="다음 주">›</button></div>`;
  } else {
    const first = new Date(d.getFullYear(), d.getMonth(), 1);
    const gStart = addDays(ymd(first), -first.getDay());
    let cells = DOW.map((x,i) => `<div class="hd${i===0?' sun':''}">${x}</div>`).join('');
    // 마지막 주가 다음 달로만 채워지면 5주만 표시
    const weeks = addDays(gStart, 35).slice(0,7) === ymd(first).slice(0,7) ? 6 : 5;
    const byDate = {};
    if (st.big) all.forEach(t => { if (t.date) (byDate[t.date] = byDate[t.date] || []).push(t); });
    for (let i = 0; i < weeks * 7; i++){
      const s = addDays(gStart, i), dd = parse(s), n = undoneOn(s);
      const cls = ['mday', i%7===0?'sun':'', i%7===6?'sat':'', hol(s)?'hol':'', dd.getMonth()!==d.getMonth()?'out':'', s===T?'today':'', s===sel?'sel':''].join(' ');
      const label = `${dd.getMonth()+1}월 ${dd.getDate()}일${hol(s)?' '+hol(s):''}, 할 일 ${n}개`;
      if (!st.big) {
        cells += `<button class="${cls}" data-act="pick" data-date="${s}" aria-label="${label}">
          <span class="dn">${dd.getDate()}</span>${dots(n, s)}</button>`;
        continue;
      }
      const items = [];
      if (hol(s)) items.push(`<span class="bi hl">${esc(hol(s))}</span>`);
      eventsOn(s).forEach(e => items.push(`<span class="bi ev${e.main?'':' ms'}">${esc(e.label)}</span>`));
      (byDate[s] || []).sort((a,b) => (a.done - b.done) || (a.createdAt - b.createdAt))
        .forEach(t => items.push(`<span class="bi${t.done?' dn-t':''}" style="--cc:var(${catOf(t.cat).v})">${esc(t.title)}</span>`));
      const MAX = 4, more = items.length - MAX;
      cells += `<button class="${cls}" data-act="pickBig" data-date="${s}" aria-label="${label}">
        <span class="dn">${dd.getDate()}</span>
        <span class="bitems">${items.slice(0, more > 0 ? MAX - 1 : MAX).join('')}${more > 0 ? `<span class="bmore">+${more + 1}</span>` : ''}</span></button>`;
    }
    calHTML = `<div class="month cal-swipe${st.big?' big':''}"><div class="m-head">
      <button class="wk-nav" data-act="month" data-dir="-1" aria-label="이전 달">‹</button>
      <span>${d.getFullYear()}년 ${d.getMonth()+1}월</span>
      <button class="wk-nav" data-act="month" data-dir="1" aria-label="다음 달">›</button></div>
      <div class="m-grid" style="--weeks:${weeks}">${cells}</div>
      <button class="grip" data-act="big" aria-label="${st.big ? '달력 접기' : '달력 펼쳐서 할 일 보기'}"><span></span></button></div>`;
  }

  const overdue = isToday ? all.filter(t => !t.done && t.date && t.date < T).sort((a,b)=> a.date < b.date ? -1 : 1) : [];
  const dayTodo = all.filter(t => !t.done && t.date === sel).sort(byCreated);
  const dayDone = all.filter(t => t.done && doneDay(t) === sel).sort((a,b)=> b.doneAt - a.doneAt);
  const pool = [...overdue, ...dayTodo, ...dayDone];
  const o = overdue.filter(inCat), td = dayTodo.filter(inCat), dn = dayDone.filter(inCat);
  const totalNow = pool.length;
  const pct = totalNow ? Math.round(dayDone.length / totalNow * 100) : 0;

  let body = '';
  const evs = eventsOn(sel);
  if (evs.length) body += `<div class="evlist">${evs.map(e => `<button class="ev ${e.main?'':'ms'}" data-act="anniv" data-id="${e.aid}">
      <span class="ev-k">${e.main ? esc(kindName(e.kind)) : 'D-Day'}</span><span class="ev-t">${esc(e.label)}</span></button>`).join('')}</div>`;
  if (o.length) body += `<section class="sec"><div class="sec-h warn"><span>밀린 일 ${o.length}</span><button data-act="pullAll">모두 오늘로</button></div>
    <div class="list">${o.map(t => taskRow(t, {late: diffDays(T, t.date), action:{k:'pull', label:'오늘로'}})).join('')}</div></section>`;
  if (td.length) body += `<section class="sec"><div class="sec-h"><span>${isToday?'오늘 할 일':'이 날 할 일'} ${td.length}</span></div>
    <div class="list">${td.map(t => taskRow(t)).join('')}</div></section>`;

  if (!o.length && !td.length){
    if (tasks.size === 0) {
      body += `<div class="empty"><strong>첫 할 일을 적어보세요</strong>
        <p>날짜를 정한 일은 그날에, 언젠가 할 일은 보관함에 모여요. 끝내지 못한 일은 다음 날로 넘어와요.</p>
        <button class="pill-btn" data-act="add">할 일 추가</button>
        ${!cal.personal && people.size < 2 ? '<button class="pill-btn" data-act="settings">함께 쓸 사람 초대</button>' : ''}</div>`;
    } else if (!dn.length) {
      body += `<div class="empty"><strong>${isToday?'오늘은 비어 있어요':'이 날은 비어 있어요'}</strong><p>오른쪽 아래 + 버튼으로 할 일을 추가하세요.</p></div>`;
    } else {
      body += `<div class="empty"><strong>모두 끝냈어요</strong><p>${dn.length}개를 완료했어요.</p></div>`;
    }
  }
  if (dn.length) body += `<section class="sec"><div class="sec-h"><span>완료 ${dn.length}</span><button data-act="toggleDone">${st.showDone?'접기':'펼치기'}</button></div>
    ${st.showDone ? `<div class="list">${dn.map(t => taskRow(t)).join('')}</div>` : ''}</section>`;

  if (st.cal === 'month' && st.big) {
    return `<header class="top compact">
      <div class="date-meta"><span class="date-dow" style="font-size:22px">${d.getFullYear()}년 ${d.getMonth()+1}월</span></div>
      <div class="top-right">${peopleBtn()}<div class="top-btns">
        ${sel.slice(0,7) === T.slice(0,7) ? '' : '<button class="pill-btn" data-act="goToday">오늘</button>'}
        <div class="seg" role="group" aria-label="달력 보기">
          <button data-act="cal" data-v="week" aria-pressed="false">주</button>
          <button data-act="cal" data-v="month" aria-pressed="true">월</button>
        </div></div></div>
    </header>${calHTML}`;
  }
  const red = isToday || hol(sel) || d.getDay() === 0;
  return `
  <header class="top">
    <div class="date-big">
      <div class="date-num${red?' red':''}">${d.getDate()}</div>
      <div class="date-meta"><span class="date-month">${d.getFullYear()}년 ${d.getMonth()+1}월</span>
        <span class="date-dow">${DOW_FULL[d.getDay()]}</span><span class="date-rel">${relLabel(sel)}</span>
        ${hol(sel) ? `<span class="date-hol">${esc(hol(sel))}</span>` : ''}</div>
    </div>
    <div class="top-right">
      ${peopleBtn()}
      <div class="top-btns">
        ${isToday ? '' : '<button class="pill-btn" data-act="goToday">오늘</button>'}
        <div class="seg" role="group" aria-label="달력 보기">
          <button data-act="cal" data-v="week" aria-pressed="${st.cal==='week'}">주</button>
          <button data-act="cal" data-v="month" aria-pressed="${st.cal==='month'}">월</button>
        </div>
      </div>
    </div>
  </header>
  ${calHTML}
  ${totalNow ? `<div class="prog"><span>${dayDone.length} / ${totalNow} 완료</span><div class="bar"><b style="width:${pct}%"></b></div></div>` : ''}
  ${pool.length ? catChips(pool) : ''}
  ${body}`;
}

function pageHead(sub, title){
  return `<header class="top"><div class="date-meta"><span class="date-month">${sub}</span><span class="date-dow" style="font-size:26px">${title}</span></div>
    <div class="top-right">${peopleBtn()}</div></header>`;
}

function renderBox(){
  const T = today();
  const undated = [...tasks.values()].filter(t => !t.done && !t.date).sort(byCreated);
  const upcoming = [...tasks.values()].filter(t => !t.done && t.date && t.date > T).sort((a,b)=> a.date < b.date ? -1 : 1);
  const u = undated.filter(inCat), up = upcoming.filter(inCat);
  let body = '';
  if (u.length) {
    body += CATS.filter(c => u.some(t => t.cat === c.id)).map(c => {
      const items = u.filter(t => t.cat === c.id);
      return `<section class="sec"><div class="sec-h"><span>${c.name} ${items.length}</span></div>
        <div class="list">${items.map(t => taskRow(t, {action:{k:'pull', label:'오늘 하기'}})).join('')}</div></section>`;
    }).join('');
  } else {
    body += '<div class="empty"><strong>보관함이 비어 있어요</strong><p>날짜를 정하지 않은 일은 여기에 모여요. 할 날이 오면 오늘로 옮기세요.</p></div>';
  }
  if (up.length) body += `<section class="sec"><div class="sec-h"><span>예정된 일 ${up.length}</span></div>
    <div class="list">${up.slice(0,30).map(t => taskRow(t, {showDate:true})).join('')}</div></section>`;
  return pageHead('언젠가 할 일과 다가올 일', '보관함') + ((undated.length + upcoming.length) ? catChips([...undated, ...upcoming]) : '') + body;
}

function renderLog(){
  const T = today(), done = [...tasks.values()].filter(t => t.done && t.doneAt);
  const perDay = {};
  done.forEach(t => { const k = doneDay(t); perDay[k] = (perDay[k]||0) + 1; });
  const tD = parse(T), gridStart = addDays(T, -tD.getDay() - 28);
  let cells = DOW.map(x => `<div class="hd">${x}</div>`).join('');
  for (let i = 0; i < 35; i++){
    const s = addDays(gridStart, i), n = perDay[s] || 0, fut = s > T;
    const lv = n >= 5 ? 'l3' : n >= 3 ? 'l2' : n >= 1 ? 'l1' : '';
    cells += `<button class="hc ${fut?'fut':lv} ${s===T?'tdy':''}" data-act="pickFromLog" data-date="${s}" aria-label="${s} 완료 ${n}개" ${fut?'disabled':''}>${fut?'':parse(s).getDate()}</button>`;
  }
  const weekStart = addDays(T, -tD.getDay());
  const weekDone = done.filter(t => doneDay(t) >= weekStart);
  const byP = multi() ? `<div class="by-person">${[...people.entries()].map(([id,p]) =>
      `<span class="who" style="--pc:var(${p.color})"><i></i>${esc(p.name)} <b>${weekDone.filter(t => t.doneBy === id).length}</b></span>`).join('')}</div>` : '';

  const days = Object.keys(perDay).sort().reverse();
  const shown = st.logMore ? days : days.slice(0, 10);
  const groups = shown.map(k => {
    const items = done.filter(t => doneDay(t) === k).sort((a,b)=> b.doneAt - a.doneAt);
    const dd = parse(k);
    return `<section class="sec"><div class="sec-h"><span>${dd.getMonth()+1}월 ${dd.getDate()}일 ${DOW[dd.getDay()]}요일 · ${relLabel(k)}</span><span>${items.length}</span></div>
      <div class="list">${items.map(t => taskRow(t)).join('')}</div></section>`;
  }).join('');

  return pageHead('끝낸 일은 여기에 남아요', '완료 기록') + `
    <div class="card"><div class="heat-top"><div><div class="big">${weekDone.length}</div><span>이번 주에 끝낸 일</span></div>${byP}</div>
      <div class="heat">${cells}</div></div>
    ${groups || '<div class="empty"><strong>아직 기록이 없어요</strong><p>할 일을 완료하면 날짜별로 이곳에 쌓여요.</p></div>'}
    ${days.length > 10 && !st.logMore ? '<button class="pill-btn" data-act="logMore" style="align-self:center">이전 기록 더 보기</button>' : ''}`;
}

function renderAnniv(){
  const T = today();
  const list = [...annivs.values()].map(a => ({a, next: nextOccurrence(a)}))
    .sort((x, y) => (x.next || '9999') < (y.next || '9999') ? -1 : 1);
  const ddays = [...annivs.values()].filter(a => a.dday);

  // 앞으로 60일 동안의 기념일 + D-Day
  const upcoming = [];
  for (let i = 0; i <= 60; i++){ const d = addDays(T, i); eventsOn(d).forEach(e => upcoming.push({d, e})); }

  const dcards = ddays.map(a => {
    const st0 = annivStart(a), n = dayCount(st0, T), nm = nextMilestone(a);
    const future = st0 > T;
    return `<button class="dcard" data-act="anniv" data-id="${a.id}">
      <span class="dc-t">${esc(a.title)}</span>
      <span class="dc-n">${future ? dLabel(st0) : `${n.toLocaleString('ko-KR')}일째`}</span>
      <span class="dc-s">${future ? `${st0.replace(/-/g,'.')} 시작` : nm ? `${nm.k.toLocaleString('ko-KR')}일까지 ${dLabel(nm.date)} · ${parse(nm.date).getMonth()+1}월 ${parse(nm.date).getDate()}일` : ''}</span>
    </button>`;
  }).join('');

  const rows = list.map(({a, next}) => {
    const [y,m,d] = a.date.split('-');
    const orig = `${a.lunar ? '음력 ' : ''}${y}.${m}.${d}`;
    const meta = [kindName(a.kind), orig, a.yearly ? '매년' : '한 번', a.dday ? 'D-Day' : '', a.prepTitle ? `${a.prepDays ? a.prepDays + '일 전' : '당일'} 할 일: ${esc(a.prepTitle)}` : ''].filter(Boolean);
    return `<div class="task" data-row="${a.id}">
      <button class="t-body" data-act="anniv" data-id="${a.id}"><span class="t-title">${esc(a.title)}</span><span class="t-meta">${meta.map(x => `<span>${x}</span>`).join('')}</span></button>
      ${next ? `<span class="dpill">${dLabel(next)}</span>` : ''}</div>`;
  }).join('');

  const up = upcoming.length ? `<section class="sec"><div class="sec-h"><span>앞으로 60일</span></div><div class="list">${upcoming.map(({d, e}) => {
      const dd = parse(d);
      return `<button class="task up" data-act="pickFromLog" data-date="${d}"><span class="up-d">${dd.getMonth()+1}/${dd.getDate()} ${DOW[dd.getDay()]}</span>
        <span class="t-body"><span class="t-title">${esc(e.label)}</span></span><span class="dpill${e.main?'':' soft'}">${dLabel(d)}</span></button>`;
    }).join('')}</div></section>` : '';

  return pageHead('생일, 결혼기념일, D-Day', '기념일') + `
    <button class="pill-btn" data-act="addAnniv" style="align-self:flex-start">+ 기념일 추가</button>
    ${dcards ? `<div class="dgrid">${dcards}</div>` : ''}
    ${up}
    ${rows ? `<section class="sec"><div class="sec-h"><span>모든 기념일 ${annivs.size}</span></div><div class="list">${rows}</div></section>`
           : '<div class="empty"><strong>기념일을 추가해 보세요</strong><p>생일과 결혼기념일은 매년 캘린더에 표시되고, 미리 할 일(예: 선물 준비)을 자동으로 넣어드려요. D-Day를 켜면 100일, 1주년 같은 날도 보여요.</p></div>'}`;
}

function renderTabs(){
  const t = [['day','오늘','day'],['box','보관함','box'],['anniv','기념일','anniv'],['log','기록','log']];
  document.getElementById('tabs').innerHTML = t.map(([k,l,i]) =>
    `<button class="tab" data-act="view" data-view="${k}" ${st.view===k?'aria-current="page"':''}>${ICON[i]}${l}</button>`).join('');
}

let lastToggled = null;
function render(){
  if (!me || !cal) return;
  $app.innerHTML = st.view === 'day' ? renderDay() : st.view === 'box' ? renderBox() : st.view === 'anniv' ? renderAnniv() : renderLog();
  renderTabs();
  if (lastToggled) { const r = $app.querySelector(`[data-row="${lastToggled}"]`); if (r) r.classList.add('pop'); lastToggled = null; }
}

/* ---------- toast ---------- */
let toastTimer;
function toast(msg, undo){
  const root = document.getElementById('toastRoot');
  root.innerHTML = `<div class="toast" role="status"><span>${esc(msg)}</span>${undo?'<button id="undoBtn">되돌리기</button>':''}</div>`;
  if (undo) document.getElementById('undoBtn').onclick = () => { undo(); root.innerHTML = ''; };
  clearTimeout(toastTimer); toastTimer = setTimeout(() => root.innerHTML = '', 3500);
}

/* ---------- task sheet ---------- */
let sheet = null;
function openSheet(t){
  if (t) sheet = {mode:'edit', id:t.id, title:t.title, note:t.note||'', date:t.date||null, cat:t.cat||'etc', armed:false};
  else sheet = {mode:'add', title:'', note:'', date: st.view === 'box' ? null : st.sel, cat: st.cat !== 'all' ? st.cat : 'life', armed:false, showNote:false};
  drawSheet(true);
}
function closeSheet(){ sheet = null; document.getElementById('sheetRoot').innerHTML = ''; }

function dateChips(){
  const T = today();
  const opts = [['오늘',T],['내일',addDays(T,1)],['모레',addDays(T,2)],['일주일 뒤',addDays(T,7)],['날짜 없음',null]];
  const known = opts.some(o => o[1] === sheet.date);
  return opts.map(([l,v]) => `<button class="chip" data-sh="date" data-v="${v??''}" aria-pressed="${sheet.date===v}">${l}</button>`).join('')
    + `<label class="chip" aria-pressed="${!!sheet.date && !known}" style="padding:3px 6px 3px 12px">연도-월-일
        <input class="date-in" type="date" id="shDate" aria-label="날짜 직접 고르기" value="${sheet.date || ''}"></label>`;
}

function drawSheet(focus){
  const s = sheet, isAdd = s.mode === 'add';
  const t = !isAdd && tasks.get(s.id);
  const history = t ? [
    t.createdBy ? `${esc(person(t.createdBy).name)}님이 추가` : '',
    t.done && t.doneBy ? `${esc(person(t.doneBy).name)}님이 ${hhmm(t.doneAt)}에 완료` : '',
  ].filter(Boolean).join(' · ') : '';
  document.getElementById('sheetRoot').innerHTML = `<div class="scrim" data-sh="close"></div>
  <div class="sheet" role="dialog" aria-modal="true" aria-label="${isAdd?'할 일 추가':'할 일 수정'}"><div class="sheet-in">
    <div class="grab"></div>
    <h2>${isAdd?'할 일 추가':'할 일 수정'}</h2>
    <input class="field" id="shTitle" placeholder="무엇을 해야 하나요?" value="${esc(s.title)}" enterkeyhint="${isAdd?'next':'done'}" autocomplete="off">
    ${(!isAdd || s.showNote) ? `<textarea class="field" id="shNote" placeholder="메모">${esc(s.note)}</textarea>` : '<button class="chip" data-sh="note" style="align-self:flex-start">+ 메모</button>'}
    <div class="lbl">날짜</div><div class="chips wrap">${dateChips()}</div>
    <div class="lbl">분류</div><div class="chips">${CATS.map(c => `<button class="chip" data-sh="cat" data-v="${c.id}" aria-pressed="${s.cat===c.id}"><span class="sw" style="background:var(${c.v})"></span>${c.name}</button>`).join('')}</div>
    ${history ? `<p class="hint">${history}</p>` : ''}
    <div class="row">
      ${isAdd ? '<button class="btn" data-sh="close">닫기</button><button class="btn primary" data-sh="save">추가</button>'
              : `<button class="btn danger${s.armed?' armed':''}" data-sh="del">${s.armed?'한 번 더 누르면 삭제':'삭제'}</button><button class="btn primary" data-sh="save">저장</button>`}
    </div>
    ${isAdd ? '<p class="hint" style="text-align:center">키보드의 다음(Enter)을 누르면 이어서 계속 추가할 수 있어요.</p>' : ''}
  </div></div>`;
  const ti = document.getElementById('shTitle');
  ti.addEventListener('input', e => s.title = e.target.value);
  ti.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); commit(isAdd); } });
  const no = document.getElementById('shNote'); if (no) no.addEventListener('input', e => s.note = e.target.value);
  document.getElementById('shDate').addEventListener('change', e => { if (e.target.value) { s.date = e.target.value; drawSheet(false); } });
  if (focus) ti.focus();
}

function commit(keepOpen){
  const s = sheet, title = s.title.trim();
  if (!title) { document.getElementById('shTitle').focus(); return; }
  if (s.mode === 'add') {
    save({id:uuid(), title, note:s.note.trim(), date:s.date, cat:s.cat, done:false, doneAt:null, doneBy:null, createdBy:me.id, createdAt:Date.now()});
    toast('추가했어요');
    if (keepOpen) { s.title = ''; s.note = ''; drawSheet(true); return; }
  } else {
    const t = tasks.get(s.id); if (t) save({...t, title, note:s.note.trim(), date:s.date, cat:s.cat});
  }
  closeSheet();
}

/* ---------- anniversary sheet ---------- */
const PREP_DEFAULT = {birthday:'선물 준비', wedding:'기념일 준비', etc:''};
function openAnnivSheet(a){
  if (a) sheet = {mode:'anniv', id:a.id, title:a.title, kind:a.kind, date:a.date, lunar:a.lunar, yearly:a.yearly, dday:a.dday, prepTitle:a.prepTitle, prepDays:a.prepDays, armed:false};
  else sheet = {mode:'anniv', id:null, title:'', kind:'birthday', date:'', lunar:false, yearly:true, dday:false, prepTitle:PREP_DEFAULT.birthday, prepDays:7, armed:false};
  drawAnnivSheet(true);
}
function drawAnnivSheet(focus){
  const s = sheet, isNew = !s.id;
  const chip = (k, v, on, label) => `<button class="chip" data-an="${k}" data-v="${v}" aria-pressed="${on}">${label}</button>`;
  const toggle = (k, on, label) => `<button class="chip" data-an="${k}" aria-pressed="${on}"><span class="tick">${on ? '✓' : ''}</span>${label}</button>`;
  let preview = '';
  if (s.date && s.dday) {
    const st0 = s.lunar && window.KHoliday ? (window.KHoliday.lunarToSolar(...s.date.split('-').map(Number)) || s.date) : s.date;
    const n = dayCount(st0, today());
    preview = st0 > today() ? `${dLabel(st0)} 남았어요` : `오늘이 ${n.toLocaleString('ko-KR')}일째예요 (시작일을 1일로 셈)`;
  }
  document.getElementById('sheetRoot').innerHTML = `<div class="scrim" data-an="close"></div>
  <div class="sheet" role="dialog" aria-modal="true" aria-label="${isNew?'기념일 추가':'기념일 수정'}"><div class="sheet-in">
    <div class="grab"></div>
    <h2>${isNew?'기념일 추가':'기념일 수정'}</h2>
    <input class="field" id="anTitle" placeholder="이름 (예: 엄마 생신, 우리 결혼기념일)" value="${esc(s.title)}" autocomplete="off">
    <div class="lbl">종류</div><div class="chips">${KINDS.map(k => chip('kind', k.id, s.kind===k.id, k.name)).join('')}</div>
    <div class="lbl">${s.lunar ? '음력 날짜 (태어난 해 또는 시작한 해 포함)' : '날짜 (태어난 날, 결혼한 날, 시작한 날)'}</div>
    <div class="inline"><input class="field" id="anDate" type="date" value="${esc(s.date)}"></div>
    <div class="chips wrap">${toggle('lunar', s.lunar, '음력')}${toggle('yearly', s.yearly, '매년 반복')}${toggle('dday', s.dday, 'D-Day 세기 (100일, 주년)')}</div>
    ${preview ? `<p class="hint">${preview}</p>` : ''}
    <div class="lbl">미리 할 일 (자동 추가)</div>
    <input class="field" id="anPrep" placeholder="예: 선물 준비, 식당 예약 (비우면 추가 안 함)" value="${esc(s.prepTitle)}" autocomplete="off" style="font-size:15px">
    <div class="chips wrap">${[0,1,3,7,14,30].map(d => chip('prepDays', d, s.prepDays===d, d ? d + '일 전' : '당일')).join('')}</div>
    <p class="hint">기념일이 다가오면 그 날짜에 할 일로 들어가요.</p>
    <div class="row">
      ${isNew ? '<button class="btn" data-an="close">닫기</button>'
              : `<button class="btn danger${s.armed?' armed':''}" data-an="del">${s.armed?'한 번 더 누르면 삭제':'삭제'}</button>`}
      <button class="btn primary" data-an="save">${isNew ? '추가' : '저장'}</button>
    </div>
  </div></div>`;
  document.getElementById('anTitle').addEventListener('input', e => s.title = e.target.value);
  document.getElementById('anPrep').addEventListener('input', e => s.prepTitle = e.target.value);
  document.getElementById('anDate').addEventListener('change', e => { s.date = e.target.value; drawAnnivSheet(false); });
  if (focus) document.getElementById('anTitle').focus();
}
function annivAct(k, v){
  const s = sheet;
  if (k === 'close') return closeSheet();
  if (k === 'kind') {
    if (!s.id && (s.prepTitle === '' || Object.values(PREP_DEFAULT).includes(s.prepTitle))) s.prepTitle = PREP_DEFAULT[v];
    s.kind = v;
    return drawAnnivSheet(false);
  }
  if (k === 'lunar' || k === 'yearly' || k === 'dday') { s[k] = !s[k]; return drawAnnivSheet(false); }
  if (k === 'prepDays') { s.prepDays = Number(v); return drawAnnivSheet(false); }
  if (k === 'del') {
    if (!s.armed) { s.armed = true; return drawAnnivSheet(false); }
    const a = annivs.get(s.id); closeSheet();
    if (a) { removeAnniv(a.id); toast('삭제했어요', () => saveAnniv({...a, prepLastOcc:a.prepLastOcc})); }
    return;
  }
  if (k === 'save') {
    const title = s.title.trim();
    if (!title) { document.getElementById('anTitle').focus(); return; }
    if (!s.date) { document.getElementById('anDate').focus(); toast('날짜를 골라주세요'); return; }
    const old = s.id && annivs.get(s.id);
    const changedDate = old && (old.date !== s.date || old.lunar !== s.lunar);
    saveAnniv({id: s.id || uuid(), title, kind:s.kind, date:s.date, lunar:s.lunar, yearly:s.yearly, dday:s.dday,
      prepTitle:s.prepTitle.trim(), prepDays:s.prepDays, prepLastOcc: old && !changedDate ? old.prepLastOcc : null, createdBy: old ? old.createdBy : me.id});
    closeSheet(); toast(s.id ? '저장했어요' : '기념일을 추가했어요');
  }
}

/* ---------- settings sheet ---------- */
let setMsg = null;
function openSettings(){ sheet = {mode:'settings', armed:null}; setMsg = null; drawSettings(); }
function drawSettings(){
  const mine = person(me.id);
  const isOwner = cal.created_by === me.id;
  const calRows = calendars.map(c => `<button class="calrow${c.id===cal.id?' on':''}" data-st="switch" data-v="${c.id}" aria-pressed="${c.id===cal.id}">
      <span class="radio"></span><span class="mi"><strong>${esc(c.name)}</strong><span>${c.personal ? '나만 보는 캘린더' : '함께 쓰는 캘린더'}</span></span>
      <span class="tag">${c.personal ? '개인' : '공유'}</span></button>`).join('');
  const members = [...people.entries()].map(([id,p]) => {
    const kickBtn = isOwner && id !== me.id
      ? `<button class="t-act${sheet.armed===id?' danger-on':''}" data-st="kick" data-v="${id}">${sheet.armed===id?'한 번 더 누르면 내보내기':'내보내기'}</button>` : '';
    const tag = id === me.id ? '<span class="tag">나</span>' : (id === cal.created_by ? '<span class="tag">만든 사람</span>' : '');
    return `<div class="mrow"><span class="av lg" style="--pc:var(${p.color})">${esc(p.name.slice(0,1))}</span>
      <div class="mi"><strong>${esc(p.name)}</strong><span>${esc(p.email || '')}</span></div>${tag}${kickBtn}</div>`;
  }).join('');
  const pend = invites.map(e => `<div class="mrow"><span class="av lg ghost">?</span><div class="mi"><strong>${esc(e)}</strong><span>초대됨 · 이 이메일로 가입하거나 로그인하면 합류해요</span></div>
      <button class="t-act" data-st="uninvite" data-v="${esc(e)}">취소</button></div>`).join('');

  const sharedPart = cal.personal ? `<p class="hint">개인 캘린더는 나만 볼 수 있어요. 함께 쓰려면 위에서 공유 캘린더를 만들거나 고르세요.</p>` : `
    <div class="lbl">함께 쓰는 사람 ${people.size}</div>
    <div>${members}${pend}</div>
    <div class="lbl">이메일로 초대</div>
    <div class="inline"><input class="field" id="stInvite" type="email" inputmode="email" placeholder="상대방 이메일" autocomplete="off"><button class="btn primary" data-st="invite">초대</button></div>
    <p class="hint">상대방이 이 이메일로 가입하거나 로그인하면 바로 합류해요. 앱 주소도 함께 전해주세요: ${esc(location.origin)}</p>
    ${!isOwner ? `<button class="btn danger${sheet.armed==='leave'?' armed':''}" data-st="leave">${sheet.armed==='leave'?'한 번 더 누르면 나가기':'이 캘린더에서 나가기'}</button>` : ''}`;

  document.getElementById('sheetRoot').innerHTML = `<div class="scrim" data-st="close"></div>
  <div class="sheet" role="dialog" aria-modal="true" aria-label="캘린더"><div class="sheet-in">
    <div class="grab"></div>
    <h2>캘린더</h2>
    <div class="callist">${calRows}</div>
    <div class="inline"><input class="field" id="stNewCal" placeholder="새 공유 캘린더 이름 (예: 우리집 할 일)" maxlength="30" autocomplete="off"><button class="btn" data-st="create">만들기</button></div>
    ${setMsg ? `<p class="msg ${setMsg.ok?'ok':'err'}">${esc(setMsg.text)}</p>` : ''}
    <div class="divider"></div>
    <h2 style="font-size:15px">${esc(cal.name)} 설정</h2>
    <div class="lbl">캘린더 이름</div>
    <div class="inline"><input class="field" id="stCalName" value="${esc(cal.name)}" maxlength="30"><button class="btn" data-st="rename">변경</button></div>
    ${sharedPart}
    <div class="divider"></div>
    <div class="lbl">내 이름</div>
    <div class="inline"><input class="field" id="stMyName" value="${esc(mine.name)}" maxlength="20"><button class="btn" data-st="myname">변경</button></div>
    <div class="row"><button class="btn" data-st="logout">로그아웃</button><button class="btn" data-st="close">닫기</button></div>
  </div></div>`;
}

document.getElementById('sheetRoot').addEventListener('click', async e => {
  const an = e.target.closest('[data-an]');
  if (an && sheet && sheet.mode === 'anniv') return annivAct(an.dataset.an, an.dataset.v);
  const st2 = e.target.closest('[data-st]');
  if (st2 && sheet && sheet.mode === 'settings') return settingsAct(st2.dataset.st, st2.dataset.v);
  const b = e.target.closest('[data-sh]'); if (!b || !sheet) return;
  const k = b.dataset.sh;
  if (k === 'close') return closeSheet();
  if (k === 'save') return commit(false);
  if (k === 'note') { sheet.showNote = true; drawSheet(false); document.getElementById('shNote').focus(); return; }
  if (k === 'date') { sheet.date = b.dataset.v || null; return drawSheet(false); }
  if (k === 'cat') { sheet.cat = b.dataset.v; return drawSheet(false); }
  if (k === 'del') {
    if (!sheet.armed) { sheet.armed = true; return drawSheet(false); }
    const t = tasks.get(sheet.id); closeSheet();
    if (t) { remove(t.id); toast('삭제했어요', () => save(t)); }
  }
});

async function settingsAct(k, v){
  if (k === 'close') return closeSheet();
  if (k !== 'kick' && k !== 'leave') sheet.armed = null;
  if (k === 'invite') {
    const email = document.getElementById('stInvite').value.trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) { setMsg = {text:'이메일 주소를 확인해 주세요.'}; return drawSettings(); }
    if ([...people.values()].some(p => (p.email||'').toLowerCase() === email)) { setMsg = {text:'이미 함께 쓰고 있는 사람이에요.'}; return drawSettings(); }
    const { error } = await sb.from('invites').upsert({calendar_id: cal.id, email, invited_by: me.id, accepted_at: null});
    if (error) { setMsg = {text:'초대하지 못했어요: ' + error.message}; return drawSettings(); }
    await loadInvites(); setMsg = {ok:true, text:`${email} 님을 초대했어요.`}; return drawSettings();
  }
  if (k === 'uninvite') {
    await sb.from('invites').delete().eq('calendar_id', cal.id).eq('email', v);
    await loadInvites(); return drawSettings();
  }
  if (k === 'kick') {
    if (sheet.armed !== v) { sheet.armed = v; return drawSettings(); }
    const name = person(v).name;
    const { error } = await sb.from('members').delete().eq('calendar_id', cal.id).eq('user_id', v);
    sheet.armed = null;
    if (error) { setMsg = {text:'내보내지 못했어요: ' + error.message}; return drawSettings(); }
    await loadPeople(); setMsg = {ok:true, text:`${name} 님을 내보냈어요.`}; render(); return drawSettings();
  }
  if (k === 'leave') {
    if (sheet.armed !== 'leave') { sheet.armed = 'leave'; return drawSettings(); }
    const { error } = await sb.from('members').delete().eq('calendar_id', cal.id).eq('user_id', me.id);
    if (error) { setMsg = {text:'나가지 못했어요: ' + error.message}; sheet.armed = null; return drawSettings(); }
    closeSheet(); ls.set('haru-calid', null); tasks.clear(); annivs.clear(); resetEvents();
    return start(me);
  }
  if (k === 'create') {
    const name = document.getElementById('stNewCal').value.trim() || '우리집 할 일';
    const { data: cid, error } = await sb.rpc('create_shared_calendar', {p_name: name});
    if (error) { setMsg = {text:'만들지 못했어요: ' + error.message}; return drawSettings(); }
    await loadCalendars(cid);
    cal = {...(calendars.find(c => c.id === cid) || cal)};
    st.sel = today(); await openCalendar();
    setMsg = {ok:true, text:`'${name}' 캘린더를 만들었어요. 이제 함께 쓸 사람을 초대하세요.`};
    sheet = {mode:'settings', armed:null}; return drawSettings();
  }
  if (k === 'rename') {
    const name = document.getElementById('stCalName').value.trim(); if (!name) return;
    const { error } = await sb.from('calendars').update({name}).eq('id', cal.id);
    if (!error) { cal.name = name; calendars = calendars.map(c => c.id === cal.id ? {...c, name} : c); setMsg = {ok:true, text:'캘린더 이름을 바꿨어요.'}; }
    render(); return drawSettings();
  }
  if (k === 'myname') {
    const name = document.getElementById('stMyName').value.trim(); if (!name) return;
    const { error } = await sb.from('profiles').update({name}).eq('id', me.id);
    if (!error) { const p = people.get(me.id); if (p) p.name = name; setMsg = {ok:true, text:'이름을 바꿨어요.'}; }
    render(); return drawSettings();
  }
  if (k === 'switch') {
    const c = calendars.find(x => x.id === v); if (!c || c.id === cal.id) return;
    cal = {...c}; st.sel = today(); setMsg = null;
    await openCalendar();
    sheet = {mode:'settings', armed:null}; return drawSettings();
  }
  if (k === 'logout') { closeSheet(); await sb.auth.signOut(); return; }
}
document.addEventListener('keydown', e => { if (e.key === 'Escape' && sheet) closeSheet(); });

/* ---------- main actions ---------- */
function setCal(v){ st.cal = v; ls.set('haru-cal', v); if (v === 'week') { st.big = false; ls.set('haru-big', false); } render(); }
function setBig(v){ st.big = v; ls.set('haru-big', v); if (v) { st.cal = 'month'; ls.set('haru-cal', 'month'); } render(); window.scrollTo(0, 0); }
function shiftMonth(dir){
  const d = parse(st.sel), m = new Date(d.getFullYear(), d.getMonth() + dir, 1);
  const T = parse(today());
  st.sel = (m.getFullYear() === T.getFullYear() && m.getMonth() === T.getMonth()) ? today() : ymd(m);
  render();
}

$app.addEventListener('click', onAct);
document.getElementById('tabs').addEventListener('click', onAct);
document.getElementById('fab').addEventListener('click', () => st.view === 'anniv' ? openAnnivSheet(null) : openSheet(null));

function onAct(e){
  const b = e.target.closest('[data-act]'); if (!b) return;
  const a = b.dataset.act, id = b.dataset.id, t = id && tasks.get(id);
  switch (a){
    case 'toggle': if (t) {
      const nt = t.done ? {...t, done:false, doneAt:null, doneBy:null} : {...t, done:true, doneAt:Date.now(), doneBy:me.id};
      lastToggled = t.id; save(nt);
      if (nt.done) toast('완료했어요', () => save(t));
    } break;
    case 'edit': if (t) openSheet(t); break;
    case 'pull': if (t) { save({...t, date: today()}); toast('오늘로 옮겼어요', () => save(t)); } break;
    case 'pullAll': {
      const T = today(), list = [...tasks.values()].filter(x => !x.done && x.date && x.date < T);
      saveMany(list.map(x => ({...x, date:T}))); toast(`${list.length}개를 오늘로 옮겼어요`, () => saveMany(list));
    } break;
    case 'pick': st.sel = b.dataset.date; render(); break;
    case 'pickBig': st.sel = b.dataset.date; setBig(false); break;
    case 'big': setBig(!st.big); break;
    case 'pickFromLog': st.sel = b.dataset.date; st.view = 'day'; render(); break;
    case 'week': st.sel = addDays(st.sel, 7 * Number(b.dataset.dir)); render(); break;
    case 'month': shiftMonth(Number(b.dataset.dir)); break;
    case 'cal': setCal(b.dataset.v); break;
    case 'goToday': st.sel = today(); render(); break;
    case 'cat': st.cat = b.dataset.cat; render(); break;
    case 'toggleDone': st.showDone = !st.showDone; render(); break;
    case 'view': st.view = b.dataset.view; st.cat = 'all'; render(); window.scrollTo(0,0); break;
    case 'logMore': st.logMore = true; render(); break;
    case 'add': openSheet(null); break;
    case 'settings': openSettings(); break;
    case 'addAnniv': openAnnivSheet(null); break;
    case 'anniv': { const a = annivs.get(id); if (a) openAnnivSheet(a); } break;
  }
}

// swipe on calendar
let sx = null, sy = null;
$app.addEventListener('touchstart', e => {
  if (e.target.closest('.cal-swipe')) { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }
}, {passive:true});
$app.addEventListener('touchend', e => {
  if (sx === null) return;
  const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy; sx = sy = null;
  if (Math.abs(dy) > Math.abs(dx) * 1.3 && Math.abs(dy) > 50) {
    if (dy > 0 && !st.big && window.scrollY <= 5) setBig(true);   // 아래로 쓸면 펼치기
    else if (dy < 0 && st.big) setBig(false);                     // 위로 쓸면 접기
    return;
  }
  if (Math.abs(dx) <= 50) return;
  if (st.cal === 'month') shiftMonth(dx < 0 ? 1 : -1);
  else { st.sel = addDays(st.sel, dx < 0 ? 7 : -7); render(); }
}, {passive:true});

// coming back to the app: refresh data and "today"
let lastDay = today();
document.addEventListener('visibilitychange', async () => {
  if (document.hidden || !me || !cal) return;
  if (today() !== lastDay) { if (st.sel === lastDay) st.sel = today(); lastDay = today(); }
  const prev = cal.id;
  await loadCalendars(prev);
  if (!cal) return start(me);
  if (cal.id !== prev) { toast('이 캘린더에서 빠졌어요. 다른 캘린더로 옮겼어요.'); return openCalendar(); }
  await Promise.all([loadTasks(), loadPeople(), loadInvites(), loadAnnivs()]);
  render();
  ensurePrepTasks();
});

/* ---------- boot ---------- */
let started = false;
sb.auth.onAuthStateChange((event, session) => {
  if (session && session.user) {
    if (!started) { started = true; setTimeout(() => start(session.user), 0); }
    else me = session.user;
  } else if (event === 'SIGNED_OUT' || !session) {
    started = false; me = null; cal = null; tasks.clear(); people.clear(); annivs.clear(); resetEvents();
    if (channel) { sb.removeChannel(channel); channel = null; }
    renderAuth();
  }
});
})();
