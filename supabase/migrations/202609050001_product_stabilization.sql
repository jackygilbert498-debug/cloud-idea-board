-- Product-level consistency invariants for retries, attachments, focus and AI quota.
-- This migration is transactional and repeatable; published 20260824 migrations stay immutable.

begin;
select pg_advisory_xact_lock(hashtextextended('cloud-memo-board/schema-migrations', 0));

alter table public.cards add column if not exists client_request_id uuid;
create unique index if not exists cards_owner_client_request_idx
  on public.cards(user_id, client_request_id);

alter table public.attachments
  add column if not exists state text,
  add column if not exists updated_at timestamptz;

-- Existing attachment metadata describes objects that completed the old upload flow.
update public.attachments set state = 'ready' where state is null;
update public.attachments set updated_at = coalesce(created_at, now()) where updated_at is null;

alter table public.attachments
  alter column state set default 'pending',
  alter column state set not null,
  alter column updated_at set default now(),
  alter column updated_at set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'attachments_state_check'
      and conrelid = 'public.attachments'::regclass
  ) then
    alter table public.attachments add constraint attachments_state_check
      check (state in ('pending', 'ready', 'deleting'));
  end if;
end;
$$;

create or replace function public.touch_updated_at()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists attachments_touch_updated_at on public.attachments;
create trigger attachments_touch_updated_at before update on public.attachments
for each row execute function public.touch_updated_at();

create or replace function public.enforce_focus_limit()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare active_focus_count integer;
begin
  if new.focus and not new.archived and (tg_op = 'INSERT' or not old.focus or old.archived) then
    -- Serialize acquisition per owner before observing the current focus set.
    perform pg_advisory_xact_lock(hashtextextended(new.user_id::text, 0));
    select count(*) into active_focus_count
    from public.cards
    where user_id = new.user_id and focus and not archived and id <> coalesce(new.id, 0);
    if active_focus_count >= 3 then
      raise exception '今日焦点最多保留 3 条';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists cards_enforce_focus_limit on public.cards;
create trigger cards_enforce_focus_limit before insert or update of focus, archived on public.cards
for each row execute function public.enforce_focus_limit();

create table if not exists public.ai_usage_daily (
  day date not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  count integer not null default 0 check (count >= 0),
  updated_at timestamptz not null default now(),
  primary key (day, user_id)
);

create or replace function public.reorder_attachments(
  p_card_id bigint,
  p_attachment_ids uuid[]
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  expected_count integer;
  provided_count integer;
  distinct_count integer;
begin
  perform 1
  from public.cards
  where id = p_card_id and user_id = auth.uid()
  for update;
  if not found then
    raise exception '无权调整此卡片的附件';
  end if;

  select count(*) into expected_count
  from public.attachments
  where card_id = p_card_id and user_id = auth.uid() and state = 'ready';

  provided_count := cardinality(coalesce(p_attachment_ids, array[]::uuid[]));
  select count(distinct attachment_id) into distinct_count
  from unnest(coalesce(p_attachment_ids, array[]::uuid[])) as supplied(attachment_id);

  if provided_count <> expected_count
     or distinct_count <> expected_count
     or exists (
       select 1
       from public.attachments
       where card_id = p_card_id
         and user_id = auth.uid()
         and state = 'ready'
         and not (id = any(coalesce(p_attachment_ids, array[]::uuid[])))
     ) then
    raise exception '附件集合不匹配';
  end if;

  update public.attachments as attachment
  set sort_order = supplied.ordinality - 1
  from unnest(coalesce(p_attachment_ids, array[]::uuid[]))
    with ordinality as supplied(id, ordinality)
  where attachment.id = supplied.id
    and attachment.card_id = p_card_id
    and attachment.user_id = auth.uid()
    and attachment.state = 'ready';
end;
$$;

create or replace function public.consume_ai_daily_quota(
  p_user_id uuid,
  p_limit integer
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  usage_day date := timezone('utc', statement_timestamp())::date;
  next_count integer;
begin
  if p_user_id is null then
    raise exception 'p_user_id is required' using errcode = '22004';
  end if;
  if p_limit is null or p_limit < 1 then
    raise exception 'p_limit must be positive' using errcode = '22023';
  end if;

  insert into public.ai_usage_daily (day, user_id, count, updated_at)
  values (usage_day, p_user_id, 1, now())
  on conflict (day, user_id) do update
    set count = public.ai_usage_daily.count + 1,
        updated_at = now()
    where public.ai_usage_daily.count < p_limit
  returning count into next_count;

  if next_count is null then
    raise exception 'AI_DAILY_QUOTA_EXCEEDED';
  end if;

  return next_count;
end;
$$;

alter table public.attachments enable row level security;
alter table public.ai_usage_daily enable row level security;

drop policy if exists "Attachments are private to their owner" on public.attachments;
create policy "Attachments are private to their owner" on public.attachments
for select to authenticated using (user_id = auth.uid());

drop policy if exists "Owners add attachments to their own cards" on public.attachments;
create policy "Owners add attachments to their own cards" on public.attachments
for insert to authenticated with check (
  user_id = auth.uid()
  and split_part(object_key, '/', 1) = auth.uid()::text
  and exists (
    select 1 from public.cards where cards.id = card_id and cards.user_id = auth.uid()
  )
);

drop policy if exists "Owners update their own attachments" on public.attachments;
create policy "Owners update their own attachments" on public.attachments
for update to authenticated using (user_id = auth.uid()) with check (
  user_id = auth.uid()
  and split_part(object_key, '/', 1) = auth.uid()::text
  and exists (
    select 1 from public.cards where cards.id = card_id and cards.user_id = auth.uid()
  )
);

drop policy if exists "Owners delete their own attachments" on public.attachments;
create policy "Owners delete their own attachments" on public.attachments
for delete to authenticated using (user_id = auth.uid());

revoke all on table public.ai_usage_daily from public, anon, authenticated;
revoke all on function public.reorder_attachments(bigint, uuid[]) from public, anon;
grant execute on function public.reorder_attachments(bigint, uuid[]) to authenticated;
revoke all on function public.consume_ai_daily_quota(uuid, integer)
  from public, anon, authenticated;
grant execute on function public.consume_ai_daily_quota(uuid, integer) to service_role;

commit;
