export type Role = {
  id: string;
  name: string;
  canManageSchema: boolean;
  canManageAccess: boolean;
  allObjectsAccess: boolean;
  canBypassAuth: boolean;
  objects: { objectId: string; read: boolean; create: boolean; update: boolean; delete: boolean }[];
  fields: { fieldId: string; read: boolean; write: boolean }[];
  predicates: { id: string; objectId: string; fieldName: string; operator: string; value: unknown }[];
};

export type Member = {
  id: string;
  kind: 'user' | 'api_key' | 'agent';
  name: string;
  email: string | null;
  roleIds: string[];
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
};

export type AuditEntry = { id: number; principalId: string; tool: string; args: unknown; outcome: string; detail: string | null; rowCount: number | null; createdAt: string };

export type AuthSettings = { passwordAuthEnabled: boolean; googleAuthEnabled: boolean; passwordAuthBypassEnabled: boolean; googleAuthBypassEnabled: boolean };
