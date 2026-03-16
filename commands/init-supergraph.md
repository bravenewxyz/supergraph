Bootstrap the supergraph audit on this repository.

**Argument**: `$ARGUMENTS` — optional flags or repo path.

---

## Phase 1: Run zero-config analysis

```bash
supergraph --no-anim
```

The `--no-anim` flag disables the terminal animation (meant for human use only).

If `supergraph` is not installed, install it first:
```bash
curl -fsSL https://raw.githubusercontent.com/bravenewxyz/supergraph/master/install.sh | bash
```

This produces `audit/packages/<pkg>/json/map.json` for each discovered package, plus cross-package graphs.

If it fails (single-package repo with no `packages/`), identify the source directory and run:
```bash
bun ~/.local/lib/supergraph/scripts/audit-prep.ts <src-dir>
```

## Phase 2: Generate audit config

If `audit/config.json` already exists, read it and ask the user whether to regenerate or keep it. If keeping, skip to Phase 3.

### Gather signals

Read these to understand the repo:

1. **Root `package.json`** — `name` (→ project), `workspaces` (→ package locations)
2. **All `audit/packages/*/json/map.json`** — module paths, imports, exports, external deps
3. **Search for patterns**:
   - Route files: `**/*.route.ts`, `**/*.routes.ts`, `**/routes/**/*.ts`, `**/app/api/**/*.ts`
   - Schema files: grep for imports from `zod`, `drizzle-orm`
   - Redis: grep for imports from `ioredis` or `redis`
   - Hooks: `**/hooks/use*.ts`, `**/hooks/use*.tsx`
   - Controllers/services: `**/controllers/**/*.ts`, `**/services/**/*.ts`
   - Types: `**/types/**/*.ts`, `**/interfaces/**/*.ts`
4. **Internal scope**: scan `packages/*/package.json` for common `@scope/` prefix

### Build config

Generate `audit/config.json`:

```json
{
  "project": "<from package.json name or directory basename>",
  "backend": {
    "src": "<detected backend/server src dir, or primary src dir>",
    "routesDir": "<relative routes dir within src>",
    "routeFileSuffix": "<.route.ts or .ts>",
    "entryPoint": "<index.ts or main.ts or app.ts>"
  },
  "frontend": {
    "src": "<detected frontend src dir, or empty string>",
    "hooksDir": "<hooks dir relative to frontend src>",
    "rpcClients": ["<detected: honoClient, trpc, axios, fetch wrapper>"]
  },
  "workspace": {
    "packagesDir": "<packages or apps or empty>",
    "internalScope": "<@detected-scope/ or empty>"
  },
  "superflows": {
    "services": [
      {
        "service": "<service-name>",
        "pkg": "<package-name>",
        "dir": "<path to route files>",
        "filePattern": "<regex for route files>"
      }
    ],
    "hookDirs": ["<dirs with mutation hooks>"],
    "controllerDirs": ["<dirs with controllers, services, models>"]
  },
  "superschema": {
    "zodDirs": ["<dirs with Zod schema files>"],
    "drizzleFiles": ["<specific Drizzle ORM schema files>"],
    "redisModelDirs": ["<dirs with Redis models>"],
    "typeDirs": ["<dirs with TS type/interface declarations>"]
  },
  "supergraph": {
    "extAliases": [
      ["<@scope/>", "<ABBR/>"]
    ],
    "pathSegments": [
      ["<common/prefix/>", "<short/>"]
    ]
  }
}
```

**Path segment abbreviations** — scan all module paths from map.json files. Directory prefixes appearing ≥4 times get abbreviated:
- `controllers/` → `ctl/`, `components/` → `cmp/`, `utils/` → `u/`, `hooks/` → `hk/`
- `models/` → `mdl/`, `services/` → `svc/`, `config/` → `cfg/`, `types/` → `typ/`
- `schemas/` → `sch/`, `routes/` → `rt/`, `errors/` → `err/`, `middleware/` → `mw/`
- `workers/` → `wrk/`, `lib/` → `lib/`, `providers/` → `prv/`, `handlers/` → `hdl/`
- Package-specific prefixes: `$ABBR/` style (e.g., `packages/backend/src/` → `$BE/`)

**External dep aliases** — group external deps by npm scope. Scopes with ≥3 packages: `@tanstack/` → `T/`, `@hono/` → `H/`, etc.

Omit config sections where nothing was detected.

### Present to user

Show the generated config. Ask if they want to adjust anything. Write `audit/config.json` after confirmation.

## Phase 3: Full audit

Run:
```bash
supergraph --no-anim
```

This generates `audit/supergraph.txt` (the unified map), `audit/symbols.txt` (tiered symbol reference), and `audit/symbols-full.txt` (complete source bodies).

When complete, report: "Supergraph initialized — N packages, M modules."
