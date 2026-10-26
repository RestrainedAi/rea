import { ArtifactReaderFailure } from "./ArtifactReader.js";
import { ArtifactOperationError } from "../domain/artifactOperationError.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisAccessDeniedError,
  AnalysisArtifactChangedError,
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
} from "../domain/analysisErrorCore.js";

/** One error owner for the portable PE and Palm stable-file inspection boundary. */
export const inspectionFailure = (
  cause: unknown,
  input: {
    readonly path: string;
    readonly max_file_bytes: number;
    readonly max_entries: number;
  },
  operation:
    | "inspect_pe_resources"
    | "inspect_palm_resources"
    | "extract_palm_resources"
    | "inspect_samsung_firmware"
    | "extract_samsung_firmware",
  description: string,
  signal?: AbortSignal,
) => {
  const options =
    cause instanceof ArtifactReaderFailure
      ? {
          cause,
          cleanup: cause.cleanup,
          partialObservation: cause.partialObservation,
        }
      : { cause };
  if (signal?.aborted) return new AnalysisCancelledError(operation, options);
  if (cause instanceof AnalysisError) return cause;
  if (cause instanceof ArtifactReaderFailure) {
    if (cause.reason === "limit")
      return new AnalysisResourceConstraintError(
        operation,
        "memory",
        cause.message,
        {
          max_file_bytes: input.max_file_bytes,
          max_entries: input.max_entries,
        },
        options,
      );
    if (cause.reason === "integrity")
      return new AnalysisArtifactChangedError(
        operation,
        input.path,
        cause.message,
        options,
      );
    if (cause.reason === "path" || cause.reason === "format")
      return new AnalysisInputError(operation, options, [
        { path: ["path"], reason: "invalid_format", message: cause.message },
      ]);
    if (cause.reason === "cancelled")
      return new AnalysisCancelledError(operation, options);
  }
  if (cause instanceof Error && "code" in cause) {
    if (cause.code === "EACCES" || cause.code === "EPERM")
      return new AnalysisAccessDeniedError(
        operation,
        input.path,
        cause.code,
        options,
      );
    if (cause.code === "ENOENT" || cause.code === "ENOTDIR")
      return new AnalysisInputError(operation, options, [
        {
          path: ["path"],
          reason: "invalid_value",
          message: `Selected ${description} could not be read (${cause.code}): ${input.path}.`,
        },
      ]);
  }
  return new ArtifactOperationError(
    operation,
    cause instanceof ArtifactReaderFailure ? cause.reason : "io",
    undefined,
    cause instanceof Error
      ? cause.message
      : `${description} inspection failed.`,
    options,
  );
};
