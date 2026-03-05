export type { PackageManifest } from "../map.js";

export interface MapOptions {
  srcRoot: string;
  format?: "json" | "text";
  comments?: boolean;
  outPath?: string;
}

export interface MapResult {
  manifest: PackageManifest;
  output: string;
}

export interface ComplexityOptions {
  srcRoot: string;
  outPath?: string;
  topN?: number;
  minComplexity?: number;
}

export interface DeadExportsOptions {
  srcRoot: string;
  outPath?: string;
}

export type LanguageId = "typescript" | "go" | "python" | "rust" | "java";

export interface LanguageDriver {
  id: LanguageId;
  name: string;
  detect(dir: string): Promise<boolean>;
  map(opts: MapOptions): Promise<MapResult>;
  complexity(opts: ComplexityOptions): Promise<string>;
  deadExports(opts: DeadExportsOptions): Promise<string>;
}
