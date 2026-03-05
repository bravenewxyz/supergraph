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
    const file = Bun.file(`.${path}`);

    if (await file.exists()) {
      const ext = path.substring(path.lastIndexOf("."));
      return new Response(file, {
        headers: { "content-type": MIME[ext] || "application/octet-stream" },
      });
    }

    return new Response(Bun.file("index.html"), {
      headers: { "content-type": "text/html" },
    });
  },
});

console.log(`Listening on :${Number(process.env.PORT) || 8080}`);
