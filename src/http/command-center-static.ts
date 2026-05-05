import { createReadStream, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { createLogger } from "../logger.js";

const log = createLogger("http.command-center-static");

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicRoot = join(__dirname, "../../public");

type StaticEntry = { url: string; relativePath: string; contentType: string };

const PUBLIC_FILES: StaticEntry[] = [
  {
    url: "/command-center.html",
    relativePath: "command-center.html",
    contentType: "text/html; charset=utf-8",
  },
  {
    url: "/assets/js/command-center.js",
    relativePath: "assets/js/command-center.js",
    contentType: "application/javascript; charset=utf-8",
  },
  {
    url: "/assets/css/command-center.css",
    relativePath: "assets/css/command-center.css",
    contentType: "text/css; charset=utf-8",
  },
  {
    url: "/images/BrooksWimer_Logo.png",
    relativePath: "images/BrooksWimer_Logo.png",
    contentType: "image/png",
  },
];

/**
 * Serves the command-center dashboard shell from `public/` so the same host as the API
 * can load https://maverick.example.com/command-center.html (tunnel + Access).
 */
export function registerCommandCenterStaticRoutes(app: FastifyInstance): void {
  app.get("/", async (_req, reply) => {
    reply.redirect("/command-center.html");
  });

  for (const entry of PUBLIC_FILES) {
    app.get(entry.url, async (_req, reply) => {
      const absolutePath = join(publicRoot, entry.relativePath);
      if (!existsSync(absolutePath)) {
        log.error({ path: absolutePath }, "Command center static file missing");
        reply.code(404);
        return { error: "Not Found", message: `Missing ${entry.relativePath}` };
      }
      reply.type(entry.contentType);
      return reply.send(createReadStream(absolutePath));
    });
  }
}
