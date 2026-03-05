import type { DataBoundary, ErrorPathInfo } from "./boundaries.js";

export interface PipelineSegment {
  from: DataBoundary;
  to: DataBoundary;
  callChain: string[];
  dataType: string;
}

export interface Pipeline {
  name: string;
  segments: PipelineSegment[];
  origin: DataBoundary;
  terminus: DataBoundary;
  errorPaths: ErrorPathInfo[];
  schemaValidations: DataBoundary[];
  typeAssertions: DataBoundary[];
}

