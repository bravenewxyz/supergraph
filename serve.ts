import { join, extname } from "path";

const DIR = import.meta.dir;

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

Bun.serve({
  port: Number(process.env.PORT) || 8080,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname === "/" ? "/index.html" : url.pathname;

    // Block path traversal
    if (path.includes("..")) {
      return new Response("Not found", { status: 404 });
    }

    const filePath = join(DIR, path);
    const file = Bun.file(filePath);

    if (await file.exists()) {
      const ext = extname(path);
      return new Response(file, {
        headers: { "content-type": MIME[ext] || "application/octet-stream" },
      });
    }

    return new Response(Bun.file(join(DIR, "index.html")), {
      headers: { "content-type": "text/html" },
    });
  },
});

console.log(`Listening on :${Number(process.env.PORT) || 8080}`);
