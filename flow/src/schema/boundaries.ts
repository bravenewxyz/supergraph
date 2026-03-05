import type { ShapeType } from "./shapes.js";

export type BoundaryKind =
  | "json-serialize"
  | "json-deserialize"
  | "schema-validate"
  | "type-assertion"
  | "subprocess-spawn"
  | "file-write"
  | "file-read"
  | "git-commit"
  | "git-read"
  | "error-fallback"
  | "http-send"
  | "http-receive";

export interface DataBoundary {
  kind: BoundaryKind;
  filePath: string;
  line: number;
  column: number;
  functionContext: string;
  raw: string;
  inputType: ResolvedTypeInfo | null;
  outputType: ResolvedTypeInfo | null;
  runtimeSchema: RuntimeSchemaRef | null;
  errorHandler: ErrorPathInfo | null;
}

export interface ResolvedTypeInfo {
  name: string;
  shape: ShapeType;
  source: "typescript";
}

export interface RuntimeSchemaRef {
  library: string;
  schemaName: string;
  shape: ShapeType;
  source: "runtime-schema";
}

export interface ErrorPathInfo {
  kind:
    | "catch"
    | "validation-failure"
    | "null-return"
    | "throw"
    | "ternary-fallback";
  fallbackValue: string | null;
  logLevel: "error" | "warn" | "info" | "debug" | "none";
  line: number;
}
