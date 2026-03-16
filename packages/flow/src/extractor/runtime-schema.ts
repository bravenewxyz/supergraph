import type { RuntimeSchemaExtractor, RuntimeSchemaInfo } from "./types.js";
import { ZodExtractor } from "./zod.js";
import { ValibotExtractor } from "./valibot.js";
import { TypeBoxExtractor } from "./typebox.js";
import { ArkTypeExtractor } from "./arktype.js";
import { YupExtractor } from "./yup.js";

export type { RuntimeSchemaInfo, RuntimeSchemaExtractor } from "./types.js";

export class ExtractorRegistry {
  private extractors: RuntimeSchemaExtractor[] = [];

  register(extractor: RuntimeSchemaExtractor): void {
    this.extractors.push(extractor);
  }

  getAll(): readonly RuntimeSchemaExtractor[] {
    return this.extractors;
  }

  detectFor(source: string): RuntimeSchemaExtractor[] {
    return this.extractors.filter((e) => e.detect(source));
  }

  extractAll(source: string, filePath: string): RuntimeSchemaInfo[] {
    return this.detectFor(source).flatMap((e) => e.extract(source, filePath));
  }

  allValidationPatterns(): Array<{ library: string; patterns: string[] }> {
    return this.extractors.map((e) => ({
      library: e.library,
      patterns: e.validationPatterns,
    }));
  }
}

export function createDefaultRegistry(): ExtractorRegistry {
  const registry = new ExtractorRegistry();
  registry.register(new ZodExtractor());
  registry.register(new ValibotExtractor());
  registry.register(new TypeBoxExtractor());
  registry.register(new ArkTypeExtractor());
  registry.register(new YupExtractor());
  return registry;
}
