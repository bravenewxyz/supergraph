import { join } from "node:path";

export type AuditConfig = {
  project?: string;
  backend?: {
    src?: string;
    routesDir?: string;
    v1Dir?: string;
    routeFileSuffix?: string;
    entryPoint?: string;
    routeImportPrefixes?: string[];
  };
  frontend?: {
    src?: string;
    hooksDir?: string;
    optionsImportPattern?: string;
    rpcClients?: string[];
  };
  schemas?: {
    commonDir?: string;
    extraKnown?: string[];
  };
  workspace?: {
    packagesDir?: string;
    internalScope?: string;
  };
  docs?: {
    architectureFile?: string;
    generateCommand?: string;
    contextFile?: string;
    driftKeyFiles?: string[];
  };
  superschema?: {
    /** Directories containing Zod schema files (.ts) to catalog. */
    zodDirs?: string[];
    /** Drizzle ORM schema file paths for PostgreSQL table extraction. */
    drizzleFiles?: string[];
    /** Directories with Redis model files (for key-pattern inference). */
    redisModelDirs?: string[];
    /** Directories to scan for TypeScript type/interface declarations. */
    typeDirs?: string[];
  };
  supergraph?: {
    /** External dependency aliases for the map view. Each entry is [from, to].
     *  Matched longest-first; trailing `/`, `:`, or `-` acts as a prefix match. */
    extAliases?: [string, string][];
    /** Path segment compressions for module paths. Each entry is [from, to].
     *  Applied in order via substring replacement after stripping the `src/` prefix. */
    pathSegments?: [string, string][];
  };
};

const DEFAULTS: Required<AuditConfig> = {
  project: "",
  backend: {
    src: "src",
    routesDir: "routes",
    v1Dir: "v1",
    routeFileSuffix: ".route.ts",
    entryPoint: "index.ts",
    routeImportPrefixes: [],
  },
  frontend: {
    src: "",
    hooksDir: "hooks",
    optionsImportPattern: "",
    rpcClients: [],
  },
  schemas: {
    commonDir: "",
    extraKnown: [],
  },
  workspace: {
    packagesDir: "packages",
    internalScope: "",
  },
  docs: {
    architectureFile: "ARCHITECTURE_REFERENCE.md",
    generateCommand: "",
    contextFile: "CLAUDE.md",
    driftKeyFiles: [],
  },
  superschema: {
    zodDirs: [],
    drizzleFiles: [],
    redisModelDirs: [],
    typeDirs: [],
  },
  supergraph: {
    extAliases: [],
    pathSegments: [],
  },
};

export async function loadConfig(
  cwd = process.cwd(),
): Promise<Required<AuditConfig>> {
  const configPath = join(cwd, "audit", "config.json");
  let raw: AuditConfig = {};
  try {
    raw = JSON.parse(await Bun.file(configPath).text());
  } catch {
    // config is optional; fall back to defaults
  }

  return {
    project: raw.project ?? DEFAULTS.project,
    backend: { ...DEFAULTS.backend, ...raw.backend },
    frontend: { ...DEFAULTS.frontend, ...raw.frontend },
    schemas: { ...DEFAULTS.schemas, ...raw.schemas },
    workspace: { ...DEFAULTS.workspace, ...raw.workspace },
    docs: { ...DEFAULTS.docs, ...raw.docs },
    superschema: { ...DEFAULTS.superschema, ...raw.superschema },
    supergraph: { ...DEFAULTS.supergraph, ...raw.supergraph },
  };
}
