const file = Bun.file("index.html");

Bun.serve({
  port: Number(process.env.PORT) || 8080,
  fetch() {
    return new Response(file, { headers: { "content-type": "text/html" } });
  },
});

console.log(`Listening on :${Number(process.env.PORT) || 8080}`);
