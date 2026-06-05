import { createServer } from "node:http";
import { URL } from "node:url";

import { generateMap, renderMapGenerationDebugHtml, type GenerateMapOptions, type TopologyMode } from "./mapgen.js";

const DEFAULT_PORT = 5999;
const DEFAULT_HOST = "0.0.0.0";

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  const value = process.argv.find((arg) => arg.startsWith(prefix));
  if (value) return value.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function intParam(value: string | null, fallback: number): number {
  if (value === null || value.trim() === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function floatParam(value: string | null, fallback: number): number {
  if (value === null || value.trim() === "") return fallback;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function topologyParam(value: string | null): TopologyMode {
  return value === "land" || value === "sea" || value === "full" ? value : "full";
}

function generateDebugHtml(url: URL): string {
  const seed = intParam(url.searchParams.get("seed"), 12345);
  const options: GenerateMapOptions = {
    width: intParam(url.searchParams.get("width"), 1000),
    height: intParam(url.searchParams.get("height"), 500),
    depth: intParam(url.searchParams.get("depth"), 4),
    topology: topologyParam(url.searchParams.get("topology")),
    weatherCoverageLimit: floatParam(url.searchParams.get("weatherCoverageLimit"), 0.25),
    debug: true,
  };
  return renderMapGenerationDebugHtml(generateMap(seed, options));
}

const port = intParam(argValue("port") ?? process.env.PORT ?? null, DEFAULT_PORT);
const host = argValue("host") ?? process.env.HOST ?? DEFAULT_HOST;

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `${host}:${port}`}`);

  if (url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (url.pathname !== "/") {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }

  try {
    const html = generateDebugHtml(url);
    res.writeHead(200, {
      "cache-control": "no-store",
      "content-type": "text/html; charset=utf-8",
    });
    res.end(html);
  } catch (error) {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end(error instanceof Error ? error.stack : String(error));
  }
});

server.listen(port, host, () => {
  console.log(`Terrain debug server listening on http://${host}:${port}`);
});
