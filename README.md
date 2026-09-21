# Delivery Success Sliders

Small bilingual workshop application: vanilla HTML/CSS/JavaScript, Supabase and Apache ECharts. No framework, bundler, build step or server-side application. Supabase is the backend; CDN scripts provide its browser SDK and ECharts.

## Group counts and editing your own vote (migration 004)

For an existing project with migration 003 applied, run the entire `migrations/004_edit_own_vote.sql` in Supabase SQL Editor as the database owner **before deploying this frontend**. Then reload the application. It is transactional and safe to rerun; it preserves existing responses, the unique session/device index, RLS and the admin allowlist. Fresh installs use the updated `supabase.sql`.

Prominent cards above the results chart show each group's response count, including zero. Bar labels remain average allocation scores; group counts follow the chart blur to avoid exposing identities through known group sizes. Overall response totals stay readable. Hidden identities retain their existing Group A/B aliases. Counts refresh with the chart, respect Freeze Results, and are admin-only. Changing a vote's group transfers its count and recalculates averages without increasing the total.

Returning participants in the same browser/origin see their previous group and allocations prefilled, with **Update my vote**. The confirmation also offers **Edit my vote**. Editing is allowed only while voting is open. `submit_vote` still rejects duplicates; a separate `update_vote` RPC updates the existing row using the same server validator and session lock. It cannot create a response. After an admin reset, reload to submit a new vote.

The new `my_vote` endpoint returns only the matching response's group and allocations when given its session ID and private device token. It returns no response IDs, timestamps, tokens, counts or other participants' data. The token is a bearer capability: possession grants access to that one vote, so it must never be put in a shared URL or logged. This is browser-based ownership, not verified personal identity; clearing storage, switching domains, using another browser or a new private-browsing session does not recover the previous vote. Existing UUID tokens work without conversion. Public table reads and aggregate/export permissions are unchanged.

## Participant access upgrade (required for existing MVP projects)

1. If not already applied, run the entire `migrations/002_presenter_tools.sql` in the Supabase SQL Editor as the database owner. This adds admin-only duplication and exports.
2. Run the **entire `migrations/003_participant_access.sql`** in a new SQL Editor query as the database owner. This transactional, rerunnable migration preserves sessions, responses and your existing admin allowlist. It replaces configuration read policies, restricts aggregates to the allowlisted admin, and adds the minimal `voting_session` RPC.
3. Reload application tabs after success. If an RPC is briefly unavailable, wait for the API schema cache to reload and retry. Verify the anonymous access checks below before sharing a workshop QR.

Do not rerun the full schema or recreate your admin allowlist for this upgrade. Until migration 003 succeeds, the old database still permits public aggregates; frontend changes alone do not secure them. The new voting page requires its new RPC. Coordinate this upgrade before workshop use. Editing this repository does not apply hosted SQL or enable deployment.

## Fresh installation or upgrade from the original prototype

The new application **requires the updated `supabase.sql`**. Replacing only the frontend will not work. The SQL supports a fresh project and the original MVP schema, and can be rerun. Apply it using the Supabase SQL Editor as the project database owner, not from the browser.

