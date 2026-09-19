import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(`${process.env.DSS_TEST_TOOLS || '/tmp/dss-review-tools'}/package.json`);
const { PGlite } = require('@electric-sql/pglite');
// PGlite has built-in gen_random_uuid but doesn't bundle pgcrypto.
const sql = (await readFile(new URL('../supabase.sql', import.meta.url), 'utf8')).replace('create extension if not exists pgcrypto;', '');
const adminId = '10000000-0000-4000-8000-000000000001';
const otherId = '10000000-0000-4000-8000-000000000002';
const bootstrap = `create role anon; create role authenticated; create schema auth;
 create table auth.users(id uuid primary key);
 create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
 insert into auth.users values ('${adminId}'),('${otherId}');`;

test('SQL migration, role boundaries, voting, aggregates and lifecycle', async t => {
  const db = new PGlite();
  await db.exec(bootstrap);
  await db.exec(sql.slice(0, sql.indexOf('create schema if not exists dss_private;')) + '\ncommit;');
  await db.exec(`alter table public.responses enable row level security;
    create policy "public read responses" on public.responses for select using(true);
    create policy "admin responses" on public.responses for all to authenticated using(true) with check(true);
    grant all on public.sessions,public.groups,public.dimensions,public.responses to anon,authenticated;`);
  await db.exec(sql);
  await db.exec(sql); // Upgrade is repeatable.
  await db.query('insert into dss_private.admin_users(user_id) values($1)', [adminId]);
  async function as(role, uid, query, params = []) {
    await db.exec('begin');
    try {
      await db.exec(`set local role ${role}`);
      await db.query("select set_config('request.jwt.claim.sub',$1,true)", [uid || '']);
      const result = await db.query(query, params);
      await db.exec('commit');
      return result.rows;
    } catch (error) { await db.exec('rollback'); throw error; }
  }
  const admin = (query, params) => as('authenticated', adminId, query, params);
  const anon = (query, params) => as('anon', null, query, params);
  const action = async (op, sid = null, payload = {}) => (await admin('select public.admin_action($1,$2,$3) id', [op, sid, payload]))[0].id;
  let sid, gid, dims, otherSession, foreignGroup, foreignDimension;
  const token = 'browser-token-one-000001';
  const cast = 'select public.submit_vote($1,$2,$3,$4)';
  await t.test('allowlist is single-user and denies anonymous/non-admin mutations', async () => {
    assert.equal((await anon('select public.is_admin() value'))[0].value, false);
    assert.equal((await admin('select public.is_admin() value'))[0].value, true);
    await assert.rejects(anon("select public.admin_action('create_session')"), /permission denied/);
    await assert.rejects(as('authenticated', otherId, "select public.admin_action('create_session')"), /DSS_FORBIDDEN/);
    await assert.rejects(admin('select * from dss_private.admin_users'), /permission denied/);
    await assert.rejects(db.query('insert into dss_private.admin_users(user_id) values($1)', [otherId]), /duplicate key/);
    await assert.rejects(admin("insert into public.sessions(slug) values('bypass')"), /permission denied/);
  });
  await t.test('closed setup, minimum dimensions, safe opening and direct-write denial', async () => {
    sid = await action('create_session', null, { slug: 'test-session', title_tr: 'Deneme', title_en: 'Test' });
    assert.equal((await anon('select is_open from public.sessions where id=$1', [sid]))[0].is_open, false);
    await assert.rejects(action('open', sid), /DSS_CONFIG/);
    await action('add_group', sid, { name_tr: 'Grup', name_en: 'Group' });
    gid = (await anon('select id from public.groups where session_id=$1', [sid]))[0].id;
    await action('add_dimension', sid, { name_tr: 'A', name_en: 'A' });
    await assert.rejects(action('open', sid), /DSS_CONFIG/);
    await action('add_dimension', sid, { name_tr: 'B', name_en: 'B' });
    dims = (await anon('select id from public.dimensions where session_id=$1 order by sort_order', [sid])).map(d => d.id);
    await action('open', sid);
    await assert.rejects(action('add_dimension', sid, { name_tr: 'C', name_en: 'C' }), /DSS_CLOSE_FIRST/);
    for (const table of ['sessions', 'groups', 'dimensions', 'responses']) {
      await assert.rejects(anon(`delete from public.${table}`), /permission denied/);
      await assert.rejects(admin(`delete from public.${table}`), /permission denied/);
      await assert.rejects(admin(`update public.${table} set id=id`), /permission denied/);
    }
    otherSession = await action('create_session', null, { slug: 'other-session', title_tr: 'Diğer', title_en: 'Other' });
    await action('add_group', otherSession, { name_tr: 'G', name_en: 'G' });
    await action('add_dimension', otherSession, { name_tr: 'D', name_en: 'D' });
    foreignGroup = (await anon('select id from public.groups where session_id=$1', [otherSession]))[0].id;
    foreignDimension = (await anon('select id from public.dimensions where session_id=$1', [otherSession]))[0].id;
  });
  const valid = () => ({ [dims[0]]: 40, [dims[1]]: 60 });
  await t.test('rejects wrong totals, bounds, types, keys, groups and tokens', async () => {
    for (const answers of [null, [], {}, { [dims[0]]: 99 }, { [dims[0]]: 40, [dims[1]]: 59 }, { [dims[0]]: -1, [dims[1]]: 101 }, { [dims[0]]: '40', [dims[1]]: 60 }, { [dims[0]]: null, [dims[1]]: 100 }, { ...valid(), extra: 0 }, { [dims[0]]: 40, [foreignDimension]: 60 }]) {
      await assert.rejects(anon(cast, [sid, gid, answers, token]), /DSS_(ANSWERS|TOTAL)/);
    }
    await assert.rejects(anon(cast, [sid, foreignGroup, valid(), token]), /DSS_GROUP/);
    await assert.rejects(anon(cast, [sid, gid, valid(), null]), /DSS_DEVICE/);
    await assert.rejects(anon(cast, [otherId, gid, valid(), token]), /DSS_NOT_FOUND/);
    await assert.rejects(anon(cast, [otherSession, foreignGroup, {}, token]), /DSS_CLOSED/);
  });
  await t.test('accepts valid votes once, protects raw data and exposes correct aggregates', async () => {
    await anon(cast, [sid, gid, valid(), token]);
    await assert.rejects(anon(cast, [sid, gid, valid(), token]), /DSS_DUPLICATE/);
    await anon(cast, [sid, gid, { [dims[0]]: 60, [dims[1]]: 40 }, 'browser-token-two-000002']);
    await assert.rejects(anon('select * from public.responses'), /permission denied/);
    assert.equal((await as('authenticated', otherId, 'select * from public.responses')).length, 0);
    assert.equal((await admin('select * from public.responses')).length, 2);
    const result = (await anon('select public.session_results($1) result', [sid]))[0].result;
    assert.equal(result.response_count, 2);
    assert.equal(result.groups[0].response_count, 2);
    assert.ok(result.averages.every(a => a.average === 50));
    assert.deepEqual(Object.keys(result).sort(), ['averages', 'groups', 'response_count']);
    assert.ok(!JSON.stringify(result).includes('device'));
    await db.exec(sql); // Reapply with real valid rows and the allowlist intact.
    assert.equal((await admin('select public.is_admin() value'))[0].value, true);
  });
  await t.test('additive migration, duplication and exports keep administrator boundaries', async () => {
    const migration = await readFile(new URL('../migrations/002_presenter_tools.sql', import.meta.url), 'utf8');
    await db.exec(migration); await db.exec(migration);
    for (const query of ["select public.duplicate_session($1,'copy-session')", 'select public.export_session($1)']) {
      await assert.rejects(anon(query, [sid]), /permission denied/);
      await assert.rejects(as('authenticated', otherId, query, [sid]), /DSS_FORBIDDEN/);
    }
    await assert.rejects(admin("select public.duplicate_session($1,'Bad slug')", [sid]), /DSS_SLUG/);
    await assert.rejects(admin("select public.duplicate_session($1,'test-session')", [sid]), /duplicate key/);
    const copiedId = (await admin("select public.duplicate_session($1,'copy-session') id", [sid]))[0].id;
    const copied = (await admin('select public.export_session($1) archive', [copiedId]))[0].archive;
    const original = (await admin('select public.export_session($1) archive', [sid]))[0].archive;
    assert.equal(copied.session.is_open, false);
    assert.equal(copied.session.title_tr, original.session.title_tr);
    assert.equal(copied.session.description_en, original.session.description_en);
    assert.equal(copied.groups.length, original.groups.length);
    assert.equal(copied.dimensions.length, original.dimensions.length);
    assert.equal(copied.responses.length, 0);
    assert.notEqual(copied.groups[0].id, original.groups[0].id);
    assert.notEqual(copied.dimensions[0].id, original.dimensions[0].id);
    assert.equal(original.responses.length, 2);
    assert.equal(original.schema_version, 1);
    assert.ok(original.responses.every(r => !('device_token' in r)));
    // JSON aggregation is not limited by PostgREST's normal 1000-row table cap.
    await db.query(`insert into public.responses(session_id,group_id,answers,device_token)
      select $1,$2,$3, 'export-test-token-' || n from generate_series(1,1001) n`, [sid, gid, valid()]);
    assert.equal((await admin('select public.export_session($1) archive', [sid]))[0].archive.responses.length, 1003);
    await db.query("delete from public.responses where device_token like 'export-test-token-%'");
    await assert.rejects(admin('select public.export_session($1)', [otherId]), /DSS_NOT_FOUND/);
    await action('delete_session', copiedId);
  });
  await t.test('locks configuration after votes, closes voting, and resets safely', async () => {
    await action('close', sid);
    await assert.rejects(anon(cast, [sid, gid, valid(), 'browser-token-three-0003']), /DSS_CLOSED/);
    for (const [op, payload] of [['delete_group', { id: gid }], ['delete_dimension', { id: dims[0] }], ['add_group', { name_tr: 'X', name_en: 'X' }], ['add_dimension', { name_tr: 'X', name_en: 'X' }]]) {
      await assert.rejects(action(op, sid, payload), /DSS_LOCKED/);
    }
    await action('open', sid);
    await action('delete_responses', sid);
    assert.equal((await anon('select is_open from public.sessions where id=$1', [sid]))[0].is_open, false);
    await action('add_dimension', sid, { name_tr: 'C', name_en: 'C' });
    const added = (await anon('select id from public.dimensions where session_id=$1 and name_en=$2', [sid, 'C']))[0].id;
    await action('delete_dimension', sid, { id: added });
    await action('open', sid);
    await anon(cast, [sid, gid, valid(), token]); // Reset permits the same browser.
  });
  await t.test('session deletion cascades and missing sessions are guarded', async () => {
    await action('delete_session', sid);
    for (const table of ['groups', 'dimensions', 'responses']) assert.equal((await db.query(`select count(*)::int n from public.${table} where session_id=$1`, [sid])).rows[0].n, 0);
    await assert.rejects(anon('select public.session_results($1)', [sid]), /DSS_NOT_FOUND/);
    await assert.rejects(action('close', sid), /DSS_NOT_FOUND/);
  });
  await db.close();
});

test('migration stops without silently deleting invalid legacy responses', async () => {
  const db = new PGlite();
  await db.exec(bootstrap);
  // Original schema section, before new private objects and access restrictions.
  await db.exec(sql.slice(0, sql.indexOf('create schema if not exists dss_private;')) + '\ncommit;');
  const sid = (await db.query("insert into public.sessions(slug) values('legacy') returning id")).rows[0].id;
  const gid = (await db.query("insert into public.groups(session_id) values($1) returning id", [sid])).rows[0].id;
  await db.query("insert into public.responses(session_id,group_id,answers) values($1,$2,'{}')", [sid, gid]);
  await assert.rejects(db.exec(sql), /Migration stopped: response/);
  await db.exec('rollback');
  assert.equal((await db.query('select count(*)::int n from public.responses')).rows[0].n, 1);
  assert.equal((await db.query("select to_regnamespace('dss_private') n")).rows[0].n, null);
  await db.close();
});
