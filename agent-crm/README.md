# agent-crm

Scaffold for a multi-tenant, agent-first CRM platform. Every business object is defined by the customer at runtime; only configuration is typed.

## Layout

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
- **Machine clients.** API keys can expire, be revoked and be rotated (`revokeKey`, `rotateKey`); `last_used_at` is tracked. Agents and keys are principals with roles like any user.
- **Roles.** Object CRUD flags, field hidden/read-only flags, and row predicates (`created_by eq $principal`). Create, update and delete are checked in the service; RLS enforces read vs write per object.
- **Agents.** An agent acting for a user (`x-on-behalf-of` header) gets the intersection of both permission sets.
- **Tools.** Per object: `find_many_<plural>`, `find_one_<singular>`, `create_one_`, `update_one_`, `delete_one_`. Schema tools need the schema permission. All calls go through `Session.execute`, which validates, authorizes and audits.
- **Builders.** Forms, grids and reports are JSON definitions in `core.definitions`, validated with zod, saved by principals with the schema permission, and run with the caller's own permissions.
  - *Report builder:* `report.ts` compiles a definition (source object, relation joins, columns, aggregates, date buckets, nested filters, sort) to parameterised SQL. Identifiers come from metadata only, row rules and field masks apply per joined table, and it runs read-only with a 5 second timeout. `preview_report_sql` shows the SQL.
  - *Forms:* `single`, `multi` (linked records) and `parent_child` (header plus repeating rows, with edit that creates, updates and deletes rows). One RLS transaction, so any failure rolls everything back.
  - *Data grids:* compiled through the report engine. Actions: `set_fields`, `delete` (atomic), `run_tool`, and `open_form` (client side).
  - Tools: `save_form|grid|report`, `list_definitions`, `describe_form`, `submit_form`, `run_grid`, `run_grid_action`, `run_report`, `preview_report_sql`.
- **MCP.** `POST /mcp` with a bearer API key. Default mode exposes `get_tool_catalog`, `learn_tools`, `execute_tool`, `list_object_metadata`, `load_skill`. `/mcp?mode=direct` lists every permitted tool.

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
- Human login (planned: Better Auth with Google and email plus password with verification), invites, and an HTTP API for managing roles, predicates and keys (use `core/src/access.ts` for now).
- Bring-your-own model keys (encrypted per workspace) and the in-app agent that would use them.
- Many-to-many fields in forms and grids.
- `search` field type, many-to-many relations, field rename and type change, keyset pagination.
- Approvals for destructive tools, OAuth 2.1 on the MCP endpoint, rate limits, billing.
- Web app.
- Shared mode: unique indexes must include `workspace_id` (none are generated yet), tenant export, and moving a tenant between modes.
- `app_runtime` ships with a default password in `001_core.sql`; change it before any deployment.