1. Pause testing and close old application tabs. Export/backup `sessions`, `groups`, `dimensions`, and `responses` if you need their contents. The upgrade takes table locks and replaces all policies on those four application-owned tables; do not use it unreviewed on tables customized for another application.
2. In Supabase **Authentication → Users**, create or identify your one admin email/password account. Ensure its email is confirmed and copy its **User UID**.
3. In Authentication settings, turn **Allow new users to sign up** off. Keep email/password sign-in enabled. Existing users do not automatically become administrators. See [Supabase auth settings](https://supabase.com/docs/guides/auth/general-configuration).
4. Open a new SQL Editor query, paste the **entire current `supabase.sql`**, and run it once. It uses a transaction: failures roll the upgrade back. No responses are automatically deleted and existing open/closed states are preserved. New sessions default to closed.
5. If the script reports an invalid response UUID or duplicate session/device votes, export and inspect that data first. Correct it or explicitly delete the unwanted legacy test responses in the dashboard, then rerun the whole script. Old responses must contain exactly the session's current dimensions, numbers in 0–100 totaling 100, a group in that session, at least two dimensions, and a device token 16–128 characters long. Duplicate `(session_id, device_token)` pairs must be resolved. An error means the old policies remain in effect until a successful rerun.
6. After the script succeeds, run the following **separate SQL query**, replacing the placeholder with the admin's real User UID:

   ```sql
   insert into dss_private.admin_users (singleton, user_id)
   values (true, 'REPLACE-WITH-ADMIN-USER-UUID'::uuid)
   on conflict (singleton) do update set user_id = excluded.user_id;
   ```

   This replaces the single allowlisted administrator. The foreign key rejects nonexistent users. Leave `dss_private` out of Supabase's exposed API schemas. The allowlist cannot be changed through browser credentials.
7. Verify the allowlist in the SQL Editor:

   ```sql
   select a.user_id, u.email
   from dss_private.admin_users a
   join auth.users u on u.id = a.user_id;
   ```

   Exactly your chosen account should appear. Without that row, nobody can administer the app. To revoke access, delete that row in the SQL Editor.
8. Verify `SUPABASE_URL` and `SUPABASE_KEY` in `app.js` point at this project. Use a **publishable** key only. Never put a service-role or secret key in the client.
9. Serve the updated files locally and sign in at `#admin`. If the API briefly reports a missing RPC immediately after migration, wait for the schema cache reload and retry. Do not reuse an old frontend tab; its direct database writes are deliberately denied by the new permissions.

These instructions do not enable GitHub Pages or modify the hosted project automatically.

## Architecture and access

- `index.html`, `styles.css`, `app.js`: static UI, routing, forms, and ECharts presentation.
- `allocation.mjs`: pure independent allocation and remaining-points functions shared with local tests.
- `sessions`: bilingual metadata, slug and voting state.
- `groups` / `dimensions`: bilingual names/descriptions and display order, owned by a session.
- `responses`: session, group, JSON dimension allocations and a browser token. Unique per session/token.
- `dss_private.admin_users`: single allowlisted Supabase Auth user, managed only in SQL Editor.
- `is_admin()`: checks the signed-in UID against that allowlist.
- `admin_action(...)`: administrator-only mutations. Direct INSERT/UPDATE/DELETE access is revoked from both API roles; RLS remains enabled.
- `submit_vote(...)`: anonymous or signed-in voting with server-side validation and uniqueness. Locks the session row before checking state and writing.
- `voting_session(p_slug)`: minimal bilingual session/group/dimension content for a known, open session only. It exposes no counts, responses, device tokens or session list.
- `session_results(...)`: allowlisted-admin-only aggregate response counts and group/dimension averages. It returns no raw responses, response IDs, timestamps, or device tokens. Groups without votes have no average and show no bar.

Direct reads of sessions, groups, dimensions and raw responses are restricted to the allowlisted admin. Anonymous users and authenticated non-admins can only retrieve the minimal voting configuration through `voting_session` and submit a valid vote through `submit_vote`. With their private device token they can retrieve/edit only their own response through `my_vote`/`update_vote` while voting is open. They cannot enumerate sessions, query aggregates, or export responses. The results UI checks admin authentication and uses the admin-only aggregate RPC. Database-owner SQL access remains privileged for maintenance. RPCs use a fixed empty search path and explicit execute grants, following [Supabase function guidance](https://supabase.com/docs/guides/database/functions).

“One vote per device” means one vote per browser profile/origin using a persistent localStorage token. The unique database index handles double clicks, retries and concurrent submissions with that token. Clearing storage, using private browsing, another profile, or deliberately supplying a different token bypasses this lightweight identity. It is not a verified-person voting system. Storage must be enabled. A database response reset permits that browser to vote again.

Aggregates are available only to the admin, including small groups; a one-person group's average necessarily equals that person's allocation. Blur/reveal controls are presentation tools, not access controls.

## Local preview and checks

From the repository directory:

```sh
python3 -m http.server 8000
```

Open `http://localhost:8000/#admin` for administration. The application root only explains how to join with a participant link. Use HTTP(S), not `file://`, because the client uses ES modules. Localhost and HTTPS support the browser UUID API. No install/build step is needed to run the application. Internet access is needed for CDN libraries and Supabase.

```sh
node --check app.js
node --check allocation.mjs
node --test tests/allocation.test.mjs tests/presentation.test.mjs tests/exports.test.mjs
```

Optional deeper regression tests use isolated PGlite (embedded PostgreSQL) and jsdom, not the hosted database. Install these outside the repository and pass the directory containing their `node_modules`:

```sh
npm install --prefix /tmp/dss-review-tools --no-audit --no-fund --ignore-scripts @electric-sql/pglite jsdom
DSS_TEST_TOOLS=/tmp/dss-review-tools node --test tests/*.test.mjs
```

The database harness supplies minimal Supabase roles/auth helpers. It checks SQL execution, migration reruns, permissions, validation, duplicate votes, configuration locks and deletion. It does not replace testing real Supabase Auth/PostgREST or concurrency on a hosted project.

## First end-to-end test after migration

1. Sign in at `#admin`. A signed-out visitor to `#manage?s=...` must get a login form. An authenticated account outside the allowlist must be denied, including direct RPC calls.
2. Create a bilingual session. While closed, add at least one group and two dimensions. Open voting. Copy the voting URL into a separate browser profile.
3. Select a group. Drag sliders and edit numbers, including 0 and 100, on desktop and mobile. Changing a dimension must preserve the other values. Check remaining/over-budget feedback and per-dimension “Use remaining points” buttons. Submit must stay disabled until the total is exactly 100.
4. Submit; verify success. Reopen in the same browser: the previous values must appear and Update my vote must keep the total response count unchanged. A direct duplicate `submit_vote` must still fail. Check a second profile can submit independently; closing voting must reject edits.
5. Open results and wait up to about three seconds for new votes. Independently reveal labels, values and axis; adjust blur from 0–100%. Freeze to hold the displayed chart/count, submit a vote from another browser identity, and verify the display changes only after Unfreeze.
6. After the first vote, configuration controls must be locked even after closing voting. Direct configuration RPC calls must fail too. Votes after close must fail.
7. Confirm “Delete All Responses.” This also closes voting. Configuration should unlock; after reopening, the original browser can vote again.
8. Confirm deletion of a disposable session. Its groups, dimensions and responses must disappear; old URLs must show a useful error.
9. From a separate signed-out browser, verify `#results?s=SLUG` requires login and never shows counts or a chart. Check anonymous aggregate RPC calls, direct configuration/raw-response queries and administration mutations are denied. An authenticated non-admin must also be denied results. A known open slug may return only voting configuration; closed/missing slugs must fail. Test malformed allocations and groups/dimensions from a different session against the RPC. None should be stored.

## Routes and eventual GitHub Pages deployment

Routes are `#home`, `#admin`, `#manage?s=SLUG`, `#vote?s=SLUG`, and `#results?s=SLUG`. `#/admin` and the old `?s=SLUG#vote` / `?s=SLUG#results` links also work. All navigation uses hash routing with no forced page reloads. A literal server path `/admin` is not used: GitHub Pages has no SPA rewrite server.

GitHub Pages is intentionally not enabled by this change. When deployment is approved later, publish `main` / repository root. All application assets use relative URLs, so repository subpaths work. For a custom subdomain, configure its CNAME to `degercanibek.github.io` and enforce HTTPS after GitHub validates it. Moving between localhost, the GitHub Pages domain and a custom domain changes browser storage and therefore the device identity.


## Participant sharing and independent allocation

Session management includes one prominent **Participant QR Code**, the exact anonymous participant URL immediately beneath it, and Copy link. The QR is generated in the browser with [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator/tree/master/js) 1.4.4 from jsDelivr. No QR image service receives the link. If the QR library or clipboard is unavailable, the selectable link remains usable. The link preserves the site's repository path and points directly to voting without sign-in: `https://HOST/OPTIONAL-PROJECT-PATH/#vote?s=SESSION-SLUG`. Both GitHub Pages project paths and future custom domains use the current origin/path automatically.

Participants see only a language toggle, session title/description, group selection with descriptions, dimensions with descriptions, allocations and the budget/submit bar. At exactly 100 points the total turns green. Successful submission replaces the form with a bilingual confirmation; there is no Results link. Loading, error and confirmation states retain this isolated layout, with no admin/home/results navigation or response counts. Management and results remain at their explicit protected hash routes; moving between them preserves the admin login.

Localhost QR links only work on the hosting computer. Phone participation requires a reachable site, normally deployed over HTTPS. This update does not enable hosting or change the local server binding.

Each dimension is now independent. Its “Use remaining points” button sets it to 100 minus the others without changing them, and is disabled with an explanation if the others already exceed 100. The total turns red above 100; submission requires exactly 100. Existing database validation and duplicate protection remain unchanged. The second-iteration duplication/export tools require the additive SQL migration described above.


## Presenter dashboard

The x axis always represents success dimensions. Side-by-side series within each dimension represent participant groups; values are group averages, not totals. Groups without responses show no bar rather than a misleading zero. The screen starts with all labels/values/axis hidden and blur at 100%.

- Blur runs from 0–100%; 100% fully conceals the chart. At nonzero blur, tooltips are disabled so hovering cannot bypass the effect.
- Dimension names, group identities, exact values and Y axis are independent toggles. Hidden labels become Dimension A/B/... and Group A/B/.... Hidden series use the same neutral color; their randomized per-page order is unrelated to configuration order. Aliases remain stable while that presentation is open, including when new groups or dimensions appear. Revealing group identities adds real names and colors; concealing them immediately clears old labels/tooltips. Once an audience has seen an identity or recognized a distribution, hiding labels cannot erase that knowledge.
- **Fully Blur** changes only blur. **Fully Reveal** sets blur to zero and enables all four toggles. **Reset Reveal** restores all-hidden/100% blur without changing freeze state or existing aliases.
- New results load automatically through the admin-only aggregate RPC, approximately every three seconds after the preceding request completes. No raw-response subscriptions or new public read permissions are used. Connection errors show retry status and keep the last successful snapshot visible.
- **Freeze Results** pauses display updates, including count and configuration. Votes continue to be stored normally. **Unfreeze** fetches the latest snapshot immediately. In-flight responses from before a freeze cannot overwrite it. Requests/timers are cleaned up when navigating away.
- **Presenter Mode** requests browser fullscreen and hides navigation. If fullscreen is unavailable, a full-window projection layout is used. Chart text, legends, values, bar widths, spacing, headings and controls scale with the available window width and height; resizing recomputes the chart. The plot fills the space remaining below the header. Controls collapse; click their summary to expand. The Exit Presenter button and Escape both exit. Reveal transitions respect reduced-motion preferences. See [ECharts transitions](https://echarts.apache.org/handbook/en/how-to/animation/transition/) and [browser fullscreen behavior](https://developer.mozilla.org/en-US/docs/Web/API/Element/requestFullscreen).

Reveal is a presentation mechanism, not an authorization boundary. Database grants, RLS and RPC allowlist checks protect configuration, aggregate results and raw responses. Signing out clears the results screen, including a frozen presentation.

## Duplication and exports

Session management now offers a compact Duplicate Session form requiring a new unique slug. The server atomically copies both languages, descriptions, groups, dimensions and sort order with new IDs. The copy starts closed with zero responses. Source data is untouched, even when the source has votes.

- **CSV:** one row per individual response, including response ID/time, session slug, group ID and bilingual group names, plus one column per dimension with bilingual names and its ID. UTF-8 BOM supports Turkish in spreadsheets. Fields are quoted and formula-like text is escaped for spreadsheet safety.
- **JSON:** a versioned archive containing the complete session, bilingual groups/dimensions and individual responses, with IDs and allocation mappings preserved. It supports later reuse; importing an archive is not implemented in this iteration.
- Both exports come from one consistent server-side snapshot with no default 1,000-row API truncation. Only the allowlisted admin can call the export RPC. Device tokens are excluded from both formats.

To verify the upgrade: duplicate a voted session and confirm the copy has zero responses/new configuration IDs; export the original in both formats and compare counts/values; check an authenticated non-admin and an anonymous client cannot call either RPC. The local PostgreSQL tests cover these permissions and an export exceeding 1,000 responses. Hosted validation of the new RPCs remains necessary after running the migration.

Mobile voting uses clear step labels, full group descriptions, larger touch controls, numeric keyboard hints and a sticky budget/submit bar. Allocations remain independent. “Use remaining points” preserves the other dimensions, and the server still rejects non-100 totals. The interface is designed for a short workshop response; actual completion time depends on the number and length of dimensions and should be checked with participants.
