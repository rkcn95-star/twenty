# agent-crm

Scaffold for a multi-tenant, agent-first CRM platform. Every business object is defined by the customer at runtime; only configuration is typed.

## Layout

- `apps/web`: Next.js app (App Router, TanStack Query and Table, shadcn/ui on Tailwind v4) in a compact, Twenty-inspired style.
- `packages/core`: migrations, schema runner, permissions, row predicates, record service, tool registry, `Session.execute`.
- `apps/server`: Hono REST API and the MCP endpoint.

## How it works

- **Tenancy.** A data model owns the objects, fields and the physical schema; each workspace points at one. Two modes:
  - `isolated`: a schema per customer (`ws_<uuid>`), one table per object. The customer's admins can create objects and fields. Use for payroll, finance and regulated customers.
  - `shared`: one schema (`shared_<uuid>`) for many workspaces. Every table has `workspace_id`, and RLS filters on it. Relations use composite foreign keys `(workspace_id, id)` because foreign keys skip RLS. Only the platform operator changes the model; tenants get no schema tools, but keep their own roles, forms, grids and reports.
  - Metadata and access config live in `core`.
- **Objects.** `create_object` (isolated models)  / `create_field` run DDL and metadata inserts in one transaction: one table per object, one column per field. Select fields use `text` plus a `CHECK`; relations are `<name>_id uuid` foreign keys.
- **RLS.** Every generated table has `FORCE ROW LEVEL SECURITY` and four policies for the `app_runtime` role. The workspace id and object id are baked into the policy; the request sets `app.workspace_id`, `app.read_objects` and `app.write_objects` with transaction-local `set_config`.
- **Many-to-many.** A `many_to_many` field creates a junction table (`jn_<field id>`) with its own RLS: reads need access to both objects, writes need write access to the source. Records never carry the links; use `list_links`, `add_links`, `remove_links` and `set_links`. Links respect the target's row rules, and reports can join across them. In shared mode the junction uses composite `(workspace_id, id)` keys, so links cannot cross tenants.
- **Human sign-in (Better Auth, tables in `core`).** Modelled on Twenty: one global identity (`core."user"`), a user principal per workspace membership (`principals.auth_user_id`, like `userWorkspace`), and per-workspace switches for password and Google sign-in with admin bypass flags (`workspaces.*_auth_enabled`, `*_auth_bypass_enabled`, `roles.can_bypass_auth`). The sign-in method is stored on the session and checked against the workspace on every request. Email and password requires a verified email, sent over SMTP. Google is enabled by setting `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` (not exercised by the tests). Browser requests send the session cookie plus `x-workspace-id`; invitations are accepted by the invited verified email only.
- **Access management.** A role flag `can_manage_access` gates everything below, separate from `can_manage_schema`. Over HTTP (API key or session, workspace in the path): roles, object and field permissions, row predicates, members and their roles, API keys (create returns the secret once, then rotate and revoke), and the audit log with filters and paging; see `apps/server/src/management-routes.ts`. Agents get the same operations as tools (`list_roles`, `set_object_access`, `add_row_predicate`, `set_member_roles`, `list_audit_log`...), but never key creation, so no secret enters a model's context. Every id is checked against the caller's workspace and data model, and no change may take a workspace from having an admin to having none.
- **Machine clients.** API keys come first for programmatic access and take precedence over sessions. They can expire, be revoked and be rotated (`revokeKey`, `rotateKey`); `last_used_at` is tracked. Agents and keys are principals with roles like any user.
- **Roles.** Object CRUD flags, field hidden/read-only flags, and row predicates (`created_by eq $principal`). Create, update and delete are checked in the service; RLS enforces read vs write per object.
- **Agents.** An agent acting for a user (`x-on-behalf-of` header) gets the intersection of both permission sets.
- **Tools.** Per object: `find_many_<plural>`, `find_one_<singular>`, `create_one_`, `update_one_`, `delete_one_`. Schema tools need the schema permission. All calls go through `Session.execute`, which validates, authorizes and audits.
- **Builders.** Forms, grids and reports are JSON definitions in `core.definitions`, validated with zod, saved by principals with the schema permission, and run with the caller's own permissions.
  - *Report builder:* `report.ts` compiles a definition (source object, relation joins, columns, aggregates, date buckets, nested filters, sort) to parameterised SQL. Identifiers come from metadata only, row rules and field masks apply per joined table, and it runs read-only with a 5 second timeout. `preview_report_sql` shows the SQL.
  - *Forms:* `single`, `multi` (linked records) and `parent_child` (header plus repeating rows, with edit that creates, updates and deletes rows). One RLS transaction, so any failure rolls everything back.
  - *Data grids:* compiled through the report engine. Actions: `set_fields`, `delete` (atomic), `run_tool`, and `open_form` (client side).
  - Tools: `save_form|grid|report`, `list_definitions`, `describe_form`, `submit_form`, `run_grid`, `run_grid_action`, `run_report`, `preview_report_sql`.
