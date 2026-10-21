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
    select calendar_id, uid from invites where lower(email) = lower(em)
  on conflict do nothing;
  delete from invites where lower(email) = lower(em);

  select calendar_id into cid from members where user_id = uid order by joined_at limit 1;
  if cid is null then
    insert into calendars (name, created_by) values ('우리집 할 일', uid) returning id into cid;
    insert into members (calendar_id, user_id) values (cid, uid);
  end if;
  return cid;
end $$;

-- 캘린더 나가기
create or replace function public.leave_calendar(cid uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  delete from members where calendar_id = cid and user_id = auth.uid();
  delete from calendars c where c.id = cid and not exists (select 1 from members m where m.calendar_id = cid);
end $$;

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
