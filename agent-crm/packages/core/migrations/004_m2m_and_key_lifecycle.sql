ALTER TABLE core.field_definitions DROP CONSTRAINT field_definitions_type_check;
ALTER TABLE core.field_definitions ADD CONSTRAINT field_definitions_type_check CHECK (type IN
  ('text','number','numeric','boolean','date','datetime','select','multi_select','json','relation','many_to_many'));

ALTER TABLE core.principals
  ADD COLUMN expires_at timestamptz,
  ADD COLUMN revoked_at timestamptz,
  ADD COLUMN last_used_at timestamptz;
