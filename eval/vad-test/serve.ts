// static server for data/vad-test/out (localhost only)
import { resolve, normalize } from "node:path";
const root = resolve("data/vad-test/out");
Bun.serve({
  port: 3100,
  hostname: "127.0.0.1",
  fetch(req) {
    const p = decodeURIComponent(new URL(req.url).pathname);
    const file = resolve(root, "." + normalize(p === "/" ? "/index.html" : p));
    if (!file.startsWith(root)) return new Response("forbidden", { status: 403 });
    const f = Bun.file(file);
    return f.size ? new Response(f) : new Response("not found", { status: 404 });
  },
});
console.log("serving", root, "on http://127.0.0.1:3100");