- **MCP.** `POST /mcp` with a bearer API key. Default mode exposes `get_tool_catalog`, `learn_tools`, `execute_tool`, `list_object_metadata`, `load_skill`. `/mcp?mode=direct` lists every permitted tool.

## Web app

Sign up and sign in (email verified over SMTP, Google optional), invitation links, a workspace switcher, light and dark themes, and:

- **Data model editor** for objects and fields, including relations and many-to-many.
- **Record tables** for every object: sort, filter, page, create, edit, delete, relations shown by name, many-to-many shown as chips.
- **Report builder**: joins, aggregates, date buckets, filters, charts, live SQL preview, save and reopen.
- **Form designer and runner**: single, multiple (linked) and parent-child forms with a live preview, required and read-only fields, defaults, row limits, and edit mode for parent-child forms. Saved atomically, including many-to-many values.
- **Grid designer and runner**: choose columns (including related fields), a built-in filter, sorting and page size, and row and bulk actions (set fields, delete, open a form, run a tool) with optional confirmation.
- **Settings**: members and API keys, roles (capabilities, object matrix, field access, row rules), sign-in methods and the audit log.

The browser talks to one origin: Next proxies `/api/auth/*` and `/v1/*` to the API server, so the Better Auth session cookie needs no CORS. Set the server's `APP_URL` to the web origin.

```bash
docker compose up -d                 # Postgres and a mail catcher (Mailpit, http://localhost:8025)
npm install
set -a; . ./.env.example; set +a     # or copy to .env and adjust
npm run dev:server                   # API on :3000
npm run dev:web                      # web on :3001
npm run smoke                        # two browser suites (core screens, then forms, grids, invitations); needs the three above and the dev mail sink
```

`npm run dev:smtp` is a tiny mail sink that writes each email to `apps/server/.dev-mail/`; the smoke test reads verification links from there (use it instead of Mailpit when running the smoke test).

Not in the UI yet: reorderable layout sections and conditional fields in forms, grid-level user filters, dashboards that combine reports, and installable app bundles.

## Run

```bash
docker compose up -d
npm install
cp .env.example .env
npm test
set -a; . ./.env; set +a
npm run dev
```

Create a workspace with its own schema, and its first admin key:

```bash
curl -X POST localhost:3000/v1/bootstrap -H "x-admin-token: $ADMIN_TOKEN" \
  -H 'content-type: application/json' -d '{"workspaceName":"Acme"}'
```

Shared mode (operator token required):

```bash
curl -X POST localhost:3000/v1/data-models -H "x-admin-token: $ADMIN_TOKEN" -H 'content-type: application/json' -d '{"name":"invoicing"}'
curl -X POST localhost:3000/v1/data-models/<modelId>/objects -H "x-admin-token: $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"nameSingular":"invoice","namePlural":"invoices","label":"Invoice"}'
curl -X POST localhost:3000/v1/bootstrap -H "x-admin-token: $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"workspaceName":"Acme","dataModelId":"<modelId>"}'
```

## Not built yet

- The visual builders and runtime renderers (the UI that produces and consumes these definitions).
- Conditional form logic, computed fields, reverse (one-to-many) joins in reports, raw SQL mode, dashboards, installable app bundles.
- Approved email domains (auto-join), password reset, SSO/SAML per workspace, 2FA.
- OAuth 2.1 for MCP clients (API keys work today).
- Bring-your-own model keys (encrypted per workspace) and the in-app agent that would use them.
- Many-to-many fields in forms and grids.
- `search` field type, many-to-many relations, field rename and type change, keyset pagination.
- Approvals for destructive tools, OAuth 2.1 on the MCP endpoint, rate limits, billing.
- Web app.
- Shared mode: unique indexes must include `workspace_id` (none are generated yet), tenant export, and moving a tenant between modes.
- `app_runtime` ships with a default password in `001_core.sql`; change it before any deployment.
