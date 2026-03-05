import type { GraphStore } from "@devtools/graph";
import type { DataBoundary, ErrorPathInfo } from "../schema/boundaries.js";
import type { Pipeline, PipelineSegment } from "../schema/pipelines.js";
import { checkJsonRoundtrip } from "../extractor/json-roundtrip.js";
import type { ShapeMismatch } from "../schema/shapes.js";

export interface PipelineTracerOptions {
  boundaries: DataBoundary[];
  graphStore: GraphStore;
  targetType?: string;
}

export interface TracedPipeline extends Pipeline {
  jsonRoundtripIssues: ShapeMismatch[];
}

export function tracePipelines(
  options: PipelineTracerOptions,
): TracedPipeline[] {
  const { boundaries, graphStore, targetType } = options;

  // Group boundaries by function context
  const byFunction = new Map<string, DataBoundary[]>();
  for (const b of boundaries) {
    const key = `${b.filePath}::${b.functionContext}`;
    if (!byFunction.has(key)) byFunction.set(key, []);
    byFunction.get(key)!.push(b);
  }

  // Build call graph from GraphStore edges
  const callGraph = buildCallGraph(graphStore);

  // Find serialize→deserialize pairs (pipeline seeds)
  const seeds = findPipelineSeeds(boundaries);

  // Expand seeds into full pipelines via call graph
  const pipelines: TracedPipeline[] = [];

  for (const seed of seeds) {
    const pipeline = expandPipeline(seed, boundaries, callGraph, byFunction);
    if (targetType && !pipelineTouchesType(pipeline, targetType)) continue;
    pipelines.push(pipeline);
  }

  // Merge overlapping pipelines
  return deduplicatePipelines(pipelines);
}

interface CallEdge {
  from: string;
  to: string;
}

function buildCallGraph(
  graphStore: GraphStore,
): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();

  for (const edge of graphStore.getAllEdges()) {
    if (edge.kind !== "calls") continue;
    const source = graphStore.getSymbol(edge.sourceId);
    const target = graphStore.getSymbol(edge.targetId);
    if (!source || !target) continue;

    const srcName = source.qualifiedName;
    const tgtName = target.qualifiedName;

    if (!graph.has(srcName)) graph.set(srcName, new Set());
    graph.get(srcName)!.add(tgtName);
  }

  return graph;
}

interface PipelineSeed {
  serialize: DataBoundary;
  deserialize: DataBoundary;
  name: string;
}

function findPipelineSeeds(boundaries: DataBoundary[]): PipelineSeed[] {
  const seeds: PipelineSeed[] = [];
  const serializers = boundaries.filter(
    (b) => b.kind === "json-serialize" || b.kind === "file-write",
  );
  const deserializers = boundaries.filter(
    (b) => b.kind === "json-deserialize" || b.kind === "file-read",
  );

  for (const ser of serializers) {
    for (const deser of deserializers) {
      // Same file typically isn't a pipeline (it's local round-trip)
      // Different files or different functions suggest a real data boundary
      if (
        ser.filePath !== deser.filePath ||
        ser.functionContext !== deser.functionContext
      ) {
        seeds.push({
          serialize: ser,
          deserialize: deser,
          name: `${ser.functionContext}→${deser.functionContext}`,
        });
      }
    }
  }

  // Also look for subprocess boundaries — spawn in one function implies
  // file-write before + file-read after in the subprocess code
  const spawns = boundaries.filter((b) => b.kind === "subprocess-spawn");
  for (const spawn of spawns) {
    const writesInSameFunc = serializers.filter(
      (s) =>
        s.filePath === spawn.filePath &&
        s.functionContext === spawn.functionContext,
    );
    for (const w of writesInSameFunc) {
      for (const deser of deserializers) {
        if (deser.filePath !== spawn.filePath) {
          seeds.push({
            serialize: w,
            deserialize: deser,
            name: `subprocess:${spawn.functionContext}→${deser.functionContext}`,
          });
        }
      }
    }
  }

  return seeds;
}

function expandPipeline(
  seed: PipelineSeed,
  allBoundaries: DataBoundary[],
  callGraph: Map<string, Set<string>>,
  byFunction: Map<string, DataBoundary[]>,
): TracedPipeline {
  const segments: PipelineSegment[] = [];
  const errorPaths: ErrorPathInfo[] = [];
  const schemaValidations: DataBoundary[] = [];
  const typeAssertions: DataBoundary[] = [];
  const jsonRoundtripIssues: ShapeMismatch[] = [];

  // Core segment: serialize → deserialize
  segments.push({
    from: seed.serialize,
    to: seed.deserialize,
    callChain: [seed.serialize.functionContext, seed.deserialize.functionContext],
    dataType: seed.serialize.inputType?.name ?? "unknown",
  });

  // Check JSON roundtrip at this boundary
  if (seed.serialize.inputType?.shape && seed.deserialize.outputType?.shape) {
    jsonRoundtripIssues.push(
      ...checkJsonRoundtrip(
        seed.serialize.inputType.shape,
        seed.deserialize.outputType.shape,
      ),
    );
  }

  // Find schema validations near the deserialize point
  const deserFuncKey = `${seed.deserialize.filePath}::${seed.deserialize.functionContext}`;
  const deserFuncBoundaries = byFunction.get(deserFuncKey) ?? [];

  for (const b of deserFuncBoundaries) {
    if (b.kind === "schema-validate") {
      schemaValidations.push(b);
      if (b.errorHandler) errorPaths.push(b.errorHandler);
    }
    if (b.kind === "type-assertion") {
      typeAssertions.push(b);
    }
  }

  // Find upstream boundaries (callers of the serialize function)
  const serFuncKey = `${seed.serialize.filePath}::${seed.serialize.functionContext}`;
  const serFuncBoundaries = byFunction.get(serFuncKey) ?? [];
  for (const b of serFuncBoundaries) {
    if (b.errorHandler) errorPaths.push(b.errorHandler);
  }

  // Find downstream boundaries (callees of the deserialize function)
  const calledBy = callGraph.get(seed.deserialize.functionContext);
  if (calledBy) {
    for (const calleeName of calledBy) {
      for (const [key, bounds] of byFunction) {
        if (key.endsWith(`::${calleeName}`)) {
          for (const b of bounds) {
            if (b.errorHandler) errorPaths.push(b.errorHandler);
            if (b.kind === "schema-validate") schemaValidations.push(b);
            if (b.kind === "type-assertion") typeAssertions.push(b);
          }
        }
      }
    }
  }

  return {
    name: seed.name,
    segments,
    origin: seed.serialize,
    terminus: seed.deserialize,
    errorPaths,
    schemaValidations,
    typeAssertions,
    jsonRoundtripIssues,
  };
}

function pipelineTouchesType(pipeline: TracedPipeline, typeName: string): boolean {
  const lower = typeName.toLowerCase();
  const check = (s: string | null | undefined) =>
    s ? s.toLowerCase().includes(lower) : false;

  return (
    check(pipeline.origin.inputType?.name) ||
    check(pipeline.terminus.outputType?.name) ||
    pipeline.schemaValidations.some((v) => check(v.runtimeSchema?.schemaName)) ||
    check(pipeline.origin.raw) ||
    check(pipeline.terminus.raw) ||
    check(pipeline.name)
  );
}

function deduplicatePipelines(pipelines: TracedPipeline[]): TracedPipeline[] {
  const seen = new Set<string>();
  return pipelines.filter((p) => {
    const key = `${p.origin.filePath}:${p.origin.line}→${p.terminus.filePath}:${p.terminus.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
