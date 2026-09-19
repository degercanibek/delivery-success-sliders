-- Apply after the first MVP migration. Safe to rerun; preserves data and allowlist.
begin;
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
notify pgrst, 'reload schema';
commit;
