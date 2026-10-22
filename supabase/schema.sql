-- 하루 할 일: 공동 캘린더 스키마 (Supabase / Postgres)

create extension if not exists pgcrypto;

-- 사용자 표시 정보
create table if not exists public.profiles (
  id uuid primary key references auth.users on delete cascade,
  email text,
  name text
);

-- 공동 캘린더
create table if not exists public.calendars (
  id uuid primary key default gen_random_uuid(),
  name text not null default '우리집 할 일',
  created_by uuid references auth.users on delete set null,
  created_at timestamptz not null default now()
);

-- 캘린더 멤버
create table if not exists public.members (
  calendar_id uuid not null references public.calendars on delete cascade,
  user_id uuid not null references public.profiles on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (calendar_id, user_id)
);

-- 이메일 초대 (아직 수락 전)
create table if not exists public.invites (
  calendar_id uuid not null references public.calendars on delete cascade,
  email text not null,
  invited_by uuid references auth.users on delete set null,
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  primary key (calendar_id, email)
);

-- 할 일
create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  calendar_id uuid not null references public.calendars on delete cascade,
  title text not null,
  note text not null default '',
  date date,
  cat text not null default 'life',
  done boolean not null default false,
  done_at timestamptz,
  done_by uuid references auth.users on delete set null,
  created_by uuid references auth.users on delete set null,
  created_at timestamptz not null default now(),
  updated_by uuid references auth.users on delete set null,
  updated_at timestamptz not null default now()
);
create index if not exists tasks_calendar_idx on public.tasks (calendar_id);

-- 멤버 여부 확인 (RLS 재귀 방지용)
create or replace function public.is_member(cid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.members where calendar_id = cid and user_id = auth.uid());
$$;

-- 로그인 직후 호출: 프로필 생성, 초대 수락, 캘린더가 없으면 새로 만들기
create or replace function public.bootstrap()
returns uuid language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  em text;
  nm text;
  cid uuid;
begin
  if uid is null then raise exception 'not signed in'; end if;
  select email, raw_user_meta_data->>'name' into em, nm from auth.users where id = uid;

  insert into profiles (id, email, name)
  values (uid, em, coalesce(nullif(nm, ''), split_part(em, '@', 1)))
  on conflict (id) do update set email = excluded.email;

  insert into members (calendar_id, user_id)
    select i.calendar_id, uid from invites i where lower(i.email) = lower(em) and i.accepted_at is null
  on conflict do nothing;
  update invites set accepted_at = now() where lower(email) = lower(em) and accepted_at is null;

  select calendar_id into cid from members where user_id = uid order by joined_at limit 1;
  if cid is null then
    insert into calendars (name, created_by) values ('우리집 할 일', uid) returning id into cid;
    insert into members (calendar_id, user_id) values (cid, uid);
  end if;
  return cid;
end $$;

revoke execute on function public.bootstrap() from anon, public;
revoke execute on function public.is_member(uuid) from anon, public;
grant execute on function public.bootstrap() to authenticated;
grant execute on function public.is_member(uuid) to authenticated;

-- RLS
alter table public.profiles  enable row level security;
alter table public.calendars enable row level security;
alter table public.members   enable row level security;
alter table public.invites   enable row level security;
alter table public.tasks     enable row level security;

drop policy if exists "profiles read" on public.profiles;
create policy "profiles read" on public.profiles for select to authenticated
  using (id = auth.uid() or exists (select 1 from public.members m where m.user_id = profiles.id and public.is_member(m.calendar_id)));
drop policy if exists "profiles update own" on public.profiles;
create policy "profiles update own" on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists "calendars read" on public.calendars;
create policy "calendars read" on public.calendars for select to authenticated using (public.is_member(id));
drop policy if exists "calendars update" on public.calendars;
create policy "calendars update" on public.calendars for update to authenticated
  using (public.is_member(id)) with check (public.is_member(id));

drop policy if exists "members read" on public.members;
create policy "members read" on public.members for select to authenticated using (public.is_member(calendar_id));

drop policy if exists "invites read" on public.invites;
create policy "invites read" on public.invites for select to authenticated using (public.is_member(calendar_id));
drop policy if exists "invites create" on public.invites;
create policy "invites create" on public.invites for insert to authenticated
  with check (public.is_member(calendar_id) and invited_by = auth.uid());
drop policy if exists "invites delete" on public.invites;
create policy "invites delete" on public.invites for delete to authenticated using (public.is_member(calendar_id));

drop policy if exists "tasks all" on public.tasks;
create policy "tasks all" on public.tasks for all to authenticated
  using (public.is_member(calendar_id)) with check (public.is_member(calendar_id));

-- 실시간 동기화
alter table public.tasks replica identity full;
do $$ begin
  alter publication supabase_realtime add table public.tasks;
exception when duplicate_object then null; end $$;

-- 기념일 / D-Day
create table if not exists public.anniversaries (
  id uuid primary key default gen_random_uuid(),
  calendar_id uuid not null references public.calendars on delete cascade,
  title text not null,
  kind text not null default 'etc',
  date date not null,
  lunar boolean not null default false,
  yearly boolean not null default true,
  dday boolean not null default false,
  prep_title text not null default '',
  prep_days int not null default 0,
  prep_last_occ date,
  created_by uuid references auth.users on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists anniversaries_calendar_idx on public.anniversaries (calendar_id);
alter table public.anniversaries enable row level security;
create policy "anniversaries all" on public.anniversaries for all to authenticated
  using (public.is_member(calendar_id)) with check (public.is_member(calendar_id));

alter table public.tasks add column if not exists anniv_id uuid references public.anniversaries on delete set null;
alter table public.tasks add column if not exists anniv_occ date;
create unique index if not exists tasks_anniv_occ_uniq on public.tasks (anniv_id, anniv_occ);

alter table public.anniversaries replica identity full;
alter publication supabase_realtime add table public.anniversaries;

-- 개인 캘린더, 공유 캘린더 만들기, 내보내기/나가기, 재초대
alter table public.calendars add column if not exists personal boolean not null default false;
-- bootstrap(): 초대 수락 + 개인 캘린더('내 캘린더') 보장 (위 정의를 대체, 배포본 기준)
-- create_shared_calendar(p_name text): 공유 캘린더 생성 후 만든 사람을 멤버로 추가
create policy "members remove" on public.members for delete to authenticated
  using (
    user_id = (select auth.uid())
    or exists (select 1 from public.calendars c where c.id = members.calendar_id and c.created_by = (select auth.uid()) and not c.personal)
  );
alter policy "invites create" on public.invites
  with check (
    public.is_member(calendar_id) and invited_by = (select auth.uid())
    and not exists (select 1 from public.calendars c where c.id = invites.calendar_id and c.personal)
  );
create policy "invites update" on public.invites for update to authenticated
  using (public.is_member(calendar_id))
  with check (
    public.is_member(calendar_id) and invited_by = (select auth.uid())
    and not exists (select 1 from public.calendars c where c.id = invites.calendar_id and c.personal)
  );

-- 푸시 알림 (아침/저녁 요약)
-- push_subscriptions: 기기별 구독 / notif_settings: 사람별 시간 설정
-- 비밀값(VAPID 키, cron 토큰)은 Supabase Vault에 haru_vapid_public / haru_vapid_private / haru_cron_token 으로 보관
-- public.push_config(): service_role 전용으로 Vault 값을 읽음
-- pg_cron 'haru-notify' 작업이 5분마다 functions/v1/notify 를 호출
