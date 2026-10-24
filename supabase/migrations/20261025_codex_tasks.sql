-- Incremental, repeatable Codex transport. Only the server service role may use it.
-- Keep schema and permissions atomic even for deployment tools that stream SQL statements.
begin;
create table if not exists public.codex_devices (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  name text not null check (char_length(name) between 1 and 100),
  platform text not null check (platform in ('windows','macos')),
  projects jsonb not null default '[]'::jsonb,
  token_hash text not null unique,
  last_seen_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists codex_devices_owner on public.codex_devices(owner_id);

create table if not exists public.codex_pair_codes (
  code_hash text primary key,
  owner_id uuid not null,
  expires_at timestamptz not null default (now() + interval '10 minutes'),
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.codex_tasks (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  request_id uuid not null,
  title text not null check (char_length(title) between 1 and 240),
  prompt text not null check (char_length(prompt) between 1 and 20000),
  acceptance text not null default '' check (char_length(acceptance) <= 4000),
  target_kind text not null check (target_kind in ('cloud','device')),
  device_id uuid references public.codex_devices(id),
  project_id text not null check (project_id ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$'),
  status text not null default 'queued' check (status in ('queued','dispatching','submitted','acknowledged','running','succeeded','failed','cancel_requested','cancelled','needs_attention','result_ready','closed','merged')),
  actual_device_id uuid references public.codex_devices(id),
  run_token uuid,
  lease_until timestamptz,
  summary text not null default '' check (char_length(summary) <= 2000),
  result text not null default '' check (char_length(result) <= 20000),
  error text not null default '' check (char_length(error) <= 2000),
  session_id text check (char_length(session_id) <= 200),
  cloud_url text,
  cloud_state jsonb not null default '{}'::jsonb,
  dispatch_lock_until timestamptz,
  dispatch_lock_token uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  unique(owner_id, request_id),
  check ((target_kind = 'cloud' and device_id is null) or (target_kind = 'device' and device_id is not null))
);
create index if not exists codex_tasks_owner_created on public.codex_tasks(owner_id, created_at desc);
create index if not exists codex_tasks_device_queue on public.codex_tasks(device_id, created_at) where status = 'queued';
create unique index if not exists codex_one_run_per_device on public.codex_tasks(device_id) where target_kind = 'device' and status in ('running','cancel_requested');

alter table public.codex_devices enable row level security;
alter table public.codex_pair_codes enable row level security;
alter table public.codex_tasks enable row level security;
revoke all on public.codex_devices, public.codex_pair_codes, public.codex_tasks from public, anon, authenticated;
grant all on public.codex_devices, public.codex_pair_codes, public.codex_tasks to service_role;

create or replace function public.codex_valid_projects(p_projects jsonb) returns boolean
language plpgsql immutable set search_path = public, pg_temp as $$
declare item jsonb;
begin
  if jsonb_typeof(p_projects) is distinct from 'array' or jsonb_array_length(p_projects) > 30 then return false; end if;
  for item in select value from jsonb_array_elements(p_projects) loop
    if jsonb_typeof(item) is distinct from 'object'
      or coalesce(item->>'id','') !~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$'
      or char_length(coalesce(item->>'label','')) not between 1 and 100
      or item - 'id' - 'label' <> '{}'::jsonb then return false; end if;
  end loop;
  return (select count(distinct value->>'id') = count(*) from jsonb_array_elements(p_projects));
end $$;

create or replace function public.codex_task_json(t public.codex_tasks) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'id',t.id,'requestId',t.request_id,'title',t.title,'prompt',t.prompt,'acceptance',t.acceptance,
    'targetKind',t.target_kind,'deviceId',t.device_id,'projectId',t.project_id,'status',t.status,
    'actualDeviceId',t.actual_device_id,'createdAt',t.created_at,'updatedAt',t.updated_at,
    'startedAt',t.started_at,'completedAt',t.completed_at,'summary',t.summary,'result',t.result,
    'error',t.error,'sessionId',t.session_id,'cloudUrl',t.cloud_url)
$$;

create or replace function public.codex_device_json(d public.codex_devices) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select jsonb_build_object('id',d.id,'name',d.name,'platform',d.platform,'projects',d.projects,
    'lastSeenAt',d.last_seen_at,'revokedAt',d.revoked_at,'createdAt',d.created_at)
$$;

create or replace function public.codex_user_action(p_owner uuid, p_action text, p_body jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare t public.codex_tasks; d public.codex_devices; output jsonb; expire_at timestamptz;
begin
  if p_owner is null then raise exception 'OWNER_REQUIRED'; end if;
  if p_action = 'pair-code' then
    -- Keep only one unconsumed code per owner, avoiding stale code confusion.
    perform pg_advisory_xact_lock(hashtext(p_owner::text));
    delete from codex_pair_codes where owner_id = p_owner and consumed_at is null;
    insert into codex_pair_codes(code_hash,owner_id) values(p_body->>'codeHash',p_owner) returning expires_at into expire_at;
    return jsonb_build_object('expiresAt',expire_at);
  elsif p_action = 'list' then
    update codex_tasks set status='needs_attention',error='接收器租约中断，请检查本机执行记录。',updated_at=now(),lease_until=null
      where owner_id=p_owner and target_kind='device' and status in ('running','cancel_requested') and lease_until <= now();
    select jsonb_build_object(
      'tasks',coalesce((select jsonb_agg(codex_task_json(q) order by q.created_at desc) from (select * from codex_tasks where owner_id=p_owner order by created_at desc limit 200) q),'[]'::jsonb),
      'devices',coalesce((select jsonb_agg(codex_device_json(x) order by x.created_at desc) from codex_devices x where owner_id=p_owner),'[]'::jsonb)
    ) into output;
    return output;
  elsif p_action = 'create' then
    select * into t from codex_tasks where owner_id=p_owner and request_id=(p_body->>'requestId')::uuid;
    if found then
      if t.target_kind is distinct from p_body->>'targetKind' or t.device_id is distinct from (p_body->>'deviceId')::uuid
        or t.project_id is distinct from p_body->>'projectId' then raise exception 'REQUEST_CONFLICT'; end if;
      return jsonb_build_object('task',codex_task_json(t));
    end if;
    if p_body->>'targetKind' = 'device' then
      select * into d from codex_devices where id=(p_body->>'deviceId')::uuid and owner_id=p_owner and revoked_at is null for update;
      if not found then raise exception 'DEVICE_FORBIDDEN'; end if;
      if not exists(select 1 from jsonb_array_elements(d.projects) x where x->>'id'=p_body->>'projectId') then raise exception 'PROJECT_FORBIDDEN'; end if;
    elsif p_body->>'targetKind' is distinct from 'cloud' then raise exception 'INVALID_INPUT'; end if;
    insert into codex_tasks(owner_id,request_id,title,prompt,acceptance,target_kind,device_id,project_id,cloud_state)
      values(p_owner,(p_body->>'requestId')::uuid,p_body->>'title',p_body->>'prompt',coalesce(p_body->>'acceptance',''),p_body->>'targetKind',
        case when p_body->>'targetKind'='device' then (p_body->>'deviceId')::uuid else null end,p_body->>'projectId',
        case when p_body->>'targetKind'='cloud' then jsonb_build_object('project',p_body->'_cloudProject') else '{}'::jsonb end)
      on conflict(owner_id,request_id) do nothing;
    select * into t from codex_tasks where owner_id=p_owner and request_id=(p_body->>'requestId')::uuid;
    -- Recheck after ON CONFLICT too: simultaneous requests may have different fixed destinations.
    if t.target_kind is distinct from p_body->>'targetKind' or t.device_id is distinct from (p_body->>'deviceId')::uuid
      or t.project_id is distinct from p_body->>'projectId' then raise exception 'REQUEST_CONFLICT'; end if;
    return jsonb_build_object('task',codex_task_json(t));
  elsif p_action = 'revoke-device' then
    update codex_devices set revoked_at=coalesce(revoked_at,now()) where id=(p_body->>'deviceId')::uuid and owner_id=p_owner returning * into d;
    if not found then raise exception 'DEVICE_FORBIDDEN'; end if;
    update codex_tasks set status=case when status='queued' then 'cancelled' else 'needs_attention' end,
      error='设备已撤销；请检查本机是否已停止执行。',lease_until=null,updated_at=now()
      where device_id=d.id and owner_id=p_owner and status in ('queued','running','cancel_requested');
    return '{"ok":true}'::jsonb;
  elsif p_action in ('get','cancel') then
    select * into t from codex_tasks where id=(p_body->>'taskId')::uuid and owner_id=p_owner for update;
    if not found then raise exception 'TASK_NOT_FOUND'; end if;
    if p_action = 'cancel' then
      update codex_tasks set status=case when status='queued' or (target_kind='cloud' and status='needs_attention') then 'cancelled' when status in ('running','dispatching','submitted','acknowledged','result_ready') then 'cancel_requested' else status end,
        summary=case when target_kind='cloud' and status in ('dispatching','submitted','acknowledged','result_ready','needs_attention') then '已关闭平台后续派发；请通过任务链接检查云端运行，平台不能停止已提交的云任务。' else summary end,
        dispatch_lock_until=case when target_kind='cloud' then null else dispatch_lock_until end,
        dispatch_lock_token=case when target_kind='cloud' then null else dispatch_lock_token end,
        updated_at=now() where id=t.id returning * into t;
    end if;
    return jsonb_build_object('task',codex_task_json(t));
  end if;
  raise exception 'INVALID_ACTION';
end $$;

create or replace function public.codex_runner_action(p_token_hash text, p_action text, p_body jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare d public.codex_devices; t public.codex_tasks; pairing_owner uuid;
begin
  if p_action='pair' then
    update codex_pair_codes set consumed_at=now() where code_hash=p_body->>'codeHash' and consumed_at is null and expires_at>now() returning owner_id into pairing_owner;
    if not found then raise exception 'PAIR_INVALID'; end if;
    if p_body ? '_allowedOwnerIds' and not (p_body->'_allowedOwnerIds' @> to_jsonb(array[pairing_owner::text])) then raise exception 'PAIR_INVALID'; end if;
    if not codex_valid_projects(p_body->'projects') then raise exception 'INVALID_INPUT'; end if;
    insert into codex_devices(owner_id,name,platform,projects,token_hash,last_seen_at)
      values(pairing_owner,p_body->>'name',p_body->>'platform',p_body->'projects',p_body->>'tokenHash',now()) returning * into d;
    return jsonb_build_object('deviceId',d.id);
  end if;
  -- Serialize actions for this device; recheck revoked_at while holding the lock.
  select * into d from codex_devices where token_hash=p_token_hash and revoked_at is null for update;
  if not found then raise exception 'DEVICE_UNAUTHORIZED'; end if;
  if p_body ? '_allowedOwnerIds' and not (p_body->'_allowedOwnerIds' @> to_jsonb(array[d.owner_id::text])) then raise exception 'DEVICE_UNAUTHORIZED'; end if;
  update codex_devices set last_seen_at=now() where id=d.id;
  if p_action='heartbeat' then
    if not codex_valid_projects(p_body->'projects') then raise exception 'INVALID_INPUT'; end if;
    update codex_devices set projects=p_body->'projects' where id=d.id;
    return '{"ok":true}'::jsonb;
  elsif p_action='claim' then
    update codex_tasks set status='needs_attention',error='接收器租约中断，请检查本机执行记录。',lease_until=null,updated_at=now()
      where device_id=d.id and owner_id=d.owner_id and status in ('running','cancel_requested') and lease_until<=now();
    if exists(select 1 from codex_tasks where device_id=d.id and status in ('running','cancel_requested')) then return '{"task":null,"leaseSeconds":90}'::jsonb; end if;
    select * into t from codex_tasks where owner_id=d.owner_id and device_id=d.id and target_kind='device' and status='queued'
      and exists(select 1 from jsonb_array_elements(d.projects) p where p->>'id'=project_id)
      order by created_at,id limit 1 for update skip locked;
    if not found then return '{"task":null,"leaseSeconds":90}'::jsonb; end if;
    update codex_tasks set status='running',actual_device_id=d.id,run_token=gen_random_uuid(),lease_until=now()+interval '90 seconds',
      started_at=now(),updated_at=now() where id=t.id returning * into t;
    return jsonb_build_object('task',jsonb_build_object('id',t.id,'title',t.title,'prompt',t.prompt,'acceptance',t.acceptance,'projectId',t.project_id,'runToken',t.run_token),'leaseSeconds',90);
  elsif p_action in ('progress','complete') then
    select * into t from codex_tasks where id=(p_body->>'taskId')::uuid and device_id=d.id and actual_device_id=d.id and owner_id=d.owner_id
      and run_token=(p_body->>'runToken')::uuid for update;
    if not found then raise exception 'RUN_CONFLICT'; end if;
    -- An identical completed write may be retried after a lost HTTP response; it cannot change the result.
    if p_action='complete' and t.completed_at is not null and t.status=p_body->>'status'
      and t.result=coalesce(p_body->>'result','') and t.error=coalesce(p_body->>'error','')
      and t.session_id is not distinct from p_body->>'sessionId' then return '{"ok":true}'::jsonb; end if;
    if t.status not in ('running','cancel_requested') then raise exception 'RUN_CONFLICT'; end if;
    if t.lease_until<=now() then
      -- Return an error value, rather than RAISE, so the expired state is committed.
      update codex_tasks set status='needs_attention',error='接收器租约中断，请检查本机执行记录。',lease_until=null,updated_at=now() where id=t.id;
      return '{"error":"RUN_CONFLICT"}'::jsonb;
    end if;
    if p_action='progress' then
      if char_length(coalesce(p_body->>'summary',''))>2000 then raise exception 'INVALID_INPUT'; end if;
      update codex_tasks set summary=coalesce(p_body->>'summary',''),lease_until=now()+interval '90 seconds',updated_at=now() where id=t.id;
      return jsonb_build_object('cancelRequested',t.status='cancel_requested','leaseSeconds',90);
    end if;
    if p_body->>'status' not in ('succeeded','failed','cancelled','needs_attention') or p_body->>'status' is null then raise exception 'INVALID_INPUT'; end if;
    if t.status='cancel_requested' and p_body->>'status'='succeeded' then raise exception 'RUN_CONFLICT'; end if;
    update codex_tasks set status=p_body->>'status',result=coalesce(p_body->>'result',''),error=coalesce(p_body->>'error',''),
      session_id=p_body->>'sessionId',completed_at=now(),updated_at=now(),lease_until=null where id=t.id;
    return '{"ok":true}'::jsonb;
  end if;
  raise exception 'INVALID_ACTION';
end $$;

-- Server-only GitHub checkpoints make dispatch recoverable without repeating an @codex trigger.
create or replace function public.codex_cloud_action(p_owner uuid,p_task_id uuid,p_action text,p_body jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare t public.codex_tasks;
begin
  select * into t from codex_tasks where id=p_task_id and owner_id=p_owner and target_kind='cloud' for update;
  if not found then raise exception 'TASK_NOT_FOUND'; end if;
  if p_action='lock' then
    if t.status in ('cancelled','cancel_requested','closed','merged') or t.dispatch_lock_until>now() then
      return jsonb_build_object('acquired',false,'task',codex_task_json(t),'state',t.cloud_state);
    end if;
    update codex_tasks set dispatch_lock_until=now()+interval '2 minutes',dispatch_lock_token=gen_random_uuid(),status=case when status='queued' then 'dispatching' else status end,
      updated_at=now() where id=t.id returning * into t;
    return jsonb_build_object('acquired',true,'task',codex_task_json(t),'state',t.cloud_state,'lockToken',t.dispatch_lock_token);
  elsif p_action in ('checkpoint','mark-comment') then
    if t.status in ('cancelled','cancel_requested') then raise exception 'TASK_CANCELLED'; end if;
    if t.dispatch_lock_token is distinct from (p_body->>'_lockToken')::uuid or t.dispatch_lock_until<=now() then raise exception 'RUN_CONFLICT'; end if;
    if p_action='mark-comment' then
      if t.cloud_state->>'commentAttempted'='true' then return jsonb_build_object('shouldPost',false); end if;
      update codex_tasks set cloud_state=cloud_state || '{"commentAttempted":true}'::jsonb,updated_at=now() where id=t.id;
      return jsonb_build_object('shouldPost',true);
    end if;
    update codex_tasks set cloud_state=cloud_state || coalesce(p_body->'state','{}'::jsonb),
      cloud_url=coalesce(p_body->>'cloudUrl',cloud_url),status=coalesce(p_body->>'status',status),
      summary=coalesce(p_body->>'summary',summary),result=coalesce(p_body->>'result',result),
      error=coalesce(p_body->>'error',error),updated_at=now() where id=t.id returning * into t;
  elsif p_action='release' then
    update codex_tasks set dispatch_lock_until=null,dispatch_lock_token=null
      where id=t.id and dispatch_lock_token=(p_body->>'_lockToken')::uuid;
    select * into t from codex_tasks where id=p_task_id;
  else raise exception 'INVALID_ACTION'; end if;
  return jsonb_build_object('task',codex_task_json(t),'state',t.cloud_state);
end $$;

revoke all on function public.codex_valid_projects(jsonb), public.codex_task_json(public.codex_tasks), public.codex_device_json(public.codex_devices),
  public.codex_user_action(uuid,text,jsonb), public.codex_runner_action(text,text,jsonb), public.codex_cloud_action(uuid,uuid,text,jsonb)
  from public, anon, authenticated;
grant execute on function public.codex_valid_projects(jsonb), public.codex_task_json(public.codex_tasks), public.codex_device_json(public.codex_devices),
  public.codex_user_action(uuid,text,jsonb), public.codex_runner_action(text,text,jsonb), public.codex_cloud_action(uuid,uuid,text,jsonb)
  to service_role;
commit;
