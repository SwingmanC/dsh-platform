# REWORK-02A — Effective Version Report

> 审计日期:2026-09-16
> 方法:逐层读取实际配置/锁文件/二进制/运行产物,不依据文档描述

---

## 1. 逐层版本检查

| 层 | 检查对象 | 实测值 | 备注 |
|---|---|---|---|
| L1 | 根 `package.json` `engines` | `node: >=22` | 无 `packageManager` 字段 |
| L1 | 根 `package.json` dsh 依赖 | 无 | 平台不直接依赖 dsh |
| L2 | `pnpm-lock.yaml` 中 `@deepseek-ai/*` | 全部 `0.1.1-rc.2`(cordis `4.0.2`) | 见下 |
| L3 | `packages/dsh-bridge` deps | `@deepseek-ai/*@0.1.1-rc.2`,`cordis@4.0.2` | |
| L3 | `packages/dsh-bridge` peer | `@deepseek-ai/cordis@*` | 通配,不锁定 |
| L3 | `packages/sdk-driver` peer | **`@deepseek-ai/dsh-sdk-client@0.1.2-rc.1`**、`@deepseek-ai/dsh-sdk-protocol@0.1.2-rc.1` | **漂移源** |
| L3 | `packages/{skill-plaza,knowledge-base,connector}` | 无 `@deepseek-ai/*` 依赖 | 纯手写 bundle |
| L4 | `dsh` 可执行文件 | `F:\nvm\nodejs_new\dsh.ps1` → `node_modules/@deepseek-ai/dsh/lib/bin.js` | |
| L4 | `dsh --version` | **`0.1.1-rc.2`** | |
| L4 | 全局安装 | `@deepseek-ai/dsh@0.1.1-rc.2` | `npm root -g` |
| L5 | Supervisor spawn | `config.dsh.bin = str('DSH_BIN','dsh')` → PATH 上的 `dsh.ps1` | 无版本 pin |
| L6 | 每用户 `profiles/web/package.json` | `dsh-profile-web`,bundles `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app` | 无版本号 |
| L7 | 每用户 `node_modules/@deepseek-ai/*` | **空**(无本地安装) | 复用全局 dsh |
| L8 | `window.__DSH_BOOT__` entries | 平台 4 插件 rev 已出现 | 见 §3 |

### pnpm-lock 中 @deepseek-ai 版本(唯一值)

```
@deepseek-ai/cordis@4.0.2
@deepseek-ai/cosmokit@1.8.3
@deepseek-ai/dsh-api-remotes@0.1.1-rc.2
@deepseek-ai/dsh-client-runtime@0.1.1-rc.2
@deepseek-ai/dsh-client-ui-conversation@0.1.1-rc.2
@deepseek-ai/dsh-client-ui-sidebar@0.1.1-rc.2
@deepseek-ai/dsh-client-ui-slots@0.1.1-rc.2
@deepseek-ai/dsh-client-ui-workspace@0.1.1-rc.2
@deepseek-ai/dsh-session@0.1.1-rc.2
@deepseek-ai/dsh-typert-protocol@0.1.1-rc.2
@deepseek-ai/schemastery@3.18.2
```

---

## 2. 四个版本结论

| 结论项 | 值 | 依据 |
|---|---|---|
| **BUILD-TIME VERSION** | **混合**:`sdk-driver` 声明 `0.1.2-rc.1`;`dsh-bridge` 锁定 `0.1.1-rc.2`;根与其余包无 dsh 依赖 | L1–L3 |
| **SUPERVISOR VERSION** | **`0.1.1-rc.2`** | L5(`dsh` → 全局 `0.1.1-rc.2`) |
| **RUNTIME VERSION** | **`0.1.1-rc.2`** | L4/L6/L7(每用户 home 复用全局 dsh) |
| **CLIENT VERSION** | **`0.1.1-rc.2`** | L8(boot 清单的官方 bundle 来自全局 dsh 0.1.1-rc.2) |

