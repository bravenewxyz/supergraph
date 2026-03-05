#!/usr/bin/env bun

/**
 * Release script for supergraph.
 *
 * 1. Bump version (patch)
 * 2. Commit + push
 * 3. Build binaries for all targets
 * 4. Create GitHub release with tarballs
 * 5. Update Homebrew formula with new SHA256s
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";

const ROOT = resolve(import.meta.dir, "..");
const TARGETS = ["darwin-arm64", "darwin-x64", "linux-x64"] as const;
const REPO = "bravenewxyz/supergraph";
const TAP_REPO = "bravenewxyz/homebrew-supergraph";

function run(cmd: string, opts?: { cwd?: string; stdio?: "inherit" | "pipe" }): string {
  const result = execSync(cmd, {
    cwd: opts?.cwd ?? ROOT,
    stdio: opts?.stdio ?? "pipe",
    encoding: "utf-8",
  });
  return typeof result === "string" ? result.trim() : "";
}

function sha256File(path: string): string {
  const data = readFileSync(path);
  return createHash("sha256").update(data).digest("hex");
}

async function main() {
  // 1. Bump version (unless --no-bump passed, for re-runs)
  const noBump = process.argv.includes("--no-bump");
  let pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));

  if (noBump) {
    console.log(`\n1. Using current version v${pkg.version}`);
  } else {
    console.log("\n1. Bumping version...");
    run("npm version patch --no-git-tag-version");
    pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
    console.log(`   v${pkg.version}`);
  }
  const version = pkg.version;

  // 2. Commit + push (skip if nothing to commit)
  console.log("\n2. Committing and pushing...");
  const dirty = run("git status --porcelain");
  if (dirty) {
    run("git add -A");
    run(`git commit -m "release: v${version}"`);
  }
  run("git push");

  // 3. Build for all targets
  console.log("\n3. Building binaries...");
  const distDir = join(ROOT, "dist");
  mkdirSync(distDir, { recursive: true });

  const tarballs: { target: string; path: string; sha256: string }[] = [];

  for (const target of TARGETS) {
    console.log(`\n   Building ${target}...`);
    try {
      run(`bun run scripts/build.ts --target ${target}`, { stdio: "inherit" });
    } catch (err) {
      console.log(`   Skipping ${target} (native deps not available locally)`);
      continue;
    }

    // Package into tarball
    const tarName = `supergraph-${target}.tar.gz`;
    const tarPath = join(distDir, tarName);
    run(`tar czf ${tarPath} supergraph lib/`);

    const hash = sha256File(tarPath);
    tarballs.push({ target, path: tarPath, sha256: hash });

    // Write sha256 file
    writeFileSync(`${tarPath}.sha256`, `${hash}  ${tarName}\n`);
    console.log(`   ${tarName}: ${hash}`);
  }

  if (tarballs.length === 0) {
    throw new Error("No targets built successfully");
  }

  // 4. Create GitHub release
  console.log("\n4. Creating GitHub release...");
  const assets = tarballs
    .flatMap((t) => [t.path, `${t.path}.sha256`])
    .map((p) => `"${p}"`)
    .join(" ");

  // Delete existing release/tag if present (re-release)
  try { run(`gh release delete v${version} -y`); } catch {}
  try { run(`git push origin :refs/tags/v${version}`); } catch {}
  try { run(`git tag -d v${version}`); } catch {}

  run(
    `gh release create v${version} ${assets} --title "v${version}" --notes "Release v${version}"`,
    { stdio: "inherit" },
  );

  // 5. Update Homebrew formula
  console.log("\n5. Updating Homebrew formula...");
  const tapDir = run("brew --repository bravenewxyz/supergraph");

  if (!existsSync(tapDir)) {
    console.log("   Homebrew tap not found locally, skipping formula update.");
    console.log(`   Run: brew tap ${TAP_REPO}`);
  } else {
    const formulaPath = join(tapDir, "Formula", "supergraph.rb");
    let formula = readFileSync(formulaPath, "utf-8");

    // Update version
    formula = formula.replace(/version ".*"/, `version "${version}"`);

    // Update SHA256 for each built target
    const shaMap: Record<string, string> = {};
    for (const t of tarballs) shaMap[t.target] = t.sha256;

    if (shaMap["darwin-arm64"]) {
      formula = formula.replace(
        /(on_arm do\s+url ".*?"\s+sha256 ")([a-f0-9]+)(")/s,
        `$1${shaMap["darwin-arm64"]}$3`,
      );
    }
    if (shaMap["darwin-x64"]) {
      formula = formula.replace(
        /(on_intel do\s+url ".*?"\s+sha256 ")([a-f0-9]+)(")/s,
        `$1${shaMap["darwin-x64"]}$3`,
      );
    }
    if (shaMap["linux-x64"]) {
      formula = formula.replace(
        /(on_linux do\s+on_intel do\s+url ".*?"\s+sha256 ")([a-f0-9]+)(")/s,
        `$1${shaMap["linux-x64"]}$3`,
      );
    }

    writeFileSync(formulaPath, formula);

    // Commit + push tap
    run("git add -A", { cwd: tapDir });
    run(`git commit -m "Update formula for v${version}"`, { cwd: tapDir });
    run("git push", { cwd: tapDir });
    console.log(`   Homebrew formula updated to v${version}`);
  }

  console.log(`\n✓ Released v${version}`);
  console.log(`  https://github.com/${REPO}/releases/tag/v${version}`);
}

main().catch((err) => {
  console.error("\nRelease failed:", err.message ?? err);
  process.exit(1);
});
