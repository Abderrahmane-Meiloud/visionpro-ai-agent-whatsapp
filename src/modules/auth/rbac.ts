/**
 * Server-side RBAC. Roles and their permission grants are defined here and enforced by
 * requirePermission() in the admin router. `service` is the Basic-auth bridge account — the ONE
 * credential VisionPro Marketing OS's server-side Agent AI proxy uses (app/api/agent.py in that
 * repo; never exposed to its frontend). That proxy itself gates every call behind its own
 * `agent:manage` permission before it ever reaches here, so `service` is a trusted, narrowly-used
 * backend-to-backend credential, not a public one.
 *
 * `service` is granted exactly what that one proxy's own endpoints call: conversation
 * takeover/return/reply/retry (handle_conversations), pause/resume + extra-instructions
 * (manage_settings), and knowledge/vocabulary CRUD (manage_knowledge). It deliberately still
 * EXCLUDES `manage_users` (the proxy has no staff-account code path at all) and `confirm_orders`
 * (order confirm/cancel is a human-only action on the standalone admin dashboard, by the same
 * "AI/automation never confirms an order" principle enforced elsewhere in this codebase — the
 * Marketing OS proxy does not and should not expose it).
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
  service: ['view', 'handle_conversations', 'manage_settings', 'manage_knowledge'], // the VisionPro Agent AI proxy's own trusted credential — see docstring above
};

export function grantsFor(role: string): Permission[] {
  return ROLE_PERMS[role as Role] ?? [];
}

export function hasPermission(role: string, perm: Permission): boolean {
  return grantsFor(role).includes(perm);
}
