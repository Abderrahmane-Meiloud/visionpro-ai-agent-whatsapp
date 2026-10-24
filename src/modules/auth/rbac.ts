/**
 * Server-side RBAC. Roles and their permission grants are defined here and enforced by
 * requirePermission() in the admin router. `service` is the Basic-auth bridge account: it is
 * read-only (view) and can never reach a mutating or human-only endpoint.
 */
export type Role = 'admin' | 'agent' | 'viewer' | 'service';
export const PERMISSIONS = ['view', 'handle_conversations', 'manage_knowledge', 'manage_settings', 'manage_users', 'confirm_orders'] as const;
export type Permission = (typeof PERMISSIONS)[number];

// `confirm_orders` = authorized staff who may CONFIRM/CANCEL business orders (the AI never can).
// Granted to admin by default; an owner can extend it to agents later if desired.
export const ROLE_PERMS: Record<Role, Permission[]> = {
  admin: ['view', 'handle_conversations', 'manage_knowledge', 'manage_settings', 'manage_users', 'confirm_orders'],
  agent: ['view', 'handle_conversations'],
  viewer: ['view'],
  service: ['view'], // bridge: read-only, no additional privileges
};

export function grantsFor(role: string): Permission[] {
  return ROLE_PERMS[role as Role] ?? [];
}

export function hasPermission(role: string, perm: Permission): boolean {
  return grantsFor(role).includes(perm);
}
