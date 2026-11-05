# agent-crm

Scaffold for a multi-tenant, agent-first CRM platform. Every business object is defined by the customer at runtime; only configuration is typed.

## Layout

- `packages/core`: migrations, schema runner, permissions, row predicates, record service, tool registry, `Session.execute`.
- `apps/server`: Hono REST API and the MCP endpoint.

## How it works

- **Tenancy.** One Postgres schema per workspace (`ws_<uuid>`). Metadata and access config live in `core`.
- **Objects.** `create_object` / `create_field` run DDL and metadata inserts in one transaction: one table per object, one column per field. Select fields use `text` plus a `CHECK`; relations are `<name>_id uuid` foreign keys.
- **RLS.** Every generated table has `FORCE ROW LEVEL SECURITY` and four policies for the `app_runtime` role. The workspace id and object id are baked into the policy; the request sets `app.workspace_id`, `app.read_objects` and `app.write_objects` with transaction-local `set_config`.
- **Roles.** Object CRUD flags, field hidden/read-only flags, and row predicates (`created_by eq $principal`). Create, update and delete are checked in the service; RLS enforces read vs write per object.
- **Agents.** An agent acting for a user (`x-on-behalf-of` header) gets the intersection of both permission sets.
- **Tools.** Per object: `find_many_<plural>`, `find_one_<singular>`, `create_one_`, `update_one_`, `delete_one_`. Schema tools need the schema permission. All calls go through `Session.execute`, which validates, authorizes and audits.
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

Create a workspace and first admin key:

```bash
curl -X POST localhost:3000/v1/bootstrap -H "x-admin-token: $ADMIN_TOKEN" \
  -H 'content-type: application/json' -d '{"workspaceName":"Acme"}'
```

## Not built yet

- Auth for human users (sessions, SSO), invites, an API for managing roles and predicates (use `core/src/access.ts` for now).
- `search` field type, many-to-many relations, field rename and type change, keyset pagination.
- Approvals for destructive tools, OAuth 2.1 on the MCP endpoint, rate limits, billing.
- Web app.
- `app_runtime` ships with a default password in `001_core.sql`; change it before any deployment.
