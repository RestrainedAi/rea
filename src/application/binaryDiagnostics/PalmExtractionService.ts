import { isAbsolute, resolve } from "node:path";
import type { ExecutionOptions } from "../AnalysisProvider.js";
import type { PalmExtractionPort } from "./PalmExtractionPort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
} from "../../domain/analysisErrorCore.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import {
  extractPalmResourcesInputSchema,
  palmExtractionSchema,
  palmResourceExportPath,
} from "../../domain/native/palmResources.js";
import { analysisInputErrorFromIssues } from "../../domain/inputIssueProjection.js";
import { err, ok, type Result } from "../../domain/result.js";
import { validPalmResourcesReport } from "./PalmResourcesService.js";

/** Shared CLI/MCP export workflow; the provider owns publishing and rollback. */
export class PalmExtractionService {
  constructor(readonly provider: PalmExtractionPort) {}
  close(): Promise<void> {
    return this.provider.close();
  }
  async extract(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    const operation = "extract_palm_resources";
    if (options?.signal?.aborted)
      return err(new AnalysisCancelledError(operation));
    const input = extractPalmResourcesInputSchema.safeParse(rawInput);
    if (!input.success)
      return err(
        analysisInputErrorFromIssues(operation, input.error.issues, rawInput, {
          cause: input.error,
        }),
      );
    for (const field of ["path", "output_root"] as const)
      if (!isAbsolute(input.data[field]))
        return err(
          new AnalysisInputError(operation, undefined, [
            {
              path: [field],
              reason: "invalid_format",
              message: "Expected an absolute filesystem path on this host.",
            },
          ]),
        );
    const result = await this.provider.extract(input.data, options);
    if (!result.ok) return result;
    const report = palmExtractionSchema.safeParse(result.value);
    if (
      !report.success ||
      report.data.inventory.artifact.path !== input.data.path ||
      resolve(report.data.output_root) !== resolve(input.data.output_root) ||
      !validPalmResourcesReport(
        report.data.inventory,
        input.data.max_entries,
        input.data.max_file_bytes,
      ) ||
      report.data.files.length !== report.data.inventory.resources.length ||
      !report.data.files.every((file, index) => {
        const resource = report.data.inventory.resources[index];
        return (
          resource !== undefined &&
          file.resource_index === index &&
          file.relative_path === palmResourceExportPath(resource) &&
          file.sha256 === resource.payload.sha256 &&
          file.bytes_written === resource.payload.location.bytes
        );
      }) ||
      new Set(report.data.files.map((file) => file.relative_path)).size !==
        report.data.files.length
    )
      return err(
        new AnalysisOutputError(
          operation,
          "Palm resource export returned incomplete output or changed artifact/output identity.",
        ),
      );
    const value = report.data;
    return ok(
      createEvidence(
        {
          path: value.inventory.artifact.path,
          format: "palm-resource-database",
          sha256: value.inventory.artifact.sha256,
        },
        this.provider.identity,
        {
          operation,
          parameters: input.data,
          result: value,
          confidence: "observed",
          limitations: value.inventory.limitations,
          locations: [
            { kind: "artifact-path", path: value.inventory.artifact.path },
            { kind: "artifact-path", path: value.output_root },
          ],
        },
      ),
    );
  }
}
