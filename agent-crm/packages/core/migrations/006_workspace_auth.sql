ALTER TABLE core.workspaces
  ADD COLUMN password_auth_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN google_auth_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN password_auth_bypass_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN google_auth_bypass_enabled boolean NOT NULL DEFAULT false;

ALTER TABLE core.roles ADD COLUMN can_bypass_auth boolean NOT NULL DEFAULT false;

-- A user principal is the membership of one global auth user in one workspace.
ALTER TABLE core.principals ADD COLUMN auth_user_id text REFERENCES core."user"(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX principals_workspace_auth_user ON core.principals (workspace_id, auth_user_id) WHERE auth_user_id IS NOT NULL;

CREATE TABLE core.invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES core.workspaces(id) ON DELETE CASCADE,
  email text NOT NULL,
  role_ids uuid[] NOT NULL,
  token_hash text NOT NULL UNIQUE,
  invited_by uuid,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
