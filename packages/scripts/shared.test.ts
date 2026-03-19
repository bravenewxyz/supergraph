import { describe, expect, test } from "bun:test";
import { serializeJsonForHtmlScriptTag } from "./shared.js";

describe("serializeJsonForHtmlScriptTag", () => {
  test("escapes script-closing sequences without changing JSON meaning", () => {
    const value = {
      raw: "</script><script>alert('xss')</script>",
      nested: ["<tag>", "&", "\u2028", "\u2029"],
    };

    const serialized = serializeJsonForHtmlScriptTag(value);

    expect(serialized).not.toContain("</script>");
    expect(serialized).toContain("\\u003c/script\\u003e");
    expect(JSON.parse(serialized)).toEqual(value);
  });
});
