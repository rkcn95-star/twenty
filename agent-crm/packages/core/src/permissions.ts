import type pg from 'pg';
import type { Metadata, Principal } from './types.js';

export type ObjectAccess = { read: boolean; create: boolean; update: boolean; delete: boolean };
export type Predicate = { fieldName: string; operator: string; value: unknown };
// null means unrestricted; otherwise OR of AND-groups
export type PredicateGroups = Predicate[][] | null;

export type PermissionSet = {
  canManageSchema: boolean;
  canManageAccess: boolean;
  objects: Map<string, ObjectAccess>;
  hiddenFieldIds: Set<string>;
  readOnlyFieldIds: Set<string>;
  predicates: Map<string, PredicateGroups>;
};

type RoleGrants = {
  id: string;
  canManageSchema: boolean;
  canManageAccess: boolean;
  allObjectsAccess: boolean;
  objects: Map<string, ObjectAccess>;
  fields: Map<string, { read: boolean; write: boolean }>;
  predicates: Map<string, Predicate[]>;
};

const NO_ACCESS: ObjectAccess = { read: false, create: false, update: false, delete: false };
const FULL_ACCESS: ObjectAccess = { read: true, create: true, update: true, delete: true };

const loadRoleGrants = async (admin: pg.Pool, principalId: string): Promise<RoleGrants[]> => {
  const roles = (
    await admin.query(
      `SELECT r.id, r.can_manage_schema, r.can_manage_access, r.all_objects_access FROM core.roles r
       JOIN core.role_assignments ra ON ra.role_id = r.id WHERE ra.principal_id = $1`,
      [principalId],
    )
  ).rows;
  const roleIds = roles.map((role) => role.id);
  const [objectRows, fieldRows, predicateRows] = await Promise.all([
    admin.query('SELECT * FROM core.object_permissions WHERE role_id = ANY($1)', [roleIds]),
    admin.query('SELECT * FROM core.field_permissions WHERE role_id = ANY($1)', [roleIds]),
    admin.query('SELECT * FROM core.row_predicates WHERE role_id = ANY($1)', [roleIds]),
  ]);
  return roles.map((role) => {
    const grants: RoleGrants = {
      id: role.id,
      canManageSchema: role.can_manage_schema,
      canManageAccess: role.can_manage_access,
      allObjectsAccess: role.all_objects_access,
      objects: new Map(),
      fields: new Map(),
      predicates: new Map(),
    };
    for (const row of objectRows.rows.filter((r) => r.role_id === role.id)) {
      grants.objects.set(row.object_id, { read: row.can_read, create: row.can_create, update: row.can_update, delete: row.can_delete });
    }
    for (const row of fieldRows.rows.filter((r) => r.role_id === role.id)) {
      grants.fields.set(row.field_id, { read: row.can_read, write: row.can_write });
    }
    for (const row of predicateRows.rows.filter((r) => r.role_id === role.id)) {
      const list = grants.predicates.get(row.object_id) ?? [];
      list.push({ fieldName: row.field_name, operator: row.operator, value: row.value });
      grants.predicates.set(row.object_id, list);
    }
    return grants;
  });
};

const accessOf = (role: RoleGrants, objectId: string): ObjectAccess =>
  role.allObjectsAccess ? FULL_ACCESS : (role.objects.get(objectId) ?? NO_ACCESS);

const unionOfRoles = (roles: RoleGrants[], metadata: Metadata): PermissionSet => {
  const set: PermissionSet = {
    canManageSchema: roles.some((role) => role.canManageSchema),
    canManageAccess: roles.some((role) => role.canManageAccess),
    objects: new Map(),
    hiddenFieldIds: new Set(),
    readOnlyFieldIds: new Set(),
    predicates: new Map(),
  };
  for (const object of metadata.objects) {
    const access = { ...NO_ACCESS };
    for (const role of roles) {
      const roleAccess = accessOf(role, object.id);
      access.read ||= roleAccess.read;
      access.create ||= roleAccess.create;
      access.update ||= roleAccess.update;
      access.delete ||= roleAccess.delete;
    }
    set.objects.set(object.id, access);

    const readers = roles.filter((role) => accessOf(role, object.id).read);
    if (readers.length === 0) continue;

    for (const field of object.fields) {
      const hiddenEverywhere = readers.every((role) => !role.allObjectsAccess && role.fields.get(field.id)?.read === false);
      const readOnlyEverywhere = readers.every((role) => !role.allObjectsAccess && role.fields.get(field.id)?.write === false);
      if (hiddenEverywhere) set.hiddenFieldIds.add(field.id);
      if (readOnlyEverywhere) set.readOnlyFieldIds.add(field.id);
    }

    const unrestricted = readers.some((role) => role.allObjectsAccess || !role.predicates.get(object.id)?.length);
    set.predicates.set(object.id, unrestricted ? null : readers.map((role) => role.predicates.get(object.id) ?? []));
  }
  return set;
};

const andPredicates = (left: PredicateGroups, right: PredicateGroups): PredicateGroups => {
  if (left === null) return right;
  if (right === null) return left;
  return left.flatMap((leftGroup) => right.map((rightGroup) => [...leftGroup, ...rightGroup]));
};

const intersect = (first: PermissionSet, second: PermissionSet): PermissionSet => {
  const objects = new Map<string, ObjectAccess>();
  for (const [objectId, a] of first.objects) {
    const b = second.objects.get(objectId) ?? NO_ACCESS;
    objects.set(objectId, { read: a.read && b.read, create: a.create && b.create, update: a.update && b.update, delete: a.delete && b.delete });
  }
  const predicates = new Map<string, PredicateGroups>();
  for (const objectId of objects.keys()) {
    predicates.set(objectId, andPredicates(first.predicates.get(objectId) ?? null, second.predicates.get(objectId) ?? null));
  }
  return {
    canManageSchema: first.canManageSchema && second.canManageSchema,
    canManageAccess: first.canManageAccess && second.canManageAccess,
    objects,
    hiddenFieldIds: new Set([...first.hiddenFieldIds, ...second.hiddenFieldIds]),
    readOnlyFieldIds: new Set([...first.readOnlyFieldIds, ...second.readOnlyFieldIds]),
    predicates,
  };
};

// An agent acting for a user gets the intersection of both permission sets, so delegation can only narrow access.
export const resolvePermissions = async (
  admin: pg.Pool,
  principal: Principal,
  metadata: Metadata,
  onBehalfOf?: Principal,
): Promise<PermissionSet> => {
  const own = unionOfRoles(await loadRoleGrants(admin, principal.id), metadata);
  if (!onBehalfOf) return own;
  return intersect(own, unionOfRoles(await loadRoleGrants(admin, onBehalfOf.id), metadata));
};
