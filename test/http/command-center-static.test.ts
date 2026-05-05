import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { registerCommandCenterStaticRoutes } from "../../src/http/command-center-static.js";

describe("command center static routes", () => {
  it("serves GET /command-center.html", async () => {
    const app = Fastify({ logger: false });
    registerCommandCenterStaticRoutes(app);
    await app.ready();

    const response = await app.inject({ method: "GET", url: "/command-center.html" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toMatch(/text\/html/);
    expect(response.body).toContain("Command Center");
    await app.close();
  });

  it("redirects GET / to command-center.html", async () => {
    const app = Fastify({ logger: false });
    registerCommandCenterStaticRoutes(app);
    await app.ready();

    const response = await app.inject({ method: "GET", url: "/" });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("/command-center.html");
    await app.close();
  });
});
