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

// 한국 공휴일 (대체공휴일 포함). 출처: kholidayz.com, 2026-10 확인
const HOLI = {
  '2026-01-01':'신정','2026-02-16':'설날 연휴','2026-02-17':'설날','2026-02-18':'설날 연휴',
  '2026-03-01':'삼일절','2026-03-02':'대체공휴일','2026-05-01':'노동절','2026-05-05':'어린이날',
  '2026-05-24':'부처님오신날','2026-05-25':'대체공휴일','2026-06-03':'지방선거','2026-06-06':'현충일',
  '2026-07-17':'제헌절','2026-08-15':'광복절','2026-08-17':'대체공휴일','2026-09-24':'추석 연휴',
  '2026-09-25':'추석','2026-09-26':'추석 연휴','2026-10-03':'개천절','2026-10-05':'대체공휴일',
  '2026-10-09':'한글날','2026-12-25':'성탄절',
  '2027-01-01':'신정','2027-02-06':'설날 연휴','2027-02-07':'설날','2027-02-08':'설날 연휴','2027-02-09':'대체공휴일',
  '2027-03-01':'삼일절','2027-05-01':'노동절','2027-05-03':'대체공휴일','2027-05-05':'어린이날',
  '2027-05-13':'부처님오신날','2027-06-06':'현충일','2027-07-17':'제헌절','2027-07-19':'대체공휴일',
  '2027-08-15':'광복절','2027-08-16':'대체공휴일','2027-09-14':'추석 연휴','2027-09-15':'추석',
  '2027-09-16':'추석 연휴','2027-10-03':'개천절','2027-10-04':'대체공휴일','2027-10-09':'한글날',
  '2027-10-11':'대체공휴일','2027-12-25':'성탄절','2027-12-27':'대체공휴일',
};

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

const st = {
  view:'day', sel: today(), cat:'all', showDone:true, logMore:false,
  cal: ls.get('haru-cal') === 'week' ? 'week' : 'month',
};

const rowToTask = r => ({
  id:r.id, title:r.title, note:r.note || '', date:r.date || null, cat:r.cat,
  done:!!r.done, doneAt:r.done_at ? Date.parse(r.done_at) : null, doneBy:r.done_by,
  createdBy:r.created_by, createdAt:r.created_at ? Date.parse(r.created_at) : 0,
});
const taskToRow = t => ({
  id:t.id, calendar_id:cal.id, title:t.title, note:t.note || '', date:t.date || null, cat:t.cat,
  done:!!t.done, done_at:t.doneAt ? new Date(t.doneAt).toISOString() : null, done_by:t.done ? (t.doneBy || null) : null,
  created_by:t.createdBy || me.id, created_at:new Date(t.createdAt || Date.now()).toISOString(),
  updated_by:me.id, updated_at:new Date().toISOString(),
});

function cacheKey(){ return 'haru-cache-' + (cal && cal.id); }
function writeCache(){ if (cal) ls.set(cacheKey(), [...tasks.values()]); }

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
  const { data } = await sb.from('members').select('calendar_id, calendars(id, name)').eq('user_id', me.id);
  calendars = (data || []).map(r => r.calendars).filter(Boolean);
  const saved = ls.get('haru-calid');
  const pick = calendars.find(c => c.id === saved) || calendars.find(c => c.id === fallback) || calendars[0];
  cal = pick ? {...pick} : null;
}

