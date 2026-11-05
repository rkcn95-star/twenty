CREATE TABLE core.data_models (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  tenancy text NOT NULL CHECK (tenancy IN ('isolated', 'shared')),
  schema_name text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Existing workspaces become isolated models that reuse the workspace id and schema.
INSERT INTO core.data_models (id, name, tenancy, schema_name)
  SELECT id, name, 'isolated', schema_name FROM core.workspaces;

ALTER TABLE core.workspaces ADD COLUMN data_model_id uuid REFERENCES core.data_models(id);
UPDATE core.workspaces SET data_model_id = id;
ALTER TABLE core.workspaces ALTER COLUMN data_model_id SET NOT NULL;
ALTER TABLE core.workspaces DROP COLUMN schema_name;

ALTER TABLE core.object_definitions ADD COLUMN data_model_id uuid REFERENCES core.data_models(id) ON DELETE CASCADE;
UPDATE core.object_definitions SET data_model_id = workspace_id;
ALTER TABLE core.object_definitions ALTER COLUMN data_model_id SET NOT NULL;
ALTER TABLE core.object_definitions DROP COLUMN workspace_id;
ALTER TABLE core.object_definitions ADD UNIQUE (data_model_id, name_singular);
ALTER TABLE core.object_definitions ADD UNIQUE (data_model_id, name_plural);

ALTER TABLE core.field_definitions ADD COLUMN data_model_id uuid REFERENCES core.data_models(id) ON DELETE CASCADE;
UPDATE core.field_definitions SET data_model_id = workspace_id;
ALTER TABLE core.field_definitions ALTER COLUMN data_model_id SET NOT NULL;
ALTER TABLE core.field_definitions DROP COLUMN workspace_id;

ALTER TABLE core.metadata_version DROP CONSTRAINT metadata_version_workspace_id_fkey;
ALTER TABLE core.metadata_version RENAME COLUMN workspace_id TO data_model_id;
ALTER TABLE core.metadata_version ADD FOREIGN KEY (data_model_id) REFERENCES core.data_models(id) ON DELETE CASCADE;
