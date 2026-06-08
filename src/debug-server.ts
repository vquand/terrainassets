import { createServer, type ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { URL } from "node:url";

import {
  generateMap,
  renderMapGenerationDebugHtml,
  type GenerateMapOptions,
  type TileShape,
  type TopologyMode,
  type WeatherType,
} from "./mapgen.js";

const DEFAULT_PORT = 5999;
const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_DEBUG_WIDTH = 180;
const DEFAULT_DEBUG_HEIGHT = 100;
const SPRITES_ROOT = path.resolve("sprites");

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

function tileShapeParam(value: string | null): TileShape {
  return value === "square" || value === "hex" ? value : "hex";
}

function weatherTypeParam(value: string | null): WeatherType | undefined {
  return value === "RAIN" ||
    value === "STORM" ||
    value === "TORNADO" ||
    value === "DEADLY_TORNADO" ||
    value === "BURNING_GROUND" ||
    value === "EVIL_BURNING_GROUND"
    ? value
    : undefined;
}

function generateDebugHtml(url: URL): string {
  const seed = intParam(url.searchParams.get("seed"), 12345);
  const weatherType = weatherTypeParam(url.searchParams.get("weatherType"));
  const weatherCoverageLimit = url.searchParams.has("weatherCoverageLimit")
    ? floatParam(url.searchParams.get("weatherCoverageLimit"), 0.035)
    : undefined;
  const options: GenerateMapOptions = {
    width: intParam(url.searchParams.get("width"), DEFAULT_DEBUG_WIDTH),
    height: intParam(url.searchParams.get("height"), DEFAULT_DEBUG_HEIGHT),
    depth: intParam(url.searchParams.get("depth"), 4),
    topology: topologyParam(url.searchParams.get("topology")),
    tileShape: tileShapeParam(url.searchParams.get("tileShape")),
    roadDensity: floatParam(url.searchParams.get("roadDensity"), 0.09642857142857142),
    blockedSeaRatio: floatParam(url.searchParams.get("blockedSeaRatio"), 0.2),
    blockedLandRatio: floatParam(url.searchParams.get("blockedLandRatio"), 0.1),
    ...(weatherCoverageLimit !== undefined ? { weatherCoverageLimit } : {}),
    ...(weatherType ? { weatherType } : {}),
    debug: true,
  };
  return renderMapGenerationDebugHtml(generateMap(seed, options));
}

async function serveSprite(pathname: string, res: ServerResponse): Promise<void> {
  const relativePath = decodeURIComponent(pathname.replace(/^\/sprites\/?/, ""));
  const filePath = path.resolve(SPRITES_ROOT, relativePath);
  if (!filePath.startsWith(`${SPRITES_ROOT}${path.sep}`)) {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    res.end("Forbidden");
    return;
  }

  try {
    const file = await stat(filePath);
    if (!file.isFile()) throw new Error("Not a file");
    res.writeHead(200, {
      "cache-control": "public, max-age=300",
      "content-length": file.size,
      "content-type": "image/png",
    });
    createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Sprite not found");
  }
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

  if (url.pathname.startsWith("/sprites/")) {
    void serveSprite(url.pathname, res);
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
