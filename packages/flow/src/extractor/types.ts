import type { ShapeType } from "../schema/shapes.js";

export interface RuntimeSchemaInfo {
  name: string;
  library: string;
  filePath: string;
  line: number;
  shape: ShapeType;
  raw: string;
}

export interface RuntimeSchemaExtractor {
  readonly library: string;

  /** Detect if this library is imported/required in the source. */
  detect(source: string): boolean;

  /** ast-grep patterns for validation call sites (e.g. `$SCHEMA.safeParse($DATA)`). */
  readonly validationPatterns: string[];

  /** Extract all schema definitions from a source file. */
  extract(source: string, filePath: string): RuntimeSchemaInfo[];
}
