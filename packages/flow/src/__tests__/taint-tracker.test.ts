import { describe, expect, test } from "bun:test";
import { runTaintAnalysis } from "../analysis/taint-tracker.js";

describe("runTaintAnalysis", () => {
  test("does not crash on truncated multi-line sink text", async () => {
    const srcDir = "/virtual/pkg/src";
    const filePath = `${srcDir}/local-run.ts`;
    const source = `import { writeFileSync } from "node:fs";
import { join } from "node:path";

export function writeApp(outputDir: string) {
  writeFileSync(
    join(outputDir, "index.html"),
    \`<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>App</title>
    <link rel="stylesheet" href="./styles.css" />
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/index.ts"></script>
  </body>
</html>\`,
  );
}
`;

    const analysis = await runTaintAnalysis(srcDir, {
      fileContents: new Map([[filePath, source]]),
    });

    expect(analysis.sinks).toHaveLength(1);
    expect(analysis.sinks[0]?.kind).toBe("file-path");
  });
});
