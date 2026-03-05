#!/usr/bin/env bun

/**
 * Build script for supergraph standalone binary.
 *
 * Copies native .node files next to the entry point and injects explicit
 * static require() calls so Bun's --compile can find and embed them.
 * Restores everything after build.
 *
 * Usage:
 *   bun run scripts/build.ts [--target darwin-arm64|darwin-x64|linux-x64]
 */

import { execSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  mkdirSync,
  unlinkSync,
  readdirSync,
} from "node:fs";
import { join, resolve, relative } from "node:path";

// ── Target resolution ──────────────────────────────────────────────────────

type Target = "darwin-arm64" | "darwin-x64" | "linux-x64";

const TARGET_MAP: Record<
  Target,
  {
    dprintNode: string;
    astGrepNapiPkg: string;
    astGrepNapiNodeFile: string;
    langGoPrebuild: string;
  }
> = {
  "darwin-arm64": {
    dprintNode: "dprint-node.darwin-arm64.node",
    astGrepNapiPkg: "@ast-grep/napi-darwin-arm64",
    astGrepNapiNodeFile: "ast-grep-napi.darwin-arm64.node",
    langGoPrebuild: "prebuild-macOS-ARM64/parser.so",
  },
  "darwin-x64": {
    dprintNode: "dprint-node.darwin-x64.node",
    astGrepNapiPkg: "@ast-grep/napi-darwin-x64",
    astGrepNapiNodeFile: "ast-grep-napi.darwin-x64.node",
    langGoPrebuild: "prebuild-macOS-X64/parser.so",
  },
  "linux-x64": {
    dprintNode: "dprint-node.linux-x64-gnu.node",
    astGrepNapiPkg: "@ast-grep/napi-linux-x64-gnu",
    astGrepNapiNodeFile: "ast-grep-napi.linux-x64-gnu.node",
    langGoPrebuild: "prebuild-Linux-X64/parser.so",
  },
};

function detectHostTarget(): Target {
  const platform = process.platform;
  const arch = process.arch;
  if (platform === "darwin" && arch === "arm64") return "darwin-arm64";
  if (platform === "darwin" && arch === "x64") return "darwin-x64";
  if (platform === "linux" && arch === "x64") return "linux-x64";
  throw new Error(`Unsupported host platform: ${platform}-${arch}`);
}

function parseTarget(): Target {
  const idx = process.argv.indexOf("--target");
  if (idx >= 0 && process.argv[idx + 1]) {
    const t = process.argv[idx + 1] as Target;
    if (!TARGET_MAP[t])
      throw new Error(
        `Unknown target: ${t}. Valid: ${Object.keys(TARGET_MAP).join(", ")}`,
      );
    return t;
  }
  return detectHostTarget();
}

// ── Path resolution ────────────────────────────────────────────────────────

const ROOT = resolve(import.meta.dir, "..");
const SRC_DIR = join(ROOT, "src");
const BUN_CACHE = join(ROOT, "node_modules", ".bun");

function findPackageDir(pattern: string): string {
  const entries = readdirSync(BUN_CACHE);
  for (const entry of entries) {
    if (entry.startsWith(pattern)) {
      const parts = pattern.split("+");
      let pkgPath: string;
      if (parts.length >= 2) {
        // Scoped: @scope+name@ver → @scope/name
        const scopedName = pattern.replace("+", "/").replace(/@[^/]*$/, "");
        pkgPath = join(BUN_CACHE, entry, "node_modules", scopedName);
      } else {
        const name = pattern.replace(/@[^@]*$/, "");
        pkgPath = join(BUN_CACHE, entry, "node_modules", name);
      }
      if (existsSync(pkgPath)) return pkgPath;
    }
  }
  throw new Error(`Could not find package matching "${pattern}" in ${BUN_CACHE}`);
}

function findBunCacheEntry(pkgPrefix: string): string {
  const entries = readdirSync(BUN_CACHE);
  for (const entry of entries) {
    if (entry.startsWith(pkgPrefix)) {
      return join(BUN_CACHE, entry);
    }
  }
  throw new Error(`Could not find cache entry matching "${pkgPrefix}" in ${BUN_CACHE}`);
}

// ── Patching helpers ───────────────────────────────────────────────────────

