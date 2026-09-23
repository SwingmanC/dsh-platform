# Phase 08 — Cross-Tenant Authorization Matrix

> 验证日期:2026-09-16

---

## Test Roles

| ID | Tenant | Role | Notes |
|---|---|---|---|
| AdminA | A | tenant_admin | |
| UserA1 | A | member | |
| UserA2 | A | member | |
| AdminB | B | tenant_admin | |
| UserB1 | B | member | |

---

## 1. Workspace

| Actor | Target | Expected | Rule |
|---|---|---|---|
| UserA1 | Own workspace | 200 | owner |
| UserA1 | UserA2 workspace | 404 | cross-user deny |
| UserA1 | Tenant B workspace | 404 | cross-tenant deny |
| UserA2 | UserA1 workspace | 404 | cross-user deny |
| AdminA | UserA1 workspace | 200 | tenant_admin override |

---

## 2. Session

| Actor | Target | Expected | Rule |
|---|---|---|---|
| UserA1 | Own session | 200 | owner |
| UserA1 | UserA2 session | 404 | cross-user deny |
| UserA1 | Tenant B session | 404 | cross-tenant deny |
| UserA1 | Random UUID | 404 | non-existent |
| AdminA | UserA1 session | 200 | tenant_admin |

---

## 3. Runtime

| Actor | Method | Expected | Rule |
|---|---|---|---|
| Unauthenticated | POST /api/runtimes/ensure | 401 | no sid |
| UserA1 | ensureOwn | 200 | from session |
| UserA1 | body.userId=UserA2 | 200 | body ignored, uses principal |
| UserB1 | ensure for UserA1 | 200 | body ignored |

---

## 4. Memory

| Actor | Target Visibility | Expected | Rule |
|---|---|---|---|
| UserA1 | Own personal | 200 | owner |
| UserA1 | UserA2 personal | 0 results | not owner |
| UserA1 | Tenant A shared | visible | same tenant |
| UserA1 | Tenant B shared | 0 results | cross-tenant |
| UserA2 | Tenant A shared | visible | same tenant |
| UserB1 | Tenant A shared | 0 results | cross-tenant |

---

## 5. Skill

| Actor | Target | Expected | Rule |
|---|---|---|---|
| UserA1 | Own private | visible | creator |
| UserA2 | UserA1 private | not found | not creator |
| UserA1 | Tenant A skill | visible | same tenant |
| UserB1 | Tenant A skill | not found | cross-tenant |
| UserA1 | Public skill | visible | global |
| UserB1 | Public skill | visible | global |
| UserA1 | Suspended skill | not installable | status gate |

---

## 6. Knowledge Base

| Actor | Target | Expected | Rule |
|---|---|---|---|
| UserA1 | Own personal KB | visible | creator |
| UserA2 | UserA1 personal KB | 0 results | not creator |
| UserA1 | Tenant A KB | visible | same tenant |
| UserB1 | Tenant A KB | 0 results | cross-tenant |
| UserA1 | KB document search | own + tenant | scoped |
| UserA2 | Retrieve from UserA1 KB chunks | empty | no access |

---

## 7. MCP

| Actor | Target | Expected | Rule |
|---|---|---|---|
| UserA1 | Own MCP server | visible | creator |
| UserA2 | UserA1 personal MCP | not found | not creator |
| UserA1 | Tenant A MCP | visible | same tenant |
| UserB1 | Tenant A MCP | not found | cross-tenant |
| UserA1 | Unapproved stdio MCP | cannot authorize | approval gate |

---

## Result: ALL GREEN ✅