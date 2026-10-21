// 한국 공휴일 계산기 (2026년부터)
// - 양력 고정 공휴일 + 음력 공휴일(설날, 부처님오신날, 추석)
// - 대체공휴일 규칙: 설날/추석 연휴가 일요일이나 다른 공휴일과 겹치면 연휴 뒤 첫 평일,
//   그 밖의 대상 공휴일이 토/일요일이나 다른 공휴일과 겹치면 다음 첫 평일
// - 선거일, 임시공휴일은 정해질 때마다 EXTRA에 추가
// - 회사 창립기념일 같은 개인 휴일은 CUSTOM에 정의
(function (root) {
  'use strict';
  const pad = n => String(n).padStart(2, '0');
  const ymd = d => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const utc = (y, m, d) => new Date(Date.UTC(y, m - 1, d));
  const addD = (d, n) => new Date(d.getTime() + n * 86400000);

  // 음력(한국) 변환: 양력 연도 안에서 음력 월/일 찾기
  let fmt = null;
  try { fmt = new Intl.DateTimeFormat('en-u-ca-dangi', { month: 'numeric', day: 'numeric', timeZone: 'UTC' }); } catch (e) {}
  const lunarCache = {};
  function lunarMap(y) {
    if (lunarCache[y]) return lunarCache[y];
    const map = {};
    if (fmt) {
      for (let d = utc(y, 1, 1); d.getUTCFullYear() === y; d = addD(d, 1)) {
        const p = fmt.formatToParts(d);
        const m = p.find(x => x.type === 'month').value, dd = p.find(x => x.type === 'day').value;
        if (/bis/.test(m)) continue; // 윤달 제외
        const k = `${m}-${dd}`;
        if (!map[k]) map[k] = ymd(d);
      }
    }
    return (lunarCache[y] = map);
  }
  // 음력 날짜 -> 그 해 양력 날짜 (30일이 없는 달이면 29일로)
  function lunarToSolar(y, m, d) {
    const map = lunarMap(y);
    return map[`${m}-${d}`] || (d === 30 ? map[`${m}-29`] : null) || null;
  }

  const EXTRA = {
    '2026-06-03': '지방선거',
  };

  // 개인 휴일 규칙
  const CUSTOM = [
    { name: '창립기념일', on: y => nthWeekday(y, 4, 5, 2) }, // 4월 둘째 주 금요일
  ];
  function nthWeekday(y, month, dow, n) {
    const first = utc(y, month, 1);
    const off = (dow - first.getUTCDay() + 7) % 7;
    return ymd(addD(first, off + (n - 1) * 7));
  }

  const yearCache = {};
  function forYear(y) {
    if (yearCache[y]) return yearCache[y];
    const list = []; // {date, name, sub:'A'|'L'|null, grp}
    const fixed = [
      ['01-01', '신정', null], ['03-01', '삼일절', 'A'], ['05-01', '근로자의 날', 'A'], ['05-05', '어린이날', 'A'],
      ['06-06', '현충일', null], ['07-17', '제헌절', 'A'], ['08-15', '광복절', 'A'], ['10-03', '개천절', 'A'],
      ['10-09', '한글날', 'A'], ['12-25', '성탄절', 'A'],
    ];
    fixed.forEach(([md, name, sub]) => list.push({ date: `${y}-${md}`, name, sub }));

    const period = (center, name, grp) => {
      if (!center) return;
      const c = new Date(center + 'T00:00:00Z');
      [-1, 0, 1].forEach(i => list.push({ date: ymd(addD(c, i)), name: i === 0 ? name : `${name} 연휴`, sub: 'L', grp }));
    };
    period(lunarToSolar(y, 1, 1), '설날', 'seol');
    const buddha = lunarToSolar(y, 4, 8);
    if (buddha) list.push({ date: buddha, name: '부처님오신날', sub: 'A' });
    period(lunarToSolar(y, 8, 15), '추석', 'chuseok');
    Object.keys(EXTRA).filter(k => k.startsWith(y + '-')).forEach(k => list.push({ date: k, name: EXTRA[k], sub: null }));

    const map = {};
    list.forEach(h => { (map[h.date] = map[h.date] || []).push(h.name); });
    const isOff = s => { const wd = new Date(s + 'T00:00:00Z').getUTCDay(); return wd === 0 || wd === 6 || !!map[s]; };
    const nextFree = s => { let d = new Date(s + 'T00:00:00Z'); do { d = addD(d, 1); } while (isOff(ymd(d))); return ymd(d); };

    // 설날/추석 연휴
    ['seol', 'chuseok'].forEach(g => {
      const days = list.filter(h => h.grp === g).map(h => h.date).sort();
      if (!days.length) return;
      const hit = days.some(s => new Date(s + 'T00:00:00Z').getUTCDay() === 0 || map[s].length > 1);
      if (hit) { const s = nextFree(days[days.length - 1]); (map[s] = map[s] || []).push('대체공휴일'); }
    });
    // 단일 공휴일
    // (같은 날 겹친 공휴일이 여럿이어도 대체공휴일은 하루)
    [...new Set(list.filter(h => h.sub === 'A').map(h => h.date))].sort().forEach(d => {
      const wd = new Date(d + 'T00:00:00Z').getUTCDay();
      // 설날/추석 연휴와 겹친 경우는 연휴 쪽 대체공휴일 하나로 처리
      const inPeriod = list.some(h => h.sub === 'L' && h.date === d);
      if (wd === 0 || wd === 6 || (map[d].length > 1 && !inPeriod)) {
        const s = nextFree(d); (map[s] = map[s] || []).push('대체공휴일');
      }
    });
    // 개인 휴일 (대체공휴일 없음)
    CUSTOM.forEach(c => { const s = c.on(y); (map[s] = map[s] || []).push(c.name); });

    const out = {};
    Object.keys(map).forEach(k => { out[k] = [...new Set(map[k])].join(' · '); });
    return (yearCache[y] = out);
  }

  function holidayName(s) {
    const y = Number(s.slice(0, 4));
    if (y < 2026 || y > 2100) return null;
    return forYear(y)[s] || null;
  }

  const api = { holidayName, forYear, lunarToSolar, supported: !!fmt };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KHoliday = api;
})(typeof window !== 'undefined' ? window : globalThis);