async function openCalendar(){
  if (!cal) return;
  ls.set('haru-calid', cal.id);
  tasks.clear();
  (ls.get(cacheKey()) || []).forEach(t => t && t.id && tasks.set(t.id, t));
  showMain(); render();
  await Promise.all([loadPeople(), loadTasks(), loadInvites()]);
  subscribe();
  render();
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
    <span>${esc(cal ? cal.name : '')}</span><span class="avs">${avs}</span></button>`;
}

function renderDay(){
  const T = today(), sel = st.sel, d = parse(sel);
  const all = [...tasks.values()];
  const isToday = sel === T;
  const undoneOn = s => all.filter(t => !t.done && t.date === s).length;
  const dots = n => `<span class="dots">${'<i></i>'.repeat(Math.min(n,3))}</span>`;

  let calHTML = '';
  if (st.cal === 'week') {
    const start = addDays(sel, -d.getDay());
    let week = '';
    for (let i = 0; i < 7; i++){
      const s = addDays(start, i), n = undoneOn(s), dd = parse(s);
      const cls = ['day', i===0?'sun':'', HOLI[s]?'hol':'', s===T?'today':'', s===sel?'sel':''].join(' ');
      week += `<button class="${cls}" data-act="pick" data-date="${s}" aria-label="${dd.getMonth()+1}월 ${dd.getDate()}일${HOLI[s]?' '+HOLI[s]:''}, 할 일 ${n}개">
        <span class="dw">${DOW[i]}</span><span class="dn">${dd.getDate()}</span>${dots(n)}</button>`;
    }
    calHTML = `<div class="week cal-swipe">
      <button class="wk-nav" data-act="week" data-dir="-1" aria-label="이전 주">‹</button>${week}
      <button class="wk-nav" data-act="week" data-dir="1" aria-label="다음 주">›</button></div>`;
  } else {
    const first = new Date(d.getFullYear(), d.getMonth(), 1);
    const gStart = addDays(ymd(first), -first.getDay());
    let cells = DOW.map((x,i) => `<div class="hd${i===0?' sun':''}">${x}</div>`).join('');
    for (let i = 0; i < 42; i++){
      const s = addDays(gStart, i), dd = parse(s), n = undoneOn(s);
      const cls = ['mday', i%7===0?'sun':'', HOLI[s]?'hol':'', dd.getMonth()!==d.getMonth()?'out':'', s===T?'today':'', s===sel?'sel':''].join(' ');
      cells += `<button class="${cls}" data-act="pick" data-date="${s}" aria-label="${dd.getMonth()+1}월 ${dd.getDate()}일${HOLI[s]?' '+HOLI[s]:''}, 할 일 ${n}개">
        <span class="dn">${dd.getDate()}</span>${dots(n)}</button>`;
    }
    calHTML = `<div class="month cal-swipe"><div class="m-head">
      <button class="wk-nav" data-act="month" data-dir="-1" aria-label="이전 달">‹</button>
      <span>${d.getFullYear()}년 ${d.getMonth()+1}월</span>
      <button class="wk-nav" data-act="month" data-dir="1" aria-label="다음 달">›</button></div>
      <div class="m-grid">${cells}</div></div>`;
  }

  const overdue = isToday ? all.filter(t => !t.done && t.date && t.date < T).sort((a,b)=> a.date < b.date ? -1 : 1) : [];
  const dayTodo = all.filter(t => !t.done && t.date === sel).sort(byCreated);
  const dayDone = all.filter(t => t.done && doneDay(t) === sel).sort((a,b)=> b.doneAt - a.doneAt);
  const pool = [...overdue, ...dayTodo, ...dayDone];
  const o = overdue.filter(inCat), td = dayTodo.filter(inCat), dn = dayDone.filter(inCat);
  const totalNow = pool.length;
  const pct = totalNow ? Math.round(dayDone.length / totalNow * 100) : 0;

  let body = '';
  if (o.length) body += `<section class="sec"><div class="sec-h warn"><span>밀린 일 ${o.length}</span><button data-act="pullAll">모두 오늘로</button></div>
    <div class="list">${o.map(t => taskRow(t, {late: diffDays(T, t.date), action:{k:'pull', label:'오늘로'}})).join('')}</div></section>`;
  if (td.length) body += `<section class="sec"><div class="sec-h"><span>${isToday?'오늘 할 일':'이 날 할 일'} ${td.length}</span></div>
    <div class="list">${td.map(t => taskRow(t)).join('')}</div></section>`;

  if (!o.length && !td.length){
    if (tasks.size === 0) {
      body += `<div class="empty"><strong>첫 할 일을 적어보세요</strong>
        <p>날짜를 정한 일은 그날에, 언젠가 할 일은 보관함에 모여요. 끝내지 못한 일은 다음 날로 넘어와요.</p>
        <button class="pill-btn" data-act="add">할 일 추가</button>
        ${people.size < 2 ? '<button class="pill-btn" data-act="settings">함께 쓸 사람 초대</button>' : ''}</div>`;
    } else if (!dn.length) {
      body += `<div class="empty"><strong>${isToday?'오늘은 비어 있어요':'이 날은 비어 있어요'}</strong><p>오른쪽 아래 + 버튼으로 할 일을 추가하세요.</p></div>`;
    } else {
      body += `<div class="empty"><strong>모두 끝냈어요</strong><p>${dn.length}개를 완료했어요.</p></div>`;
    }
  }
  if (dn.length) body += `<section class="sec"><div class="sec-h"><span>완료 ${dn.length}</span><button data-act="toggleDone">${st.showDone?'접기':'펼치기'}</button></div>
    ${st.showDone ? `<div class="list">${dn.map(t => taskRow(t)).join('')}</div>` : ''}</section>`;

  const red = isToday || HOLI[sel] || d.getDay() === 0;
  return `
  <header class="top">
    <div class="date-big">
      <div class="date-num${red?' red':''}">${d.getDate()}</div>
      <div class="date-meta"><span class="date-month">${d.getFullYear()}년 ${d.getMonth()+1}월</span>
        <span class="date-dow">${DOW_FULL[d.getDay()]}</span><span class="date-rel">${relLabel(sel)}</span>
        ${HOLI[sel] ? `<span class="date-hol">${HOLI[sel]}</span>` : ''}</div>
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

function renderTabs(){
  const t = [['day','오늘','day'],['box','보관함','box'],['log','기록','log']];
  document.getElementById('tabs').innerHTML = t.map(([k,l,i]) =>
    `<button class="tab" data-act="view" data-view="${k}" ${st.view===k?'aria-current="page"':''}>${ICON[i]}${l}</button>`).join('');
}

let lastToggled = null;
function render(){
  if (!me || !cal) return;
  $app.innerHTML = st.view === 'day' ? renderDay() : st.view === 'box' ? renderBox() : renderLog();
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

/* ---------- settings sheet ---------- */
let setMsg = null;
function openSettings(){ sheet = {mode:'settings'}; setMsg = null; drawSettings(); }
function drawSettings(){
  const mine = person(me.id);
  const members = [...people.entries()].map(([id,p]) => `<div class="mrow">
      <span class="av lg" style="--pc:var(${p.color})">${esc(p.name.slice(0,1))}</span>
      <div class="mi"><strong>${esc(p.name)}</strong><span>${esc(p.email || '')}</span></div>
      ${id === me.id ? '<span class="tag">나</span>' : ''}</div>`).join('');
  const pend = invites.map(e => `<div class="mrow"><div class="mi"><strong>${esc(e)}</strong><span>가입하거나 로그인하면 자동으로 합류해요</span></div>
      <button class="t-act" data-st="uninvite" data-v="${esc(e)}">취소</button></div>`).join('');
  const switcher = calendars.length > 1 ? `<div class="lbl">캘린더 선택</div><div class="chips wrap">${calendars.map(c =>
      `<button class="chip" data-st="switch" data-v="${c.id}" aria-pressed="${c.id===cal.id}">${esc(c.name)}</button>`).join('')}</div>` : '';
  document.getElementById('sheetRoot').innerHTML = `<div class="scrim" data-st="close"></div>
  <div class="sheet" role="dialog" aria-modal="true" aria-label="캘린더 설정"><div class="sheet-in">
    <div class="grab"></div>
    <h2>캘린더 설정</h2>
    ${switcher}
    <div class="lbl">캘린더 이름</div>
    <div class="inline"><input class="field" id="stCalName" value="${esc(cal.name)}" maxlength="30"><button class="btn" data-st="rename">변경</button></div>
    <div class="lbl">함께 쓰는 사람</div>
    <div>${members}${pend}</div>
    <div class="lbl">이메일로 초대</div>
    <div class="inline"><input class="field" id="stInvite" type="email" inputmode="email" placeholder="상대방 이메일" autocomplete="off"><button class="btn primary" data-st="invite">초대</button></div>
    <p class="hint">상대방이 이 이메일로 가입하거나 로그인하면 이 캘린더에 바로 합류해요. 앱 주소는 따로 전해주세요: ${esc(location.origin)}</p>
    ${setMsg ? `<p class="msg ${setMsg.ok?'ok':'err'}">${esc(setMsg.text)}</p>` : ''}
    <div class="lbl">내 이름</div>
    <div class="inline"><input class="field" id="stMyName" value="${esc(mine.name)}" maxlength="20"><button class="btn" data-st="myname">변경</button></div>
    <div class="row">
      <button class="btn" data-st="logout">로그아웃</button>
    </div>
    <button class="btn" data-st="close">닫기</button>
  </div></div>`;
}

document.getElementById('sheetRoot').addEventListener('click', async e => {
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
  if (k === 'invite') {
    const email = document.getElementById('stInvite').value.trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) { setMsg = {text:'이메일 주소를 확인해 주세요.'}; return drawSettings(); }
    if ([...people.values()].some(p => (p.email||'').toLowerCase() === email)) { setMsg = {text:'이미 함께 쓰고 있는 사람이에요.'}; return drawSettings(); }
    const { error } = await sb.from('invites').insert({calendar_id: cal.id, email, invited_by: me.id});
    if (error && !String(error.code).startsWith('23')) { setMsg = {text:'초대하지 못했어요: ' + error.message}; return drawSettings(); }
    await loadInvites(); setMsg = {ok:true, text:`${email} 님을 초대했어요.`}; return drawSettings();
  }
  if (k === 'uninvite') {
    await sb.from('invites').delete().eq('calendar_id', cal.id).eq('email', v);
    await loadInvites(); return drawSettings();
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
    cal = {...c}; closeSheet(); st.sel = today(); return openCalendar();
  }
  if (k === 'logout') { closeSheet(); await sb.auth.signOut(); return; }
}
document.addEventListener('keydown', e => { if (e.key === 'Escape' && sheet) closeSheet(); });

/* ---------- main actions ---------- */
function setCal(v){ st.cal = v; ls.set('haru-cal', v); render(); }
function shiftMonth(dir){
  const d = parse(st.sel), m = new Date(d.getFullYear(), d.getMonth() + dir, 1);
  const T = parse(today());
  st.sel = (m.getFullYear() === T.getFullYear() && m.getMonth() === T.getMonth()) ? today() : ymd(m);
  render();
}

$app.addEventListener('click', onAct);
document.getElementById('tabs').addEventListener('click', onAct);
document.getElementById('fab').addEventListener('click', () => openSheet(null));

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
  }
}