**漂移判定:**
- 项目元数据(`sdk-driver` peer)声称 `0.1.2-rc.1`,但**从未安装、从未运行**该版本。
- `dsh-bridge` 的 `0.1.1-rc.2` 依赖与实际运行版本一致。
- 因此:**唯一的真实漂移是 `sdk-driver` 的 peer 声明(0.1.2-rc.1)与实际运行(0.1.1-rc.2)不一致。** 由于 `sdk-driver` 全部方法 `throw TODO`,该漂移当前无运行时影响,但会误导后续开发。

---

## 3. `__DSH_BOOT__` 平台插件条目(实测)

从 `GET /`(Host: `localhost:8080`)提取:

```json
{"id":"@dsh-platform/dsh-bridge","url":"/plugins/@dsh-platform/dsh-bridge/client.js?rev=e7611ec9f2b3","inject":[]}
{"id":"@dsh-platform/dsh-skill-plaza","url":"/plugins/@dsh-platform/dsh-skill-plaza/client.js?rev=eeaecf4d4c1c","inject":[]}
{"id":"@dsh-platform/dsh-knowledge-base","url":"/plugins/@dsh-platform/dsh-knowledge-base/client.js?rev=750c1e1ac76f","inject":[]}
{"id":"@dsh-platform/dsh-connector","url":"/plugins/@dsh-platform/dsh-connector/client.js?rev=ad028f72f61b","inject":[]}
```

- 四个平台 client bundle 均被服务(HTTP 200)。
- `inject: []` 表示无跨插件依赖。
- 官方条目中存在 `@deepseek-ai/dsh-client-ui-layout`、`...ui-sidebar`、`...ui-conversation`、`...ui-workspace`、`...ui-theme`、`...ui-settings` 等。

---

## 4. 目标版本事实(0.1.5-rc.2)

| 项 | 值 |
|---|---|
| npm 已发布 | ✅ `@deepseek-ai/dsh@0.1.5-rc.2` |
| 可用版本链 | … `0.1.2-rc.1`, `0.1.3-alpha.2`, `0.1.5-alpha.1/2`, **`0.1.5-rc.1`**, **`0.1.5-rc.2`**, `0.1.6-alpha.1` |
| `engines.node`(monorepo) | `^22.19.0 \|\| >=24.0.0` |
| `packageManager`(monorepo) | `pnpm@11.7.0` |
| `@deepseek-ai/dsh@0.1.5-rc.2` deps | `@deepseek-ai/dsh-mcp-client@^0.1.5-rc.2` 等,全部 `^0.1.5-rc.2`;`@deepseek-ai/cordis@^4.0.2` |

### 本机环境对照

| 项 | 本机 | 目标要求 | 结论 |
|---|---|---|---|
| Node | `v24.0.0` | `^22.19.0 \|\| >=24.0.0` | ✅ 满足(`>=24.0.0`) |
| pnpm | `12.4.1` | 官方用 `11.7.0` 开发 | ⚠️ 本机更高,需验证兼容性 |
| TypeScript | `^5.6.0`(平台) | `^6.0.3`(官方 dev) | ⚠️ 官方用 TS6;平台不受影响(平台不编译 dsh) |

---

## 5. 关键结论

1. **真实运行版本是 `0.1.1-rc.2`**,与 REWORK-01 实测一致。
2. **`0.1.2-rc.1` 只存在于 `sdk-driver` 的 peer 声明中,是历史残留**,不构成实际运行版本。
3. 每用户 Runtime 不安装本地 dsh,完全复用全局 `0.1.1-rc.2`。
4. `0.1.5-rc.2` 已在 npm 发布,Node 引擎本机满足。
5. 升级影响面清晰:升级全局 dsh 版本即可改变 RUNTIME/CLIENT;平台侧需同步更新 `dsh-bridge` 依赖与插件契约。
