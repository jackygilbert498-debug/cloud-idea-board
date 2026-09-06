begin;

-- Refuse to certify a database that already contains inconsistent ownership.
-- Remediation is deliberately manual so the migration never deletes user data.
do $$
begin
  if exists (
    select 1
    from public.attachments
    left join public.cards on cards.id = attachments.card_id
    where cards.id is null or attachments.user_id <> cards.user_id
  ) then
    raise exception 'existing attachment owner mismatch' using errcode = '23514';
  end if;
end;
$$;

-- Enforce the parent/child ownership invariant below RLS so service-role jobs,
-- future SQL maintenance and application requests all receive the same guard.
create or replace function public.enforce_attachment_card_owner()
returns trigger language plpgsql security definer set search_path = '' as $$
declare card_owner uuid;
begin
  select cards.user_id into card_owner
  from public.cards
  where cards.id = new.card_id;

  if card_owner is null or card_owner <> new.user_id then
    raise exception 'attachment owner must match card owner' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists attachments_enforce_card_owner on public.attachments;
create trigger attachments_enforce_card_owner
before insert or update of card_id, user_id on public.attachments
for each row execute function public.enforce_attachment_card_owner();

create or replace function public.reorder_attachments(
  p_card_id bigint,
  p_attachment_ids uuid[]
)
returns void language plpgsql security invoker set search_path = '' as $$
declare
  existing_count integer;
  requested_count integer;
  distinct_count integer;
begin
  if auth.uid() is null or p_card_id is null or p_attachment_ids is null then
    raise exception 'attachment list does not match card' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.cards
    where cards.id = p_card_id and cards.user_id = auth.uid()
  ) then
    raise exception 'attachment list does not match card' using errcode = '42501';
  end if;

  perform 1 from public.attachments
  where attachments.card_id = p_card_id and attachments.user_id = auth.uid()
  for update;

  select count(*) into existing_count
  from public.attachments
  where attachments.card_id = p_card_id and attachments.user_id = auth.uid();
  requested_count := cardinality(p_attachment_ids);
  select count(distinct requested.id) into distinct_count
  from unnest(p_attachment_ids) as requested(id);

  if requested_count <> existing_count or distinct_count <> requested_count or exists (
    select 1
    from unnest(p_attachment_ids) as requested(id)
    left join public.attachments on
      attachments.id = requested.id and
      attachments.card_id = p_card_id and
      attachments.user_id = auth.uid()
    where attachments.id is null
  ) then
    raise exception 'attachment list does not match card' using errcode = '23514';
  end if;

  update public.attachments
  set sort_order = (requested.ordinality - 1)::integer
  from unnest(p_attachment_ids) with ordinality as requested(id, ordinality)
  where attachments.id = requested.id
    and attachments.card_id = p_card_id
    and attachments.user_id = auth.uid();
end;
$$;

revoke all on function public.reorder_attachments(bigint, uuid[]) from public;
grant execute on function public.reorder_attachments(bigint, uuid[]) to authenticated;

drop policy if exists "Owners update their own attachments" on public.attachments;
create policy "Owners update their own attachments" on public.attachments
for update to authenticated using (user_id = auth.uid()) with check (
  user_id = auth.uid() and exists (
    select 1 from public.cards where cards.id = card_id and cards.user_id = auth.uid()
  )
);

commit;
