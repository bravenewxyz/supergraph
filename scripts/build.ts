#!/usr/bin/env bun

/**
 * Build script for supergraph standalone binary.
 *
 * Patches native module loaders in node_modules so that `bun build --compile`
 * can statically resolve and embed .node files. Restores originals after build.
 *
 * Usage:
 *   bun run scripts/build.ts [--target darwin-arm64|darwin-x64|linux-x64]
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

// ── Target resolution ──────────────────────────────────────────────────────

type Target = "darwin-arm64" | "darwin-x64" | "linux-x64";

const TARGET_MAP: Record<Target, {
  dprintNode: string;
  astGrepNapiPkg: string;
  astGrepNapiNodeFile: string;
  langGoPrebuild: string;
}> = {
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
    if (!TARGET_MAP[t]) throw new Error(`Unknown target: ${t}. Valid: ${Object.keys(TARGET_MAP).join(", ")}`);
    return t;
  }
  return detectHostTarget();
}

// ── Path resolution ────────────────────────────────────────────────────────

const ROOT = resolve(import.meta.dir, "..");
const BUN_CACHE = join(ROOT, "node_modules", ".bun");

function findPackageDir(pattern: string): string {
  // Scan .bun cache for a directory matching the pattern
  const { readdirSync } = require("node:fs");
  const entries = readdirSync(BUN_CACHE) as string[];
  for (const entry of entries) {
    if (entry.startsWith(pattern)) {
      // The actual package is nested inside node_modules/<scope>/<name>
      const parts = pattern.split("+");
      let pkgPath: string;
      if (parts.length === 2) {
        // Scoped package: @scope+name → @scope/name
        pkgPath = join(BUN_CACHE, entry, "node_modules", `@${parts[0].slice(0)}`, parts[1].split("@")[0]!);
        // Actually the pattern is like "@ast-grep+napi@0.40.5" so let's parse properly
        const scopedName = pattern.replace("+", "/").replace(/@[^/]*$/, "");
        pkgPath = join(BUN_CACHE, entry, "node_modules", scopedName);
      } else {
        // Non-scoped: name@version
        const name = pattern.replace(/@[^@]*$/, "");
        pkgPath = join(BUN_CACHE, entry, "node_modules", name);
      }
      if (existsSync(pkgPath)) return pkgPath;
    }
  }
  throw new Error(`Could not find package matching "${pattern}" in ${BUN_CACHE}`);
}

function findBunCacheDir(pkgPrefix: string): string {
  const { readdirSync } = require("node:fs");
  const entries = readdirSync(BUN_CACHE) as string[];
  for (const entry of entries) {
    if (entry.startsWith(pkgPrefix)) {
      return join(BUN_CACHE, entry);
    }
  }
  throw new Error(`Could not find cache dir matching "${pkgPrefix}" in ${BUN_CACHE}`);
}

// ── Patching helpers ───────────────────────────────────────────────────────

interface PatchedFile {
  path: string;
  original: string;
}

const patchedFiles: PatchedFile[] = [];

function patchFile(filePath: string, newContent: string): void {
  const original = readFileSync(filePath, "utf-8");
  patchedFiles.push({ path: filePath, original });
  writeFileSync(filePath, newContent);
  console.log(`  patched: ${filePath}`);
}

function restoreAll(): void {
  for (const { path, original } of patchedFiles) {
    writeFileSync(path, original);
    console.log(`  restored: ${path}`);
  }
  patchedFiles.length = 0;
}

// ── Main build ─────────────────────────────────────────────────────────────

async function build() {
  const target = parseTarget();
  const config = TARGET_MAP[target];
  console.log(`\nBuilding supergraph for ${target}\n`);

  // 1. Resolve package paths
  const dprintDir = findPackageDir("dprint-node@");
  const napiDir = findPackageDir("@ast-grep+napi@");
  const langGoDir = findPackageDir("@ast-grep+lang-go@");

  // Find the platform-specific napi package
  const napiPkgName = config.astGrepNapiPkg; // e.g. "@ast-grep/napi-darwin-arm64"
  const napiPkgPrefix = napiPkgName.replace("@", "").replace("/", "+"); // "ast-grep+napi-darwin-arm64"
  // Actually for bun cache it's stored as @ast-grep+napi-darwin-arm64@version
  const napiPlatformCachePrefix = napiPkgName.replace("/", "+").replace("@", "") + "@";
  // Wait - let me just scan for it properly
  const napiPlatformPrefix = napiPkgName.replace("/", "+") + "@";

  let napiPlatformDir: string;
  try {
    napiPlatformDir = findPackageDir(napiPlatformPrefix.replace("@", ""));
  } catch {
    // Try alternate pattern - bun cache uses @scope+name format with @ prefix stripped
    const altPrefix = napiPkgName.replace("@", "").replace("/", "+");
    const cacheDir = findBunCacheDir(`@${altPrefix}@`);
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

  // 2. Patch dprint-node: replace dynamic require with static one
  console.log("Patching native module loaders...");

  const dprintIndexPath = join(dprintDir, "index.js");
  const dprintNodeFile = config.dprintNode;
  patchFile(dprintIndexPath, `module.exports = require('./${dprintNodeFile}');\n`);

  // 3. Patch ast-grep/napi: copy platform .node file into napi dir so static require works
  const napiNodeSrc = join(napiPlatformDir, config.astGrepNapiNodeFile);
  const napiNodeDest = join(napiDir, config.astGrepNapiNodeFile);

  if (!existsSync(napiNodeSrc)) {
    throw new Error(`Native .node file not found: ${napiNodeSrc}`);
  }

  // Copy the .node file into the napi package directory
  copyFileSync(napiNodeSrc, napiNodeDest);
  console.log(`  copied: ${napiNodeSrc} → ${napiNodeDest}`);

  // The napi index.js tries to require this filename FIRST as a local file
  // (it's the first thing it tries in each platform case), so we don't need
  // to patch index.js — just having the file present is enough.
  // But to be safe and ensure Bun's static analysis picks it up, let's also
  // patch to a simple static require.
  const napiIndexPath = join(napiDir, "index.js");
  patchFile(napiIndexPath,
    `const { createRequire } = require('node:module');\n` +
    `require = createRequire(__filename);\n` +
    `const nativeBinding = require('./${config.astGrepNapiNodeFile}');\n` +
    `const { SgNode, SgRoot } = nativeBinding;\n` +
    `module.exports = nativeBinding;\n` +
    `module.exports.SgNode = SgNode;\n` +
    `module.exports.SgRoot = SgRoot;\n`
  );

  // 4. Patch ast-grep/lang-go: static prebuild path
  const langGoIndexPath = join(langGoDir, "index.js");
  const langGoPrebuildPath = join(langGoDir, "prebuilds", config.langGoPrebuild);

  if (!existsSync(langGoPrebuildPath)) {
    console.warn(`  warning: lang-go prebuild not found: ${langGoPrebuildPath}`);
    console.warn(`  Go analysis will not work in the standalone binary`);
  }

  patchFile(langGoIndexPath,
    `const path = require('node:path');\n` +
    `\n` +
    `let libPath;\n` +
    `\n` +
    `// In standalone binary, check env override first\n` +
    `if (process.env.AST_GREP_LANG_GO_PATH) {\n` +
    `  libPath = process.env.AST_GREP_LANG_GO_PATH;\n` +
    `} else {\n` +
    `  libPath = path.join(__dirname, 'prebuilds', '${config.langGoPrebuild}');\n` +
    `}\n` +
    `\n` +
    `module.exports = {\n` +
    `  get libraryPath() { return libPath; },\n` +
    `  extensions: ['go'],\n` +
    `  languageSymbol: 'tree_sitter_go',\n` +
    `  expandoChar: 'µ',\n` +
    `};\n`
  );

  console.log();

  // 5. Run bun build --compile
  console.log("Building standalone binary...");
  const outfile = join(ROOT, "supergraph");
  const bunTarget = target === detectHostTarget() ? "" : ` --target=bun-${target}`;
  const cmd = `bun build --compile --minify${bunTarget} src/index.ts --outfile supergraph`;
  console.log(`  $ ${cmd}`);

  try {
    execSync(cmd, { cwd: ROOT, stdio: "inherit" });
  } finally {
    // 6. Restore all patched files (always, even if build fails)
    console.log("\nRestoring patched files...");
    restoreAll();

    // Clean up copied .node file
    if (existsSync(napiNodeDest)) {
      const { unlinkSync } = require("node:fs");
      unlinkSync(napiNodeDest);
      console.log(`  removed: ${napiNodeDest}`);
    }
  }

  // 7. Copy lang-go .so to lib/ output directory
  const libDir = join(ROOT, "lib");
  mkdirSync(libDir, { recursive: true });

  if (existsSync(langGoPrebuildPath)) {
    const soDestPath = join(libDir, "lang-go-parser.so");
    copyFileSync(langGoPrebuildPath, soDestPath);
    console.log(`\nCopied lang-go parser: ${soDestPath}`);
  }

  console.log(`\nBuild complete!`);
  console.log(`  binary: ${outfile}`);
  console.log(`  lib:    ${libDir}/`);
  console.log(`\nTo test: cp supergraph lib/ /tmp/test/ && cd /tmp/test && ./supergraph --help`);
}

build().catch((err) => {
  console.error("\nBuild failed:", err);
  // Ensure cleanup
  if (patchedFiles.length > 0) {
    console.log("Restoring patched files after failure...");
    restoreAll();
  }
  process.exit(1);
});
