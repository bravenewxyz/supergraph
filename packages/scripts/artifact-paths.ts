import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export type ArtifactArea = "views" | "context" | "raw";

export interface MirroredPath {
  primary: string;
  legacy: string;
}

function normalizeRelativePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+/g, "/");
}

export function auditRoot(root: string): string {
  return resolve(root, ".supergraph");
}

export function rawRoot(root: string): string {
  return resolve(auditRoot(root), "raw");
}

export function rawRepoRoot(root: string): string {
  return resolve(rawRoot(root), "repo");
}

export function rawPackagesRoot(root: string): string {
  return resolve(rawRoot(root), "packages");
}

export function viewsRoot(root: string): string {
  return resolve(auditRoot(root), "views");
}

export function viewsPackagesRoot(root: string): string {
  return resolve(viewsRoot(root), "packages");
}

export function contextRoot(root: string): string {
  return resolve(auditRoot(root), "context");
}

export function contextPackagesRoot(root: string): string {
  return resolve(contextRoot(root), "packages");
}

export function legacyPackagesRoot(root: string): string {
  return resolve(auditRoot(root), "packages");
}

export function rawPackageDir(root: string, pkgName: string): string {
  return resolve(rawPackagesRoot(root), pkgName);
}

export function viewsPackageDir(root: string, pkgName: string): string {
  return resolve(viewsPackagesRoot(root), pkgName);
}

export function contextPackageDir(root: string, pkgName: string): string {
  return resolve(contextPackagesRoot(root), pkgName);
}

export function legacyPackageDir(root: string, pkgName: string): string {
  return resolve(legacyPackagesRoot(root), pkgName);
}

export function artifactPath(
  root: string,
  area: ArtifactArea,
  primaryRelative: string,
  legacyRelative?: string,
): MirroredPath {
  const primary = resolve(
    auditRoot(root),
    area,
    normalizeRelativePath(primaryRelative),
  );
  const legacy = resolve(
    auditRoot(root),
    normalizeRelativePath(legacyRelative ?? primaryRelative),
  );
  return { primary, legacy };
}

export const repoArtifacts = {
  pkgGraphHtml: (root: string) => resolve(viewsRoot(root), "pkg-graph.html"),
  supergraphHtml: (root: string) => resolve(viewsRoot(root), "supergraph.html"),
  architectureFull: (root: string) => resolve(contextRoot(root), "architecture-full.txt"),
  architectureCompact: (root: string) => resolve(contextRoot(root), "architecture-compact.txt"),
  findings: (root: string) => resolve(contextRoot(root), "findings.txt"),
  temporal: (root: string) => resolve(contextRoot(root), "temporal.txt"),
  symbolsBrief: (root: string) => resolve(contextRoot(root), "symbols-brief.txt"),
  symbolsSource: (root: string) => resolve(contextRoot(root), "symbols-source.txt"),
  crossLangText: (root: string) => resolve(contextRoot(root), "cross-lang-bridge.txt"),
  crossLangJson: (root: string) => resolve(rawRepoRoot(root), "cross-lang-bridge.json"),
  index: (root: string) => resolve(auditRoot(root), "index.json"),
};

export const legacyRepoArtifacts = {
  pkgGraphHtml: (root: string) => resolve(auditRoot(root), "pkg-graph.html"),
  supergraphHtml: (root: string) => resolve(auditRoot(root), "supergraph.html"),
  architectureFull: (root: string) => resolve(auditRoot(root), "supergraph.txt"),
  architectureCompact: (root: string) => resolve(auditRoot(root), "supergraph-compact.txt"),
  findings: (root: string) => resolve(auditRoot(root), "issues.txt"),
  temporal: (root: string) => resolve(auditRoot(root), "temporal.txt"),
  symbolsBrief: (root: string) => resolve(auditRoot(root), "symbols.txt"),
  symbolsSource: (root: string) => resolve(auditRoot(root), "symbols-full.txt"),
  crossLangText: (root: string) => resolve(auditRoot(root), "cross-lang-bridge.txt"),
  crossLangJson: (root: string) => resolve(auditRoot(root), "cross-lang-bridge.json"),
};

export function legacyPathForCanonical(root: string, canonicalPath: string): string | null {
  const pairs: Array<[string, string]> = [
    [repoArtifacts.pkgGraphHtml(root), legacyRepoArtifacts.pkgGraphHtml(root)],
    [repoArtifacts.supergraphHtml(root), legacyRepoArtifacts.supergraphHtml(root)],
    [repoArtifacts.architectureFull(root), legacyRepoArtifacts.architectureFull(root)],
    [repoArtifacts.architectureCompact(root), legacyRepoArtifacts.architectureCompact(root)],
    [repoArtifacts.findings(root), legacyRepoArtifacts.findings(root)],
    [repoArtifacts.temporal(root), legacyRepoArtifacts.temporal(root)],
    [repoArtifacts.symbolsBrief(root), legacyRepoArtifacts.symbolsBrief(root)],
    [repoArtifacts.symbolsSource(root), legacyRepoArtifacts.symbolsSource(root)],
    [repoArtifacts.crossLangText(root), legacyRepoArtifacts.crossLangText(root)],
    [repoArtifacts.crossLangJson(root), legacyRepoArtifacts.crossLangJson(root)],
  ];
  for (const [from, to] of pairs) {
    if (canonicalPath === from) return to;
  }

  const rawPkgRoot = `${rawPackagesRoot(root)}/`;
  if (canonicalPath.startsWith(rawPkgRoot)) {
    const rel = canonicalPath.slice(rawPkgRoot.length);
    return resolve(legacyPackagesRoot(root), rel.replace(/(^[^/]+)\//, "$1/json/"));
  }

  const viewsPkgRoot = `${viewsPackagesRoot(root)}/`;
  if (canonicalPath.startsWith(viewsPkgRoot)) {
    const rel = canonicalPath.slice(viewsPkgRoot.length);
    return resolve(legacyPackagesRoot(root), rel);
  }

  const contextPkgRoot = `${contextPackagesRoot(root)}/`;
  if (canonicalPath.startsWith(contextPkgRoot)) {
    const rel = canonicalPath.slice(contextPkgRoot.length);
    return resolve(legacyPackagesRoot(root), rel);
  }

  return null;
}

export async function mirrorCanonicalToLegacy(root: string, canonicalPath: string): Promise<void> {
  const legacyPath = legacyPathForCanonical(root, canonicalPath);
  if (!legacyPath || legacyPath === canonicalPath) return;
  await mkdir(dirname(legacyPath), { recursive: true });
  await copyFile(canonicalPath, legacyPath);
}

async function writeMirroredFile(path: MirroredPath, content: string): Promise<void> {
  await mkdir(dirname(path.primary), { recursive: true });
  await writeFile(path.primary, content, "utf-8");
  if (path.legacy !== path.primary) {
    await mkdir(dirname(path.legacy), { recursive: true });
    await writeFile(path.legacy, content, "utf-8");
  }
}

export async function writeMirroredText(
  root: string,
  area: ArtifactArea,
  primaryRelative: string,
  content: string,
  legacyRelative?: string,
): Promise<MirroredPath> {
  const path = artifactPath(root, area, primaryRelative, legacyRelative);
  await writeMirroredFile(path, content);
  return path;
}

export async function writeMirroredJson(
  root: string,
  area: ArtifactArea,
  primaryRelative: string,
  value: unknown,
  legacyRelative?: string,
): Promise<MirroredPath> {
  return writeMirroredText(
    root,
    area,
    primaryRelative,
    JSON.stringify(value, null, 2),
    legacyRelative,
  );
}
