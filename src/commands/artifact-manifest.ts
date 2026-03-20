export type ArtifactScope = "repo" | "package";

export type ArtifactStatus = "generated" | "skipped" | "empty" | "failed";

export type ArtifactFormat = "html" | "txt" | "json" | "md";

export interface ArtifactRecord {
  id: string;
  scope: ArtifactScope;
  producer: string;
  format: ArtifactFormat;
  path: string;
  status: ArtifactStatus;
  bytes?: number;
  summary?: string;
  inputs?: string[];
  reason?: string;
  packageName?: string;
  generatedAt?: string;
}

export interface ArtifactManifestSummary {
  total: number;
  generated: number;
  skipped: number;
  empty: number;
  failed: number;
}

export interface ArtifactManifest {
  generatedAt: string;
  root: string;
  summary: ArtifactManifestSummary;
  artifacts: ArtifactRecord[];
}

export interface ArtifactRecordInput extends Partial<Omit<ArtifactRecord, "id" | "scope" | "producer" | "format" | "path" | "status">> {
  id: string;
  scope: ArtifactScope;
  producer: string;
  format: ArtifactFormat;
  path: string;
  status: ArtifactStatus;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+/g, "/");
}

export function normalizeArtifactRecord(record: ArtifactRecordInput): ArtifactRecord {
  const normalized: ArtifactRecord = {
    id: record.id.trim(),
    scope: record.scope,
    producer: record.producer.trim(),
    format: record.format,
    path: normalizePath(record.path.trim()),
    status: record.status,
  };

  if (typeof record.bytes === "number" && Number.isFinite(record.bytes)) {
    normalized.bytes = Math.max(0, Math.trunc(record.bytes));
  }
  if (record.summary) normalized.summary = record.summary.trim();
  if (record.inputs?.length) {
    normalized.inputs = record.inputs.map((input) => normalizePath(input.trim())).filter(Boolean);
  }
  if (record.reason) normalized.reason = record.reason.trim();
  if (record.packageName) normalized.packageName = record.packageName.trim();
  if (record.generatedAt) normalized.generatedAt = record.generatedAt;

  return normalized;
}

export function summarizeArtifactRecords(records: ArtifactRecord[]): ArtifactManifestSummary {
  const summary: ArtifactManifestSummary = {
    total: records.length,
    generated: 0,
    skipped: 0,
    empty: 0,
    failed: 0,
  };

  for (const record of records) {
    summary[record.status]++;
  }

  return summary;
}

export function buildArtifactManifest(
  root: string,
  artifacts: ArtifactRecordInput[],
  generatedAt = new Date().toISOString(),
): ArtifactManifest {
  const normalizedArtifacts = artifacts.map((artifact) => normalizeArtifactRecord(artifact));

  return {
    generatedAt,
    root: normalizePath(root.trim()),
    summary: summarizeArtifactRecords(normalizedArtifacts),
    artifacts: normalizedArtifacts,
  };
}

export function serializeArtifactManifest(manifest: ArtifactManifest): string {
  return JSON.stringify(manifest, null, 2);
}

