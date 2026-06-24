import { describe, it, expect } from "vitest";
import { applyStreamEvent } from "./stream-machine.js";

describe("applyStreamEvent", () => {
  it("provisioning -> awaiting_ingest on ready", () => {
    expect(applyStreamEvent("provisioning", "ready")).toEqual({ next: "awaiting_ingest", terminal: false });
  });
  it("awaiting_ingest -> active on ingest_started", () => {
    expect(applyStreamEvent("awaiting_ingest", "ingest_started")).toEqual({ next: "active", terminal: false });
  });
  it("active -> ended on ingest_ended", () => {
    expect(applyStreamEvent("active", "ingest_ended")).toEqual({ next: "ended", terminal: false });
  });
  it("ending -> ended on ingest_ended", () => {
    expect(applyStreamEvent("ending", "ingest_ended")).toEqual({ next: "ended", terminal: false });
  });
  it("ended -> archived", () => {
    expect(applyStreamEvent("ended", "archived")).toEqual({ next: "archived", terminal: true });
  });
  it("any -> failed", () => {
    expect(applyStreamEvent("active", "failed")).toEqual({ next: "failed", terminal: true });
    expect(applyStreamEvent("provisioning", "failed")).toEqual({ next: "failed", terminal: true });
  });
  it("rejects invalid transitions", () => {
    expect(() => applyStreamEvent("archived", "ready")).toThrow(/invalid transition/i);
    expect(() => applyStreamEvent("ended", "ingest_started")).toThrow(/invalid transition/i);
  });
});
