ALTER TABLE core.roles ADD COLUMN can_manage_access boolean NOT NULL DEFAULT false;
-- Until now schema admins also managed access, so they keep that right.
UPDATE core.roles SET can_manage_access = true WHERE can_manage_schema;
