-- Participant isolation. Apply after migrations/002_presenter_tools.sql.
-- Safe to rerun. No data, allowlist, validation or duplicate-vote changes.
begin;
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
