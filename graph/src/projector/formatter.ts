import dprint from "dprint-node";

export function formatTypeScript(code: string, filePath?: string): string {
  try {
    return dprint.format(filePath ?? "file.ts", code);
  } catch {
    // Fall back to unformatted code if dprint chokes
    return code;
  }
}
