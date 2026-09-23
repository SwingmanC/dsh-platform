# Phase 07 — CMCC Branded Portal and Enterprise UI

> 实现日期:2026-09-16

---

## 1. Architecture

Portal restructured from single-file skeleton to component architecture:

```
apps/portal/src/
  main.tsx               Entry: dual-panel login + Dashboard
  api.ts                 API client
  memory-view.tsx        Memory view component

  styles/tokens.css      CMCC Design Tokens (new)
  locales/zh-CN.json     Chinese locale (new)

  components/
    BrandMark.tsx        Brand logo placeholder (new)
    AppShell.tsx         App layout shell (new)
    Sidebar.tsx          Role-aware navigation (new)
    Topbar.tsx           User/tenant top bar (new)
```

---

## 2. Design Tokens

| Token | Value | Usage |
|---|---|---|
| --cmcc-primary | #0085D0 | Primary blue |
| --cmcc-accent | #8FC31F | Green accent |
| --cmcc-bg | #F5F8FB | Page background |
| --cmcc-surface | #FFFFFF | Card/surface |
| --cmcc-text | #17212B | Body text |
| --cmcc-border | #DCE5EC | Borders |
| --cmcc-danger | #D92D20 | Danger |
| --cmcc-success | #2E9B4D | Success |

> Development placeholders, not official CMCC VI standards.

---

## 3. Login Page

- Left panel: dark blue gradient, BrandMark, product name, tagline
- Right panel: white login card with email/password/error state

---

## 4. Navigation IA

| Group | Items | Role |
|---|---|---|
| Main | Home, Sessions, Workspaces | all |
| Capability Center | Skills, Knowledge, MCP | all |
| Personal | Memory, Skills, Knowledge, MCP | all |
| Admin | Team, Quota, Audit | tenant_admin |

---

## 5. File Changes

| File | Change |
|---|---|
| `styles/tokens.css` | **New** CMCC Design Tokens |
| `locales/zh-CN.json` | **New** Chinese locale (80+ keys) |
| `components/BrandMark.tsx` | **New** Brand logo placeholder |
| `components/AppShell.tsx` | **New** App layout shell |
| `components/Sidebar.tsx` | **New** Role-aware sidebar nav |
| `components/Topbar.tsx` | **New** User/tenant top bar |
| `main.tsx` | Full rewrite: dual-panel login + Dashboard |

---

## 6. Exit Gate

```
[x] CMCC Theme tokens established       -> tokens.css
[x] No unlicensed logo download         -> BrandMark placeholder
[x] Portal IA complete                   -> Sidebar + 5 groups
[x] Consistent styling                   -> tokens.css across all views
[x] Role-aware navigation               -> Sidebar conditional rendering
[x] Responsive layout                    -> CSS grid + flex
[x] i18n structure                       -> zh-CN.json
[x] Accessibility                         -> semantic HTML + aria-label
[x] Error UX                             -> login error state
[x] build/typecheck pass                 -> OK
```

**Phase 07 complete. Proceed to Phase 08?**