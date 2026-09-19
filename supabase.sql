-- Fresh installation AND upgrade from the original MVP. Run the entire file.
-- Existing invalid/duplicate responses abort the transaction; nothing is deleted.
begin;
create extension if not exists pgcrypto;
create table if not exists public.sessions(id uuid primary key default gen_random_uuid(),slug text unique not null,title_tr text not null default '',title_en text not null default '',description_tr text not null default '',description_en text not null default '',is_open boolean not null default true,created_at timestamptz not null default now());
create table if not exists public.groups(id uuid primary key default gen_random_uuid(),session_id uuid not null references public.sessions(id) on delete cascade,name_tr text not null default '',name_en text not null default '',description_tr text not null default '',description_en text not null default '',sort_order int not null default 0);
create table if not exists public.dimensions(id uuid primary key default gen_random_uuid(),session_id uuid not null references public.sessions(id) on delete cascade,name_tr text not null default '',name_en text not null default '',description_tr text not null default '',description_en text not null default '',sort_order int not null default 0);
create table if not exists public.responses(id uuid primary key default gen_random_uuid(),session_id uuid not null references public.sessions(id) on delete cascade,group_id uuid not null references public.groups(id) on delete cascade,answers jsonb not null,device_token text,created_at timestamptz not null default now());
create schema if not exists dss_private;
revoke all on schema dss_private from public, anon, authenticated;
create table if not exists dss_private.admin_users (
  singleton boolean primary key default true check (singleton),
  user_id uuid not null unique references auth.users(id) on delete cascade
);
revoke all on dss_private.admin_users from public, anon, authenticated;
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(select 1 from dss_private.admin_users where user_id = auth.uid());
$$;

-- One validator shared by migration preflight and the only voting write path.
create or replace function dss_private.validate_vote(sid uuid, gid uuid, vals jsonb, token text)
returns void language plpgsql set search_path = '' as $$
declare dimension_count integer; total numeric;
begin
  if token is null or length(token) not between 16 and 128 then raise exception 'DSS_DEVICE'; end if;
  if not exists(select 1 from public.groups where id=gid and session_id=sid) then raise exception 'DSS_GROUP'; end if;
  select count(*) into dimension_count from public.dimensions where session_id=sid;
  if dimension_count < 2 then raise exception 'DSS_CONFIG'; end if;
  if vals is null or jsonb_typeof(vals) <> 'object' then raise exception 'DSS_ANSWERS'; end if;
  if (select count(*) from jsonb_object_keys(vals)) <> dimension_count
     or exists(select 1 from public.dimensions d where d.session_id=sid and not (vals ? d.id::text)) then
    raise exception 'DSS_ANSWERS';
  end if;
  if exists(select 1 from jsonb_each(vals) where jsonb_typeof(value) <> 'number') then raise exception 'DSS_ANSWERS'; end if;
  if exists(select 1 from jsonb_each_text(vals) where value::numeric < 0 or value::numeric > 100) then raise exception 'DSS_ANSWERS'; end if;
  select sum(value::numeric) into total from jsonb_each_text(vals);
  if total <> 100 then raise exception 'DSS_TOTAL'; end if;
end;
$$;

-- Block concurrent writes during upgrade and validate existing data before tightening access.
lock table public.sessions, public.groups, public.dimensions, public.responses in access exclusive mode;
do $$
declare r record;
begin
  for r in select * from public.responses loop
    begin
      perform dss_private.validate_vote(r.session_id,r.group_id,r.answers,r.device_token);
    exception when others then
      raise exception 'Migration stopped: response % is invalid (%). Export and repair or explicitly delete legacy test responses, then rerun.',r.id,sqlerrm;
    end;
  end loop;
  if exists(select 1 from public.responses group by session_id,device_token having count(*)>1) then
    raise exception 'Migration stopped: duplicate session/device votes. Export and resolve legacy duplicates, then rerun.';
  end if;
end;
$$;
alter table public.responses alter column device_token set not null;
create unique index if not exists responses_session_device_unique on public.responses(session_id,device_token);
create index if not exists groups_session_idx on public.groups(session_id);
create index if not exists dimensions_session_idx on public.dimensions(session_id);
alter table public.sessions alter column is_open set default false;

