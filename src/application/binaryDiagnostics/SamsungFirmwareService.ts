import { isAbsolute, resolve } from "node:path";
import type { ExecutionOptions } from "../AnalysisProvider.js";
import type { SamsungFirmwarePort } from "./SamsungFirmwarePort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
} from "../../domain/analysisErrorCore.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import {
  extractSamsungFirmwareInputSchema,
  inspectSamsungFirmwareInputSchema,
  samsungFirmwareExtractionSchema,
  samsungFirmwareSchema,
  type SamsungFirmware,
  type SamsungFirmwareEntry,
} from "../../domain/firmware/samsungFirmware.js";
import {
  SAMSUNG_METADATA_BYTES,
  samsungMetadataByteCount,
} from "../../domain/firmware/samsungFirmwareBudget.js";
import { analysisInputErrorFromIssues } from "../../domain/inputIssueProjection.js";
import { err, ok, type Result } from "../../domain/result.js";

/** Shared strict CLI/MCP boundary; adapters own source reads and publication. */
export class SamsungFirmwareService {
  constructor(readonly provider: SamsungFirmwarePort) {}

  close(): Promise<void> {
    return this.provider.close();
  }

  async inspect(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    const operation = "inspect_samsung_firmware";
    if (options?.signal?.aborted)
      return err(new AnalysisCancelledError(operation));
    const input = inspectSamsungFirmwareInputSchema.safeParse(rawInput);
    if (!input.success)
      return err(
        analysisInputErrorFromIssues(operation, input.error.issues, rawInput, {
          cause: input.error,
        }),
      );
    if (!isAbsolute(input.data.path))
      return err(absolutePathError(operation, "path"));
    const result = await this.provider.inspect(input.data, options);
    if (!result.ok) return result;
    if (options?.signal?.aborted)
      return err(new AnalysisCancelledError(operation));
    if (!metadataFits(result.value))
      return err(
        new AnalysisOutputError(
          operation,
          "Samsung firmware report exceeds the complete metadata budget.",
        ),
      );
    const parsed = samsungFirmwareSchema.safeParse(result.value);
    if (
      !parsed.success ||
      parsed.data.artifact.path !== input.data.path ||
      !validSamsungFirmwareReport(
        parsed.data,
        input.data.max_entries,
        input.data.max_file_bytes,
      )
    )
      return err(
        new AnalysisOutputError(
          operation,
          "Samsung firmware provider returned malformed output or changed source identity/ranges.",
        ),
      );
    const report = parsed.data;
    return ok(
      createEvidence(
        {
          path: report.artifact.path,
          format: "samsung-tar-md5",
          sha256: report.artifact.sha256,
        },
        this.provider.identity,
        {
          operation,
          parameters: input.data,
          result: report,
          confidence: "observed",
          limitations: report.limitations,
          locations: [{ kind: "artifact-path", path: report.artifact.path }],
        },
      ),
    );
  }

  async extract(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    const operation = "extract_samsung_firmware";
    if (options?.signal?.aborted)
      return err(new AnalysisCancelledError(operation));
    const input = extractSamsungFirmwareInputSchema.safeParse(rawInput);
    if (!input.success)
      return err(
        analysisInputErrorFromIssues(operation, input.error.issues, rawInput, {
          cause: input.error,
        }),
      );
    for (const field of ["path", "output_root"] as const)
      if (!isAbsolute(input.data[field]))
        return err(absolutePathError(operation, field));
    const result = await this.provider.extract(input.data, options);
    if (!result.ok) return result;
    // Publication and the last cancellation check belong to the provider; a
    // later cancellation cannot turn a durably published export into no result.
    if (!metadataFits(result.value, true))
      return err(
        new AnalysisOutputError(
          operation,
          "Samsung firmware export exceeds the complete metadata budget.",
        ),
      );
    const parsed = samsungFirmwareExtractionSchema.safeParse(result.value);
    if (
      !parsed.success ||
      parsed.data.inventory.artifact.path !== input.data.path ||
      resolve(parsed.data.output_root) !== resolve(input.data.output_root) ||
      !validSamsungFirmwareReport(
        parsed.data.inventory,
        input.data.max_entries,
        input.data.max_file_bytes,
      ) ||
      parsed.data.inventory.integrity.status !== "match"
    )
      return err(
        new AnalysisOutputError(
          operation,
          "Samsung firmware export returned malformed output or changed source/output identity.",
        ),
      );
    const report = parsed.data;
    const entries = report.inventory.entries.filter(
      (entry) => entry.kind === "file",
    );
    if (
      report.files.length !== entries.length ||
      !report.files.every((file, index) => {
        const entry = entries[index];
        return (
          entry !== undefined &&
          file.entry_index === entry.index &&
          file.relative_path === entry.path &&
          file.bytes_written === entry.payload.location.bytes &&
          file.sha256 === entry.payload.sha256
        );
      }) ||
      new Set(report.files.map((file) => file.relative_path)).size !==
        report.files.length
    )
      return err(
        new AnalysisOutputError(
          operation,
          "Samsung firmware export files do not match the complete inventory.",
        ),
      );
    return ok(
      createEvidence(
        {
          path: report.inventory.artifact.path,
          format: "samsung-tar-md5",
          sha256: report.inventory.artifact.sha256,
        },
        this.provider.identity,
        {
          operation,
          parameters: input.data,
          result: report,
          confidence: "observed",
          limitations: report.inventory.limitations,
          locations: [
            { kind: "artifact-path", path: report.inventory.artifact.path },
            { kind: "artifact-path", path: report.output_root },
          ],
        },
      ),
    );
  }
}

