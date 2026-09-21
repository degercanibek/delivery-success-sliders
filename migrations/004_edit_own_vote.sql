-- Apply after migration 003. Preserves all existing votes and admin permissions.
begin;
-- A device token is a private bearer capability for its own response only.
-- No table grants, RLS policies or uniqueness constraints are changed.
create or replace function public.my_vote(p_session_id uuid, p_device_token text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare opened boolean; result jsonb;
begin
  if p_device_token is null or length(p_device_token) not between 16 and 128 then raise exception 'DSS_DEVICE'; end if;
  select is_open into opened from public.sessions where id=p_session_id;
  if not found then raise exception 'DSS_NOT_FOUND'; end if;
  if not opened then raise exception 'DSS_CLOSED'; end if;
  select jsonb_build_object('group_id',group_id,'answers',answers) into result
    from public.responses where session_id=p_session_id and device_token=p_device_token;
  return result;
end;
$$;
create or replace function public.update_vote(p_session_id uuid,p_group_id uuid,p_answers jsonb,p_device_token text)
returns void language plpgsql security definer set search_path = '' as $$
declare opened boolean;
begin
  select is_open into opened from public.sessions where id=p_session_id for update;
  if not found then raise exception 'DSS_NOT_FOUND'; end if;
  if not opened then raise exception 'DSS_CLOSED'; end if;
  perform dss_private.validate_vote(p_session_id,p_group_id,p_answers,p_device_token);
  update public.responses set group_id=p_group_id, answers=p_answers
    where session_id=p_session_id and device_token=p_device_token;
  if not found then raise exception 'DSS_VOTE_NOT_FOUND'; end if;
end;
$$;
revoke all on function public.my_vote(uuid,text) from public,anon,authenticated;
revoke all on function public.update_vote(uuid,uuid,jsonb,text) from public,anon,authenticated;
grant execute on function public.my_vote(uuid,text) to anon,authenticated;
grant execute on function public.update_vote(uuid,uuid,jsonb,text) to anon,authenticated;
notify pgrst, 'reload schema';
commit;
