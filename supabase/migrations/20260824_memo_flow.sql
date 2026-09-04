-- Safe, repeatable upgrade for an existing 云端构思板 Supabase project.
-- Adds durable completion history and attachment cover ordering without deleting data.

begin;

alter table public.cards add column if not exists completed_at timestamptz;
alter table public.cards add column if not exists previous_stage text;
-- Backfill only while introducing the column. Existing values may be user-defined;
-- neither a rerun nor a database already upgraded elsewhere may reset them.
lock table public.attachments in access exclusive mode;
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'attachments' and column_name = 'sort_order'
  ) then
    alter table public.attachments add column sort_order integer not null default 0;
    with ranked as (
      select id, row_number() over (partition by card_id order by created_at, id) - 1 as position
      from public.attachments
    )
    update public.attachments as attachment
    set sort_order = ranked.position
    from ranked
    where attachment.id = ranked.id;
  end if;
end;
$$;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'cards_previous_stage_check') then
    alter table public.cards add constraint cards_previous_stage_check
      check (previous_stage is null or previous_stage in ('idea', 'todo', 'doing'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'attachments_sort_order_check') then
    alter table public.attachments add constraint attachments_sort_order_check check (sort_order >= 0);
  end if;
end;
$$;

update public.cards
set completed_at = coalesce(completed_at, updated_at),
    previous_stage = coalesce(previous_stage, 'todo'),
    focus = false
where stage = 'done' and (completed_at is null or previous_stage is null);

create index if not exists cards_owner_completed_idx
  on public.cards(user_id, completed_at desc) where stage = 'done';

create or replace function public.track_card_completion()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if tg_op = 'INSERT' and new.stage = 'done' then
    new.completed_at = coalesce(new.completed_at, now());
    new.previous_stage = coalesce(new.previous_stage, 'todo');
    new.focus = false;
  elsif tg_op = 'UPDATE' then
    if new.stage = 'done' and old.stage is distinct from 'done' then
      new.completed_at = now();
      new.previous_stage = old.stage;
      new.focus = false;
    elsif new.stage is distinct from 'done' and old.stage = 'done' then
      new.completed_at = null;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists cards_track_completion on public.cards;
create trigger cards_track_completion before insert or update of stage on public.cards
for each row execute function public.track_card_completion();

commit;
