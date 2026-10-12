import { describe, expect, it } from "vitest";
import { PALM_RESOURCES_PROVIDER } from "../InvestigationProviders.js";
import { ok } from "../../domain/result.js";
import { PalmResourcesService } from "./PalmResourcesService.js";
import { palmResourcesReportFixture } from "./PalmResources.fixture.js";
import type { PalmResources } from "../../domain/native/palmResources.js";

const service = (report: PalmResources) =>
  new PalmResourcesService({
    identity: PALM_RESOURCES_PROVIDER,
    inspect: async () => ok(report),
  });
describe("Palm resource Evidence boundary", () => {
  it("retains artifact identity and complete original-file ranges", async () => {
    const report = palmResourcesReportFixture();
    const result = await service(report).inspect({
      path: report.artifact.path,
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        operation: "inspect_palm_resources",
        normalized_result: report,
        confidence: "observed",
      },
    });
  });
  it.each([
    [
      "gap in header",
      (r: PalmResources) => {
        r.directory_gap.location.offset = 0;
      },
    ],
    [
      "gap through appInfo",
      (r: PalmResources) => {
        r.directory_gap.location.bytes = 4;
      },
    ],
    [
      "missing declared appInfo",
      (r: PalmResources) => {
        r.app_info = null;
      },
    ],
    [
      "appInfo in header",
      (r: PalmResources) => {
        r.app_info!.location.offset = 10;
      },
    ],
    [
      "appInfo beyond sortInfo",
      (r: PalmResources) => {
        r.app_info!.location.bytes = 3;
      },
    ],
    [
      "sortInfo in resource",
      (r: PalmResources) => {
        r.sort_info!.location.offset = 95;
      },
    ],
    [
      "unexpected sortInfo",
      (r: PalmResources) => {
        r.header.sort_info_offset = 0;
      },
    ],
    [
      "resource outside file",
      (r: PalmResources) => {
        r.resources[0]!.payload.location.bytes = 7;
      },
    ],
    [
      "wrong count",
      (r: PalmResources) => {
        r.header.resource_count = 2;
      },
    ],
    [
      "wrong artifact path",
      (r: PalmResources) => {
        r.artifact.path = "/another.prc";
      },
    ],
  ] as const)("rejects malformed parsed output: %s", async (_name, mutate) => {
    const report = palmResourcesReportFixture();
    mutate(report);
    const result = await service(report).inspect({
      path: "/fixtures/example.prc",
    });
    expect(result).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisOutputError" },
    });
  });
  it("rejects a relative path and cancellation before using a provider", async () => {
    const report = palmResourcesReportFixture();
    expect(
      await service(report).inspect({ path: "relative.prc" }),
    ).toMatchObject({ ok: false, error: { _tag: "AnalysisInputError" } });
    const controller = new AbortController();
    controller.abort();
    expect(
      await service(report).inspect(
        { path: report.artifact.path },
        { signal: controller.signal },
      ),
    ).toMatchObject({ ok: false, error: { _tag: "AnalysisCancelledError" } });
  });
});
