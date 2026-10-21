import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { basename, dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export interface Target {
  url: string;
  // Port of the built-in static server, when the target is a local folder or file.
  servedPort: number | null;
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".pck": "application/octet-stream",
};

// A URL is used as-is. Anything else is a local folder or HTML file, served over HTTP (module scripts, fetch and
// WebAssembly do not work from file://). "./dist?level=3" keeps its query string.
export async function openTarget(input: string, port = 0): Promise<Target> {
  if (/^https?:\/\//i.test(input)) return { url: input, servedPort: null, close: async () => {} };

  let pathPart = input.startsWith("file://") ? fileURLToPath(input) : input;
  let suffix = "";
  if (!existsSync(pathPart)) {
    const cut = pathPart.search(/[?#]/);
    if (cut > 0) {
      suffix = pathPart.slice(cut);
      pathPart = pathPart.slice(0, cut);
    }
  }
  const full = resolve(pathPart);
  if (!existsSync(full)) throw new UsageError(`Target not found: ${input} (expected a URL, a folder or an .html file)`);

  const isDir = statSync(full).isDirectory();
  const root = isDir ? full : dirname(full);
  const entry = isDir ? "" : basename(full);
  const server = await serve(root, port);
  const { port: actualPort } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${actualPort}/${encodeURI(entry)}${suffix}`,
    servedPort: actualPort,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

function serve(root: string, port: number): Promise<Server> {
  const server = createServer((req, res) => {
    let path: string;
    try {
      path = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    let file = normalize(join(root, path));
    if (file !== root && !file.startsWith(root + sep)) {
      res.writeHead(403).end();
      return;
    }
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    if (!existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404, { "content-type": "text/plain" }).end(`Not found: ${path}`);
      return;
    }
    res.writeHead(200, {
      "content-type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
      "cache-control": "no-store",
      // Lets SharedArrayBuffer-based exports (Godot 4 web, some Unity builds) start without a custom server.
      "cross-origin-opener-policy": "same-origin",
      "cross-origin-embedder-policy": "credentialless",
      "cross-origin-resource-policy": "cross-origin",
    });
    createReadStream(file).pipe(res);
  });
  return new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(port, "127.0.0.1", () => done(server));
  });
}

export class UsageError extends Error {}
