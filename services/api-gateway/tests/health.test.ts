import { describe, it, expect } from "vitest";
import { buildServer } from "../src/server.js";

describe("GET /v1/health", () => {
  it("returns 200 with status ok", async () => {
    const app = await buildServer();
    const res = await app.inject({ method: "GET", url: "/v1/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok" });
    await app.close();
  });
});
