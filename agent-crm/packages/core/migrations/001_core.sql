CREATE SCHEMA IF NOT EXISTS core;

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_runtime') THEN
    CREATE ROLE app_runtime LOGIN PASSWORD 'app_runtime' NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;

CREATE TABLE core.workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  schema_name text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE core.metadata_version (
  workspace_id uuid PRIMARY KEY REFERENCES core.workspaces(id) ON DELETE CASCADE,
  version bigint NOT NULL DEFAULT 1
);

CREATE TABLE core.principals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES core.workspaces(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('user', 'api_key', 'agent')),
  name text NOT NULL,
  email text,
  key_hash text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE core.roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES core.workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  can_manage_schema boolean NOT NULL DEFAULT false,
  all_objects_access boolean NOT NULL DEFAULT false,
  UNIQUE (workspace_id, name)
);

CREATE TABLE core.role_assignments (
  principal_id uuid NOT NULL REFERENCES core.principals(id) ON DELETE CASCADE,
  role_id uuid NOT NULL REFERENCES core.roles(id) ON DELETE CASCADE,
  PRIMARY KEY (principal_id, role_id)
);

CREATE TABLE core.object_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES core.workspaces(id) ON DELETE CASCADE,
  name_singular text NOT NULL,
  name_plural text NOT NULL,
  label text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, name_singular),
  UNIQUE (workspace_id, name_plural)
);

CREATE TABLE core.field_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES core.workspaces(id) ON DELETE CASCADE,
  object_id uuid NOT NULL REFERENCES core.object_definitions(id) ON DELETE CASCADE,
  name text NOT NULL,
  label text NOT NULL,
  type text NOT NULL CHECK (type IN
    ('text','number','numeric','boolean','date','datetime','select','multi_select','json','relation')),
  options jsonb,
  relation_object_id uuid REFERENCES core.object_definitions(id),
  active boolean NOT NULL DEFAULT true,
  UNIQUE (object_id, name)
);

CREATE TABLE core.object_permissions (
  role_id uuid NOT NULL REFERENCES core.roles(id) ON DELETE CASCADE,
  object_id uuid NOT NULL REFERENCES core.object_definitions(id) ON DELETE CASCADE,
  can_read boolean NOT NULL DEFAULT false,
  can_create boolean NOT NULL DEFAULT false,
  can_update boolean NOT NULL DEFAULT false,
  can_delete boolean NOT NULL DEFAULT false,
  PRIMARY KEY (role_id, object_id)
);

CREATE TABLE core.field_permissions (
  role_id uuid NOT NULL REFERENCES core.roles(id) ON DELETE CASCADE,
  field_id uuid NOT NULL REFERENCES core.field_definitions(id) ON DELETE CASCADE,
  can_read boolean NOT NULL DEFAULT true,
  can_write boolean NOT NULL DEFAULT true,
  PRIMARY KEY (role_id, field_id)
);

CREATE TABLE core.row_predicates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role_id uuid NOT NULL REFERENCES core.roles(id) ON DELETE CASCADE,
  object_id uuid NOT NULL REFERENCES core.object_definitions(id) ON DELETE CASCADE,
  field_name text NOT NULL,
  operator text NOT NULL CHECK (operator IN ('eq','neq','gt','gte','lt','lte','in','is_null')),
  value jsonb
);

CREATE TABLE core.skills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES core.workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL,
  content text NOT NULL,
  UNIQUE (workspace_id, name)
);

CREATE TABLE core.audit_log (
  id bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  tool text NOT NULL,
  args jsonb,
  outcome text NOT NULL,
  detail text,
  row_count integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT USAGE ON SCHEMA core TO app_runtime;
