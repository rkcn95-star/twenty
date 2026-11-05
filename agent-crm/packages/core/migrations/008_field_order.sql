-- Fields keep the order they were created in; existing fields fall back to name order.
ALTER TABLE core.field_definitions ADD COLUMN created_at timestamptz NOT NULL DEFAULT clock_timestamp();