// swipe on calendar
let sx = null;
$app.addEventListener('touchstart', e => { if (e.target.closest('.cal-swipe')) sx = e.touches[0].clientX; }, {passive:true});
$app.addEventListener('touchend', e => {
  if (sx === null) return; const dx = e.changedTouches[0].clientX - sx; sx = null;
  if (Math.abs(dx) <= 50) return;
  if (st.cal === 'month') shiftMonth(dx < 0 ? 1 : -1);
  else { st.sel = addDays(st.sel, dx < 0 ? 7 : -7); render(); }
}, {passive:true});

// coming back to the app: refresh data and "today"
let lastDay = today();
document.addEventListener('visibilitychange', async () => {
  if (document.hidden || !me || !cal) return;
  if (today() !== lastDay) { if (st.sel === lastDay) st.sel = today(); lastDay = today(); }
  await Promise.all([loadTasks(), loadPeople(), loadInvites()]);
  render();
});

/* ---------- boot ---------- */
let started = false;
sb.auth.onAuthStateChange((event, session) => {
  if (session && session.user) {
    if (!started) { started = true; setTimeout(() => start(session.user), 0); }
    else me = session.user;
  } else if (event === 'SIGNED_OUT' || !session) {
    started = false; me = null; cal = null; tasks.clear(); people.clear();
    if (channel) { sb.removeChannel(channel); channel = null; }
    renderAuth();
  }
});
})();