-- Replace ALL policies on these four application-owned tables, including old broad policies.
do $$
declare p record; t text;
begin
  for p in select tablename,policyname from pg_policies where schemaname='public' and tablename in ('sessions','groups','dimensions','responses') loop
    execute format('drop policy %I on public.%I',p.policyname,p.tablename);
  end loop;
  foreach t in array array['sessions','groups','dimensions','responses'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from public, anon, authenticated',t);
    execute format('grant select on public.%I to anon, authenticated',t);
  end loop;
end;
$$;
create policy sessions_read on public.sessions for select to anon, authenticated using(true);
create policy groups_read on public.groups for select to anon, authenticated using(true);
create policy dimensions_read on public.dimensions for select to anon, authenticated using(true);
create policy responses_admin_read on public.responses for select to authenticated using(public.is_admin());
revoke select on public.responses from anon;

-- All browser mutations use these RPCs. A shared session row lock serializes voting,
-- closing, configuration changes, response resets and session deletion.
create or replace function public.submit_vote(p_session_id uuid,p_group_id uuid,p_answers jsonb,p_device_token text)
returns void language plpgsql security definer set search_path = '' as $$
declare opened boolean;
begin
  select is_open into opened from public.sessions where id=p_session_id for update;
  if not found then raise exception 'DSS_NOT_FOUND'; end if;
  if not opened then raise exception 'DSS_CLOSED'; end if;
  perform dss_private.validate_vote(p_session_id,p_group_id,p_answers,p_device_token);
  insert into public.responses(session_id,group_id,answers,device_token) values(p_session_id,p_group_id,p_answers,p_device_token);
exception when unique_violation then raise exception 'DSS_DUPLICATE';
end;
$$;

create or replace function public.admin_action(p_action text,p_session_id uuid default null,p_payload jsonb default '{}'::jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare sid uuid; target uuid; label_tr text; label_en text;
begin
  if not public.is_admin() then raise exception 'DSS_FORBIDDEN'; end if;
  if p_action='create_session' then
    if coalesce(p_payload->>'slug','') !~ '^[a-z0-9]+(-[a-z0-9]+)*$' then raise exception 'DSS_SLUG'; end if;
    if btrim(coalesce(p_payload->>'title_tr',''))='' or btrim(coalesce(p_payload->>'title_en',''))='' then raise exception 'DSS_NAME'; end if;
    insert into public.sessions(slug,title_tr,title_en,description_tr,description_en,is_open)
    values(p_payload->>'slug',btrim(p_payload->>'title_tr'),btrim(p_payload->>'title_en'),coalesce(p_payload->>'description_tr',''),coalesce(p_payload->>'description_en',''),false) returning id into sid;
    return sid;
  end if;
  select id into sid from public.sessions where id=p_session_id for update;
  if not found then raise exception 'DSS_NOT_FOUND'; end if;
  if p_action='delete_session' then
    delete from public.sessions where id=sid;
  elsif p_action='delete_responses' then
    delete from public.responses where session_id=sid;
    -- Close on reset so configuration can be edited without collecting new votes.
    update public.sessions set is_open=false where id=sid;
  elsif p_action='open' then
    if (select count(*) from public.dimensions where session_id=sid)<2 or not exists(select 1 from public.groups where session_id=sid) then raise exception 'DSS_CONFIG'; end if;
    update public.sessions set is_open=true where id=sid;
  elsif p_action='close' then
    update public.sessions set is_open=false where id=sid;
  elsif p_action in ('add_group','add_dimension','delete_group','delete_dimension') then
    if exists(select 1 from public.responses where session_id=sid) then raise exception 'DSS_LOCKED'; end if;
    if exists(select 1 from public.sessions where id=sid and is_open) then raise exception 'DSS_CLOSE_FIRST'; end if;
    if p_action in ('add_group','add_dimension') then
      label_tr:=btrim(coalesce(p_payload->>'name_tr','')); label_en:=btrim(coalesce(p_payload->>'name_en',''));
      if label_tr='' or label_en='' then raise exception 'DSS_NAME'; end if;
      if p_action='add_group' then
        insert into public.groups(session_id,name_tr,name_en,description_tr,description_en,sort_order)
        values(sid,label_tr,label_en,coalesce(p_payload->>'description_tr',''),coalesce(p_payload->>'description_en',''),(select coalesce(max(sort_order),-1)+1 from public.groups where session_id=sid));
      else
        insert into public.dimensions(session_id,name_tr,name_en,description_tr,description_en,sort_order)
        values(sid,label_tr,label_en,coalesce(p_payload->>'description_tr',''),coalesce(p_payload->>'description_en',''),(select coalesce(max(sort_order),-1)+1 from public.dimensions where session_id=sid));
      end if;
    else
      target:=(p_payload->>'id')::uuid;
      if p_action='delete_group' then delete from public.groups where id=target and session_id=sid;
      else delete from public.dimensions where id=target and session_id=sid; end if;
      if not found then raise exception 'DSS_NOT_FOUND'; end if;
    end if;
  else raise exception 'DSS_ACTION';
  end if;
  return sid;
end;
$$;

-- No raw rows, IDs of individual responses, timestamps or device tokens are returned.
create or replace function public.session_results(p_session_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not exists(select 1 from public.sessions where id=p_session_id) then raise exception 'DSS_NOT_FOUND'; end if;
  return jsonb_build_object(
    'response_count',(select count(*) from public.responses where session_id=p_session_id),
    'groups',coalesce((select jsonb_agg(jsonb_build_object('group_id',g.id,'response_count',(select count(*) from public.responses r where r.session_id=p_session_id and r.group_id=g.id))) from public.groups g where g.session_id=p_session_id),'[]'::jsonb),
    'averages',coalesce((select jsonb_agg(jsonb_build_object('group_id',a.group_id,'dimension_id',a.dimension_id,'average',a.average)) from (
      select r.group_id,d.id dimension_id,avg((r.answers->>d.id::text)::numeric) average
      from public.responses r join public.dimensions d on d.session_id=r.session_id
      where r.session_id=p_session_id group by r.group_id,d.id
    ) a),'[]'::jsonb)
  );
end;
$$;
revoke all on function dss_private.validate_vote(uuid,uuid,jsonb,text) from public,anon,authenticated;
revoke all on function public.is_admin() from public,anon,authenticated;
revoke all on function public.submit_vote(uuid,uuid,jsonb,text) from public,anon,authenticated;
revoke all on function public.admin_action(text,uuid,jsonb) from public,anon,authenticated;
revoke all on function public.session_results(uuid) from public,anon,authenticated;
grant execute on function public.is_admin() to anon,authenticated;
grant execute on function public.submit_vote(uuid,uuid,jsonb,text) to anon,authenticated;
grant execute on function public.admin_action(text,uuid,jsonb) to authenticated;
grant execute on function public.session_results(uuid) to anon,authenticated;
-- MVP iteration 2: administrator-only duplication and archive exports.
create or replace function public.duplicate_session(p_session_id uuid, p_slug text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare copied_id uuid;
begin
  if not public.is_admin() then raise exception 'DSS_FORBIDDEN'; end if;
  if p_slug is null or p_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' then raise exception 'DSS_SLUG'; end if;
  perform 1 from public.sessions where id=p_session_id for update;
  if not found then raise exception 'DSS_NOT_FOUND'; end if;
  insert into public.sessions(slug,title_tr,title_en,description_tr,description_en,is_open)
    select p_slug,title_tr,title_en,description_tr,description_en,false from public.sessions where id=p_session_id
    returning id into copied_id;
  insert into public.groups(session_id,name_tr,name_en,description_tr,description_en,sort_order)
    select copied_id,name_tr,name_en,description_tr,description_en,sort_order from public.groups where session_id=p_session_id;
  insert into public.dimensions(session_id,name_tr,name_en,description_tr,description_en,sort_order)
    select copied_id,name_tr,name_en,description_tr,description_en,sort_order from public.dimensions where session_id=p_session_id;
  return copied_id;
end;
$$;

-- One consistent snapshot, with no API row-limit truncation. Tokens are deliberately excluded.
create or replace function public.export_session(p_session_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'DSS_FORBIDDEN'; end if;
  if not exists(select 1 from public.sessions where id=p_session_id) then raise exception 'DSS_NOT_FOUND'; end if;
  return jsonb_build_object(
    'schema_version',1,
    'exported_at',now(),
    'session',(select to_jsonb(s) from public.sessions s where id=p_session_id),
    'groups',coalesce((select jsonb_agg(to_jsonb(g) order by g.sort_order,g.id) from public.groups g where session_id=p_session_id),'[]'::jsonb),
    'dimensions',coalesce((select jsonb_agg(to_jsonb(d) order by d.sort_order,d.id) from public.dimensions d where session_id=p_session_id),'[]'::jsonb),
    'responses',coalesce((select jsonb_agg(to_jsonb(r)-'device_token' order by r.created_at,r.id) from public.responses r where session_id=p_session_id),'[]'::jsonb)
  );
end;
$$;
revoke all on function public.duplicate_session(uuid,text) from public,anon,authenticated;
revoke all on function public.export_session(uuid) from public,anon,authenticated;
grant execute on function public.duplicate_session(uuid,text) to authenticated;
grant execute on function public.export_session(uuid) to authenticated;
-- Participant access boundary (also available as migration 003).
-- Public callers must use the narrow session-by-slug RPC, never table enumeration.
do $$
declare p record; t text;
begin
  for p in select tablename,policyname from pg_policies where schemaname='public' and tablename in ('sessions','groups','dimensions') loop
    execute format('drop policy %I on public.%I',p.policyname,p.tablename);
  end loop;
  foreach t in array array['sessions','groups','dimensions'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from public, anon, authenticated',t);
    execute format('grant select on public.%I to authenticated',t);
    execute format('create policy admin_read on public.%I for select to authenticated using(public.is_admin())',t);
  end loop;
end;
$$;

-- Only voting content for one known open-session slug. No lists, counts or responses.
create or replace function public.voting_session(p_slug text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare s public.sessions;
begin
  select * into s from public.sessions where slug=p_slug;
  if not found then raise exception 'DSS_NOT_FOUND'; end if;
  if not s.is_open then raise exception 'DSS_CLOSED'; end if;
  return jsonb_build_object(
    'session',jsonb_build_object('id',s.id,'title_tr',s.title_tr,'title_en',s.title_en,'description_tr',s.description_tr,'description_en',s.description_en,'is_open',s.is_open),
    'groups',coalesce((select jsonb_agg(jsonb_build_object('id',g.id,'name_tr',g.name_tr,'name_en',g.name_en,'description_tr',g.description_tr,'description_en',g.description_en) order by g.sort_order,g.id) from public.groups g where g.session_id=s.id),'[]'::jsonb),
    'dimensions',coalesce((select jsonb_agg(jsonb_build_object('id',d.id,'name_tr',d.name_tr,'name_en',d.name_en,'description_tr',d.description_tr,'description_en',d.description_en) order by d.sort_order,d.id) from public.dimensions d where d.session_id=s.id),'[]'::jsonb)
  );
end;
$$;
revoke all on function public.voting_session(text) from public,anon,authenticated;
grant execute on function public.voting_session(text) to anon,authenticated;

create or replace function public.session_results(p_session_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'DSS_FORBIDDEN'; end if;
  if not exists(select 1 from public.sessions where id=p_session_id) then raise exception 'DSS_NOT_FOUND'; end if;
  return jsonb_build_object(
    'response_count',(select count(*) from public.responses where session_id=p_session_id),
    'groups',coalesce((select jsonb_agg(jsonb_build_object('group_id',g.id,'response_count',(select count(*) from public.responses r where r.session_id=p_session_id and r.group_id=g.id))) from public.groups g where g.session_id=p_session_id),'[]'::jsonb),
    'averages',coalesce((select jsonb_agg(jsonb_build_object('group_id',a.group_id,'dimension_id',a.dimension_id,'average',a.average)) from (
      select r.group_id,d.id dimension_id,avg((r.answers->>d.id::text)::numeric) average
      from public.responses r join public.dimensions d on d.session_id=r.session_id
      where r.session_id=p_session_id group by r.group_id,d.id
    ) a),'[]'::jsonb)
  );
end;
$$;
revoke all on function public.session_results(uuid) from public,anon,authenticated;
grant execute on function public.session_results(uuid) to authenticated;
revoke all on function public.is_admin() from public,anon;
notify pgrst, 'reload schema';
commit;
