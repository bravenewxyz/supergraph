const TS_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts"];

export function qualifiedNameToFilePath(qualifiedName: string): string {
  // If it already has a known extension, return as-is
  for (const ext of TS_EXTENSIONS) {
    if (qualifiedName.endsWith(ext)) {
      return qualifiedName;
    }
  }
  return qualifiedName + ".ts";
}

export function filePathToModuleName(filePath: string): string {
  for (const ext of TS_EXTENSIONS) {
    if (filePath.endsWith(ext)) {
      return filePath.slice(0, -ext.length);
    }
  }
  return filePath;
}
