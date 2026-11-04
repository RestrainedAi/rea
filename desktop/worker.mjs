import { createDirectAnalysis } from "../dist/composition/directAnalysis.js";
import {
  createPalmResourcesService,
  createPalmExtractionService,
  createSamsungFirmwareService,
} from "../dist/composition/binaryDiagnostics.js";
import { projectAnalysisError } from "../dist/domain/analysisErrorProjection.js";

let controller;
let cancelRequested = false;
let busy = false;
const send = (message) =>
  new Promise((resolve) => {
    if (!process.connected) return resolve();
    process.send(message, () => resolve());
  });
process.on("message", async (message) => {
  if (message.type === "cancel") {
    cancelRequested = true;
    controller?.abort("Cancelled from REA Workbench");
    return;
  }
  if (message.type !== "run" || busy) return;
  busy = true;
  controller = new AbortController();
  if (cancelRequested) controller.abort("Cancelled from REA Workbench");
  let service;
  let evidence;
  let failure;
  try {
    const { source, action, outputRoot } = message;
    if (!source || !["inspect", "extract", "native"].includes(action))
      throw new Error("Invalid desktop workflow.");
    await send({
      type: "phase",
      phase:
        action === "extract"
          ? "Extracting and verifying saved files"
          : action === "native"
            ? "Analyzing native code with Ghidra"
            : "Inspecting source bytes and recording findings",
    });
    if (source.kind === "samsung") {
      service = createSamsungFirmwareService();
      const result = await service[
        action === "extract" ? "extract" : "inspect"
      ](
        {
          path: source.path,
          ...(action === "extract" ? { output_root: outputRoot } : {}),
        },
        { signal: controller.signal },
      );
      if (!result.ok) throw result.error;
      evidence = result.value;
    } else if (source.kind === "palm") {
      service =
        action === "extract"
          ? createPalmExtractionService()
          : createPalmResourcesService();
      const result = await service[
        action === "extract" ? "extract" : "inspect"
      ](
        {
          path: source.path,
          ...(action === "extract" ? { output_root: outputRoot } : {}),
        },
        { signal: controller.signal },
      );
      if (!result.ok) throw result.error;
      evidence = result.value;
    } else {
      const analysis = createDirectAnalysis(process.env);
      evidence =
        action === "native"
          ? await analysis.runDirectAnalysis(
              source.path,
              "binary_overview",
              {},
              { signal: controller.signal, providerId: "ghidra" },
            )
          : await analysis.runProviderAnalysis(
              source.path,
              action === "extract" ? "extract_artifact" : "inspect_artifact",
              {
                integrity_policy: "fail",
                ...(action === "extract" ? { output_root: outputRoot } : {}),
              },
              undefined,
              controller.signal,
            );
      if (evidence?.error) {
        failure = evidence.error;
        evidence = undefined;
      }
    }
  } catch (error) {
    try {
      failure = error._tag
        ? projectAnalysisError(error)
        : {
            code: "desktop_analysis_failed",
            message: error.message ?? String(error),
          };
    } catch {
      failure = {
        code: "desktop_analysis_failed",
        message: "REA could not complete this analysis.",
      };
    }
  } finally {
    if (typeof service?.close === "function")
      try {
        await service.close();
      } catch (error) {
        const cleanup = error._tag
          ? projectAnalysisError(error)
          : { message: error.message };
        failure = {
          code: "cleanup_incomplete",
          message:
            "Analysis cleanup needs attention. Complete observations are preserved.",
          cleanup,
          primary: failure ?? null,
        };
      }
  }
  const cancelled =
    failure &&
    (failure.code === "cancelled" ||
      failure.category === "cancellation" ||
      failure.code === "analysis_cancelled");
  await send({
    type: "result",
    outcome: {
      status: failure ? (cancelled ? "cancelled" : "failed") : "completed",
      evidence: evidence ?? null,
      error: failure ?? null,
    },
  });
  process.disconnect();
});