/** Cross-field consistency only; raw TAR interpretation remains adapter-owned. */
export const validSamsungFirmwareReport = (
  report: SamsungFirmware,
  maxEntries: number,
  maxBytes: number,
): boolean => {
  const { coverage } = report;
  if (
    report.artifact.bytes > maxBytes ||
    report.entries.length > maxEntries ||
    coverage.headers !== report.entries.length ||
    coverage.files !==
      report.entries.filter((entry) => entry.kind === "file").length ||
    coverage.source_bytes_hashed !== report.artifact.bytes ||
    !validTarExtent(report) ||
    !validFooter(report)
  )
    return false;
  let nextHeader = 0;
  const paths = new Set<string>();
  for (const [index, entry] of report.entries.entries()) {
    if (
      entry.index !== index ||
      paths.has(entry.path) ||
      entry.path === "manifest.json" ||
      entry.path === "__samsung_footer.bin" ||
      !validEntryLayout(entry, nextHeader, report.artifact.bytes)
    )
      return false;
    paths.add(entry.path);
    nextHeader = rangeEnd(entry.padding_location);
  }
  return report.zero_terminator.offset === nextHeader;
};

type ByteRange = { offset: number; bytes: number };
const rangeEnd = (range: ByteRange) => range.offset + range.bytes;
const inside = (range: ByteRange, bytes: number) =>
  range.offset <= bytes - range.bytes;

const validTarExtent = (report: SamsungFirmware): boolean =>
  report.tar_location.offset === 0 &&
  report.tar_location.bytes % 512 === 0 &&
  report.zero_terminator.bytes === 1024 &&
  report.padding_location.offset === rangeEnd(report.zero_terminator) &&
  report.padding_location.bytes % 512 === 0 &&
  rangeEnd(report.padding_location) === report.tar_location.bytes &&
  [report.tar_location, report.zero_terminator, report.padding_location].every(
    (range) => inside(range, report.artifact.bytes),
  );

const validFooter = (report: SamsungFirmware): boolean => {
  const { footer, integrity } = report;
  return (
    footer.location.offset === report.tar_location.bytes &&
    rangeEnd(footer.location) === report.artifact.bytes &&
    footer.raw_hex.length / 2 === footer.location.bytes &&
    Buffer.from(footer.raw_hex, "hex").toString("latin1") === footer.text &&
    (footer.declared_tar_bytes === null ||
      footer.declared_tar_bytes === report.tar_location.bytes) &&
    footer.checksum_filename.length > 0 &&
    footer.checksum_record_location.bytes >= 35 &&
    footer.checksum_record_location.offset >= footer.location.offset &&
    rangeEnd(footer.checksum_record_location) === report.artifact.bytes &&
    integrity.checksum_range.offset === 0 &&
    rangeEnd(integrity.checksum_range) ===
      footer.checksum_record_location.offset &&
    integrity.status ===
      (integrity.declared_md5 === integrity.calculated_md5
        ? "match"
        : "mismatch") &&
    [
      footer.location,
      footer.checksum_record_location,
      integrity.checksum_range,
    ].every((range) => inside(range, report.artifact.bytes))
  );
};

const validEntryLayout = (
  entry: SamsungFirmwareEntry,
  nextHeader: number,
  bytes: number,
): boolean =>
  entry.header.location.offset === nextHeader &&
  entry.header.location.bytes === 512 &&
  entry.payload.location.offset === rangeEnd(entry.header.location) &&
  entry.padding_location.offset === rangeEnd(entry.payload.location) &&
  entry.padding_location.bytes ===
    (512 - (entry.payload.location.bytes % 512)) % 512 &&
  entry.header.declared_checksum === entry.header.calculated_checksum &&
  entry.name_raw_hex.length === 200 &&
  (entry.header_format === "gnu"
    ? entry.prefix_raw_hex === null
    : entry.prefix_raw_hex?.length === 310) &&
  (entry.kind === "directory"
    ? entry.typeflag === 53 && entry.payload.location.bytes === 0
    : entry.typeflag !== 53) &&
  [entry.header.location, entry.payload.location, entry.padding_location].every(
    (range) => inside(range, bytes),
  );

const absolutePathError = (operation: string, field: string) =>
  new AnalysisInputError(operation, undefined, [
    {
      path: [field],
      reason: "invalid_format",
      message: "Expected an absolute filesystem path on this host.",
    },
  ]);

const metadataFits = (value: unknown, newline = false): boolean => {
  try {
    return (
      samsungMetadataByteCount(value) + (newline ? 1 : 0) <=
      SAMSUNG_METADATA_BYTES
    );
  } catch {
    return false;
  }
};