interface PatchedFile {
  path: string;
  original: string;
}

const patchedFiles: PatchedFile[] = [];
const copiedFiles: string[] = [];

function patchFile(filePath: string, newContent: string): void {
  const original = readFileSync(filePath, "utf-8");
  patchedFiles.push({ path: filePath, original });
  writeFileSync(filePath, newContent);
  console.log(`  patched: ${filePath}`);
}

function copyNativeFile(src: string, dest: string): void {
  copyFileSync(src, dest);
  copiedFiles.push(dest);
  console.log(`  copied:  ${src}\n        → ${dest}`);
}

function restoreAll(): void {
  for (const { path, original } of patchedFiles) {
    writeFileSync(path, original);
    console.log(`  restored: ${path}`);
  }
  patchedFiles.length = 0;

  for (const f of copiedFiles) {
    if (existsSync(f)) {
      unlinkSync(f);
      console.log(`  removed:  ${f}`);
    }
  }
  copiedFiles.length = 0;
}

// ── Main build ─────────────────────────────────────────────────────────────

async function build() {
  const target = parseTarget();
  const config = TARGET_MAP[target];
  console.log(`\nBuilding supergraph for ${target}\n`);

  // 1. Resolve package paths in .bun cache
  const dprintDir = findPackageDir("dprint-node@");
  const napiDir = findPackageDir("@ast-grep+napi@");
  const langGoDir = findPackageDir("@ast-grep+lang-go@");

  // Find platform-specific napi package (e.g. @ast-grep/napi-darwin-arm64)
  const napiPkgName = config.astGrepNapiPkg;
  let napiPlatformDir: string;
  try {
    // Pattern like "ast-grep+napi-darwin-arm64@" (stripped leading @)
    napiPlatformDir = findPackageDir(
      napiPkgName.replace("@", "").replace("/", "+") + "@",
    );
  } catch {
    // Alternate: bun cache uses @scope+name@ver format
    const altPrefix = napiPkgName.replace("@", "").replace("/", "+");
    const cacheDir = findBunCacheEntry(`@${altPrefix}@`);
    napiPlatformDir = join(cacheDir, "node_modules", napiPkgName);
    if (!existsSync(napiPlatformDir)) {
      throw new Error(`Could not find platform napi package: ${napiPkgName}`);
    }
  }

  console.log("Resolved paths:");
  console.log(`  dprint-node:     ${dprintDir}`);
  console.log(`  ast-grep/napi:   ${napiDir}`);
  console.log(`  napi platform:   ${napiPlatformDir}`);
  console.log(`  lang-go:         ${langGoDir}`);
  console.log();

  // 2. Verify .node files exist
  const dprintNodePath = join(dprintDir, config.dprintNode);
  const napiNodePath = join(napiPlatformDir, config.astGrepNapiNodeFile);

  if (!existsSync(dprintNodePath)) {
    throw new Error(`dprint .node file not found: ${dprintNodePath}`);
  }
  if (!existsSync(napiNodePath)) {
    throw new Error(`napi .node file not found: ${napiNodePath}`);
  }

  // 3. Copy .node files next to src/index.ts so Bun definitely finds them
  //    (Bun's --compile needs static require paths it can resolve from the entry)
  console.log("Staging native .node files next to entry point...");

  const dprintNodeDest = join(SRC_DIR, config.dprintNode);
  const napiNodeDest = join(SRC_DIR, config.astGrepNapiNodeFile);

  copyNativeFile(dprintNodePath, dprintNodeDest);
  copyNativeFile(napiNodePath, napiNodeDest);

  // Also copy .node into napi package dir (for patched loader)
  const napiNodeInPkgDest = join(napiDir, config.astGrepNapiNodeFile);
  copyNativeFile(napiNodePath, napiNodeInPkgDest);

  // 4. Patch src/index.ts to add explicit static require() calls at the top.
  //    This is the key trick: Bun's compiler analyzes the entry point and
  //    embeds any .node files referenced by static require() paths.
  console.log("\nPatching source files...");

  const entryPath = join(SRC_DIR, "index.ts");
  const entryOriginal = readFileSync(entryPath, "utf-8");
  patchedFiles.push({ path: entryPath, original: entryOriginal });

  const nativePrelude = [
    `// ── [BUILD] Force Bun to embed native .node files ──────────────────`,
    `// These require() calls are injected by scripts/build.ts at build time.`,
    `// Bun's --compile only embeds .node files with static require paths`,
    `// visible from the entry point.`,
    `const __dprint_native = require("./${config.dprintNode}");`,
    `const __napi_native = require("./${config.astGrepNapiNodeFile}");`,
    `// ── [/BUILD] ─────────────────────────────────────────────────────────`,
    ``,
  ].join("\n");

  // Insert after the shebang line
  const patchedEntry = entryOriginal.replace(
    "#!/usr/bin/env bun\n",
    `#!/usr/bin/env bun\n${nativePrelude}`,
  );
  writeFileSync(entryPath, patchedEntry);
  console.log(`  patched: ${entryPath} (added native require prelude)`);

  // 5. Patch dprint-node loader: replace dynamic require with static
  const dprintIndexPath = join(dprintDir, "index.js");
  patchFile(
    dprintIndexPath,
    `module.exports = require('./${config.dprintNode}');\n`,
  );

  // 6. Patch ast-grep/napi loader: replace complex platform detection
  const napiIndexPath = join(napiDir, "index.js");
  patchFile(
    napiIndexPath,
    `const { createRequire } = require('node:module');\n` +
      `require = createRequire(__filename);\n` +
      `const nativeBinding = require('./${config.astGrepNapiNodeFile}');\n` +
      `module.exports = nativeBinding;\n`,
  );

  // 7. Patch ast-grep/lang-go: static prebuild path with env override
  const langGoIndexPath = join(langGoDir, "index.js");
  const langGoPrebuildPath = join(langGoDir, "prebuilds", config.langGoPrebuild);

  if (!existsSync(langGoPrebuildPath)) {
    console.warn(`  warning: lang-go prebuild not found: ${langGoPrebuildPath}`);
    console.warn(`  Go analysis will not work in the standalone binary`);
  }

  patchFile(
    langGoIndexPath,
    `const path = require('node:path');\n` +
      `let libPath;\n` +
      `if (process.env.AST_GREP_LANG_GO_PATH) {\n` +
      `  libPath = process.env.AST_GREP_LANG_GO_PATH;\n` +
      `} else {\n` +
      `  libPath = path.join(__dirname, 'prebuilds', '${config.langGoPrebuild}');\n` +
      `}\n` +
      `module.exports = {\n` +
      `  get libraryPath() { return libPath; },\n` +
      `  extensions: ['go'],\n` +
      `  languageSymbol: 'tree_sitter_go',\n` +
      `  expandoChar: 'µ',\n` +
      `};\n`,
  );

  console.log();

  // 8. Run bun build --compile
  console.log("Building standalone binary...");
  const bunTarget =
    target === detectHostTarget() ? "" : ` --target=bun-${target}`;
  const cmd = `bun build --compile --minify${bunTarget} src/index.ts --outfile supergraph`;
  console.log(`  $ ${cmd}`);

  try {
    execSync(cmd, { cwd: ROOT, stdio: "inherit" });
  } finally {
    // 9. Restore all patched files and remove copied .node files
    console.log("\nRestoring patched files...");
    restoreAll();
  }

  // 10. Copy lang-go .so to lib/ output directory
  const libDir = join(ROOT, "lib");
  mkdirSync(libDir, { recursive: true });

  if (existsSync(langGoPrebuildPath)) {
    const soDestPath = join(libDir, "lang-go-parser.so");
    copyFileSync(langGoPrebuildPath, soDestPath);
    console.log(`\nCopied lang-go parser: ${soDestPath}`);
  }

  console.log(`\nBuild complete!`);
  console.log(`  binary: ./supergraph`);
  console.log(`  lib:    ./lib/`);
  console.log(
    `\nTo test:\n  mkdir -p /tmp/test/lib && cp supergraph /tmp/test/ && cp lib/* /tmp/test/lib/\n  cd /tmp/test && ./supergraph --help`,
  );
}

build().catch((err) => {
  console.error("\nBuild failed:", err);
  if (patchedFiles.length > 0 || copiedFiles.length > 0) {
    console.log("Restoring patched files after failure...");
    restoreAll();
  }
  process.exit(1);
});
