-- Idempotent AI organizer fields for installations created from the memo-flow schema.
-- Existing production databases from the original AI release already contain these columns.

alter table public.cards
  add column if not exists original_text text not null default '',
  add column if not exists organized_text text not null default '',
  add column if not exists ai_analysis jsonb,
  add column if not exists ai_model text,
  add column if not exists ai_prompt_version text,
  add column if not exists ai_organized_at timestamptz,
  add column if not exists original_text_updated_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'cards_original_text_length_check') then
    alter table public.cards add constraint cards_original_text_length_check
      check (char_length(original_text) <= 20000);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'cards_organized_text_length_check') then
    alter table public.cards add constraint cards_organized_text_length_check
      check (char_length(organized_text) <= 20000);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'cards_ai_model_length_check') then
    alter table public.cards add constraint cards_ai_model_length_check
      check (ai_model is null or char_length(ai_model) <= 100);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'cards_ai_prompt_version_length_check') then
    alter table public.cards add constraint cards_ai_prompt_version_length_check
      check (ai_prompt_version is null or char_length(ai_prompt_version) <= 100);
  end if;
end;
$$;

create or replace function public.track_original_text_updated_at()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if tg_op = 'INSERT' and new.original_text <> '' then
    new.original_text_updated_at = coalesce(new.original_text_updated_at, now());
  elsif tg_op = 'UPDATE' and new.original_text is distinct from old.original_text then
    new.original_text_updated_at = now();
  end if;
  return new;
end;
$$;

drop trigger if exists cards_track_original_text on public.cards;
create trigger cards_track_original_text before insert or update of original_text on public.cards
for each row execute function public.track_original_text_updated_at();
