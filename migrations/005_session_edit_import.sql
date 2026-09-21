-- Apply after 004. Does not modify existing data or RLS. Safe to rerun.
begin;
-- Metadata edits preserve identifiers and votes. Structural edits remain locked.
create or replace function public.edit_session_content(p_session_id uuid,p_kind text,p_payload jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare target uuid; prefix text; label_tr text; label_en text;
begin
  if not public.is_admin() then raise exception 'DSS_FORBIDDEN'; end if;
  perform 1 from public.sessions where id=p_session_id for update;
  if not found then raise exception 'DSS_NOT_FOUND'; end if;
  if p_kind not in ('session','group','dimension') or p_kind is null then raise exception 'DSS_ACTION'; end if;
  prefix:=case when p_kind='session' then 'title' else 'name' end;
  label_tr:=btrim(coalesce(p_payload->>(prefix||'_tr'),''));
  label_en:=btrim(coalesce(p_payload->>(prefix||'_en'),''));
  if jsonb_typeof(p_payload) is distinct from 'object' or label_tr='' or label_en='' or length(label_tr)>200 or length(label_en)>200 then raise exception 'DSS_NAME'; end if;
  if jsonb_typeof(p_payload->(prefix||'_tr')) is distinct from 'string' or jsonb_typeof(p_payload->(prefix||'_en')) is distinct from 'string'
    or (p_payload ? 'description_tr' and jsonb_typeof(p_payload->'description_tr') not in ('string','null'))
    or (p_payload ? 'description_en' and jsonb_typeof(p_payload->'description_en') not in ('string','null')) then raise exception 'DSS_NAME'; end if;
  if p_kind='session' then
    if coalesce(p_payload->>'slug','') !~ '^[a-z0-9]+(-[a-z0-9]+)*$' then raise exception 'DSS_SLUG'; end if;
    update public.sessions set slug=p_payload->>'slug',title_tr=label_tr,title_en=label_en,
      description_tr=coalesce(p_payload->>'description_tr',''),description_en=coalesce(p_payload->>'description_en','') where id=p_session_id;
  else
    target:=(p_payload->>'id')::uuid;
    if p_kind='group' then
      update public.groups set name_tr=label_tr,name_en=label_en,description_tr=coalesce(p_payload->>'description_tr',''),description_en=coalesce(p_payload->>'description_en',''),sort_order=coalesce((p_payload->>'sort_order')::int,sort_order) where id=target and session_id=p_session_id;
    else
      update public.dimensions set name_tr=label_tr,name_en=label_en,description_tr=coalesce(p_payload->>'description_tr',''),description_en=coalesce(p_payload->>'description_en',''),sort_order=coalesce((p_payload->>'sort_order')::int,sort_order) where id=target and session_id=p_session_id;
    end if;
    if not found then raise exception 'DSS_NOT_FOUND'; end if;
  end if;
end;
$$;

-- Import only into a NEW closed session; a failure rolls back the entire call.
create or replace function public.import_session(p_archive jsonb,p_slug text,p_include_responses boolean default true)
returns uuid language plpgsql security definer set search_path = '' as $$
declare sid uuid; source_id text; item jsonb; old_id text; new_id uuid;
  gm jsonb:='{}'; dm jsonb:='{}'; seen jsonb:='{}'; answers jsonb; pair record;
  target_group uuid; token text; ordinal integer; kind text; items jsonb;
begin
  if not public.is_admin() then raise exception 'DSS_FORBIDDEN'; end if;
  if p_slug is null or p_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' then raise exception 'DSS_SLUG'; end if;
  if jsonb_typeof(p_archive) is distinct from 'object' or p_archive->'schema_version' is distinct from '1'::jsonb
     or jsonb_typeof(p_archive->'session') is distinct from 'object'
     or jsonb_typeof(p_archive->'groups') is distinct from 'array'
     or jsonb_typeof(p_archive->'dimensions') is distinct from 'array'
     or jsonb_typeof(p_archive->'responses') is distinct from 'array'
     or octet_length(p_archive::text)>5242880 then raise exception 'DSS_ARCHIVE'; end if;
  if jsonb_array_length(p_archive->'groups')>100 or jsonb_array_length(p_archive->'dimensions')>100 or jsonb_array_length(p_archive->'responses')>10000 then raise exception 'DSS_ARCHIVE'; end if;
  source_id:=p_archive->'session'->>'id';
  if source_id is null or source_id='' then raise exception 'DSS_ARCHIVE'; end if;
  sid:=public.admin_action('create_session',null,(p_archive->'session')||jsonb_build_object('slug',p_slug));
  perform public.edit_session_content(sid,'session',(p_archive->'session')||jsonb_build_object('slug',p_slug));
  foreach kind in array array['group','dimension'] loop
    items:=p_archive->(kind||'s'); ordinal:=0;
    for item in select value from jsonb_array_elements(items) loop
      old_id:=item->>'id';
      if jsonb_typeof(item) is distinct from 'object' or old_id is null or old_id='' or length(old_id)>200
        or (item ? 'session_id' and item->>'session_id' is distinct from source_id)
        or (case when kind='group' then gm else dm end) ? old_id then raise exception 'DSS_ARCHIVE'; end if;
      new_id:=gen_random_uuid();
      if kind='group' then
        insert into public.groups(id,session_id) values(new_id,sid);
        gm:=gm||jsonb_build_object(old_id,new_id);
      else
        insert into public.dimensions(id,session_id) values(new_id,sid);
        dm:=dm||jsonb_build_object(old_id,new_id);
      end if;
      perform public.edit_session_content(sid,kind,item||jsonb_build_object('id',new_id,'sort_order',coalesce((item->>'sort_order')::int,ordinal)));
      ordinal:=ordinal+1;
    end loop;
  end loop;
  if coalesce(p_include_responses,true) then
    for item in select value from jsonb_array_elements(p_archive->'responses') loop
      old_id:=item->>'id';
      if jsonb_typeof(item) is distinct from 'object' or old_id is null or old_id='' or seen ? old_id
        or (item ? 'session_id' and item->>'session_id' is distinct from source_id)
        or jsonb_typeof(item->'answers') is distinct from 'object' or not (gm ? (item->>'group_id')) then raise exception 'DSS_ARCHIVE'; end if;
      seen:=seen||jsonb_build_object(old_id,true);
      answers:='{}';
      for pair in select key,value from jsonb_each(item->'answers') loop
        if not (dm ? pair.key) then raise exception 'DSS_ARCHIVE'; end if;
        answers:=answers||jsonb_build_object(dm->>pair.key,pair.value);
      end loop;
      target_group:=(gm->>(item->>'group_id'))::uuid;
      token:=gen_random_uuid()::text;
      perform dss_private.validate_vote(sid,target_group,answers,token);
      insert into public.responses(session_id,group_id,answers,device_token,created_at)
        values(sid,target_group,answers,token,coalesce((item->>'created_at')::timestamptz,now()));
    end loop;
  end if;
  return sid;
exception when invalid_text_representation or numeric_value_out_of_range or invalid_datetime_format or datetime_field_overflow then
  raise exception 'DSS_ARCHIVE';
end;
$$;
revoke all on function public.edit_session_content(uuid,text,jsonb) from public,anon,authenticated;
revoke all on function public.import_session(jsonb,text,boolean) from public,anon,authenticated;
grant execute on function public.edit_session_content(uuid,text,jsonb) to authenticated;
grant execute on function public.import_session(jsonb,text,boolean) to authenticated;
notify pgrst, 'reload schema';
commit;
