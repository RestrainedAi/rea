import { isAbsolute } from "node:path";
import type { ExecutionOptions } from "../AnalysisProvider.js";
import type { PalmResourcesPort } from "./PalmResourcesPort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
} from "../../domain/analysisErrorCore.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import {
  inspectPalmResourcesInputSchema,
  palmResourcesSchema,
  type PalmResources,
} from "../../domain/native/palmResources.js";
import { analysisInputErrorFromIssues } from "../../domain/inputIssueProjection.js";
import { err, ok, type Result } from "../../domain/result.js";

export class PalmResourcesService {
  constructor(readonly provider: PalmResourcesPort) {}
  async inspect(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    const operation = "inspect_palm_resources";
    if (options?.signal?.aborted)
      return err(new AnalysisCancelledError(operation));
    const input = inspectPalmResourcesInputSchema.safeParse(rawInput);
    if (!input.success)
      return err(
        analysisInputErrorFromIssues(operation, input.error.issues, rawInput, {
          cause: input.error,
        }),
      );
    if (!isAbsolute(input.data.path))
      return err(
        new AnalysisInputError(operation, undefined, [
          {
            path: ["path"],
            reason: "invalid_format",
            message: "Expected an absolute filesystem path on this host.",
          },
        ]),
      );
    const result = await this.provider.inspect(input.data, options);
    if (!result.ok) return result;
    if (options?.signal?.aborted)
      return err(new AnalysisCancelledError(operation));
    const report = palmResourcesSchema.safeParse(result.value);
    if (
      !report.success ||
      report.data.artifact.path !== input.data.path ||
      !validPalmResourcesReport(
        report.data,
        input.data.max_entries,
        input.data.max_file_bytes,
      )
    )
      return err(
        new AnalysisOutputError(
          operation,
          "Palm resource provider returned malformed output or changed artifact identity.",
        ),
      );
    const value = report.data;
    return ok(
      createEvidence(
        {
          path: value.artifact.path,
          format: "palm-resource-database",
          sha256: value.artifact.sha256,
        },
        this.provider.identity,
        {
          operation,
          parameters: input.data,
          result: value,
          confidence: "observed",
          limitations: value.limitations,
          locations: [{ kind: "artifact-path", path: value.artifact.path }],
        },
      ),
    );
  }
}

export const validPalmResourcesReport = (
  report: PalmResources,
  maxEntries: number,
  maxBytes: number,
): boolean => {
  const inside = (range: { offset: number; bytes: number }) =>
    range.offset <= report.artifact.bytes - range.bytes;
  const directoryEnd = 78 + report.resources.length * 10;
  const firstResource =
    report.resources[0]?.payload.location.offset ?? report.artifact.bytes;
  const { app_info_offset: appOffset, sort_info_offset: sortOffset } =
    report.header;
  const blockMatches = (
    block: PalmResources["app_info"],
    offset: number,
    end: number,
  ) =>
    offset === 0
      ? block === null
      : block !== null &&
        block.location.offset === offset &&
        block.location.bytes === end - offset;
  if (
    [appOffset, sortOffset].some(
      (offset) =>
        offset !== 0 && (offset < directoryEnd || offset > firstResource),
    ) ||
    (appOffset !== 0 && sortOffset !== 0 && appOffset > sortOffset) ||
    !blockMatches(report.app_info, appOffset, sortOffset || firstResource) ||
    !blockMatches(report.sort_info, sortOffset, firstResource) ||
    report.directory_gap.location.offset !== directoryEnd ||
    report.directory_gap.location.bytes !==
      (appOffset || sortOffset || firstResource) - directoryEnd
  )
    return false;
  if (
    report.artifact.bytes > maxBytes ||
    report.header.attributes % 2 !== 1 ||
    report.header.next_record_list_offset !== 0 ||
    report.header.resource_count !== report.resources.length ||
    report.resources.length > maxEntries ||
    report.coverage.resources !== report.resources.length ||
    report.coverage.examined_entries !== report.resources.length ||
    report.header.location.offset !== 0 ||
    report.header.location.bytes !== 78 ||
    report.directory_location.offset !== 78 ||
    report.directory_location.bytes !== report.resources.length * 10 ||
    !inside(report.header.location) ||
    !inside(report.directory_location) ||
    !inside(report.directory_gap.location) ||
    [report.app_info, report.sort_info].some(
      (block) => block !== null && !inside(block.location),
    )
  )
    return false;
  const keys = new Set<string>();
  return report.resources.every((resource, index) => {
    const key = `${resource.type.raw_hex}:${String(resource.id)}`;
    if (keys.has(key)) return false;
    keys.add(key);
    const end =
      report.resources[index + 1]?.payload.location.offset ??
      report.artifact.bytes;
    return (
      resource.index === index &&
      resource.entry_location.offset === 78 + index * 10 &&
      resource.entry_location.bytes === 10 &&
      inside(resource.entry_location) &&
      inside(resource.payload.location) &&
      resource.payload.location.offset >= 78 + report.resources.length * 10 &&
      resource.payload.location.bytes ===
        end - resource.payload.location.offset &&
      (index === 0 ||
        resource.payload.location.offset >
          (report.resources[index - 1]?.payload.location.offset ?? 0))
    );
  });
};
