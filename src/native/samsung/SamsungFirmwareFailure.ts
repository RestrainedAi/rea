import { SAMSUNG_FIRMWARE_PROVIDER } from "../../application/InvestigationProviders.js";
import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import { inspectionFailure } from "../../artifacts/inspectionFailure.js";
import {
  AnalysisError,
  type AnalysisPartialObservation,
} from "../../domain/analysisErrorBase.js";
import { analysisErrorWithCleanupFailure } from "../../domain/analysisErrorCleanup.js";
import {
  AnalysisAccessDeniedError,
  AnalysisArtifactChangedError,
  AnalysisCancelledError,
} from "../../domain/analysisErrorCore.js";
import { ArtifactOperationError } from "../../domain/artifactOperationError.js";
import type { InspectSamsungFirmwareInput } from "../../domain/firmware/samsungFirmware.js";
import { ProviderCleanupError } from "../../domain/providerCleanupError.js";
import type { SamsungFirmwareOperation } from "./SamsungFirmwareSource.js";

/** Preserve errors already attributed by the source or output owner. */
export const samsungFirmwareFailure = (
  cause: unknown,
  input: InspectSamsungFirmwareInput,
  operation: SamsungFirmwareOperation,
  signal?: AbortSignal,
): AnalysisError =>
  cause instanceof AnalysisError
    ? cause
    : inspectionFailure(
        cause,
        input,
        operation,
        "Samsung firmware package",
        signal,
      );

/** Native descriptor failures belong to the admitted source, never the output tree. */
export const samsungSourceReadFailure = (
  cause: unknown,
  operation: SamsungFirmwareOperation,
  path: string,
): AnalysisError => {
  if (cause instanceof AnalysisError) return cause;
  if (cause instanceof Error && "code" in cause) {
    if (cause.code === "EACCES" || cause.code === "EPERM")
      return new AnalysisAccessDeniedError(operation, path, cause.code, {
        cause,
      });
    if (
      cause.code === "ENOENT" ||
      cause.code === "ENOTDIR" ||
      cause.code === "ESTALE"
    )
      return new AnalysisArtifactChangedError(
        operation,
        path,
        "The admitted Samsung firmware source is no longer available at its selected path.",
        { cause },
      );
  }
  return new ArtifactOperationError(
    operation,
    "io",
    undefined,
    cause instanceof Error
      ? cause.message
      : "Samsung firmware source read failed.",
    { cause },
  );
};

/** Output write/readback failures must not claim that the selected source changed. */
export const samsungOutputFailure = (
  cause: unknown,
  signal?: AbortSignal,
): AnalysisError => {
  if (cause instanceof AnalysisError) return cause;
  const options =
    cause instanceof ArtifactReaderFailure
      ? {
          cause,
          cleanup: cause.cleanup,
          partialObservation: cause.partialObservation,
        }
      : { cause };
  if (
    signal?.aborted ||
    (cause instanceof ArtifactReaderFailure && cause.reason === "cancelled")
  )
    return new AnalysisCancelledError("extract_samsung_firmware", options);
  return new ArtifactOperationError(
    "extract_samsung_firmware",
    cause instanceof ArtifactReaderFailure ? cause.reason : "io",
    cause instanceof ArtifactReaderFailure ? cause.details : undefined,
    cause instanceof Error ? cause.message : "Samsung firmware output failed.",
    options,
  );
};

/** Keep typed primary failures, complete observations and every failed cleanup owner. */
export const samsungFailureWithCleanup = (
  primary: unknown,
  cleanupCause: unknown,
  context: {
    readonly operation: SamsungFirmwareOperation;
    readonly resource: string;
    readonly partialObservation?: AnalysisPartialObservation;
  },
): AnalysisError | ArtifactReaderFailure => {
  const cleanup = ArtifactReaderFailure.cleanupObservation(
    cleanupCause,
    context.resource,
  );
  if (!(primary instanceof AnalysisError))
    return ArtifactReaderFailure.withCleanup(
      primary,
      cleanup,
      context.partialObservation,
    );
  if (context.partialObservation !== undefined)
    primary.retainPartialObservation(context.partialObservation);
  if (primary instanceof AnalysisCancelledError)
    return new AnalysisCancelledError(context.operation, {
      cause: primary,
      cleanup: {
        reason: [primary.cleanup?.reason, cleanup.reason]
          .filter((reason) => reason !== undefined)
          .join("; "),
        resources: [
          ...new Set([...primary.cleanupResources, ...cleanup.resources]),
        ],
      },
      ...(primary.partialObservation === undefined
        ? {}
        : { partialObservation: primary.partialObservation }),
      ...(primary.capturedOutput === undefined
        ? {}
        : { capturedOutput: primary.capturedOutput }),
    });
  return analysisErrorWithCleanupFailure(
    primary,
    new ProviderCleanupError(
      SAMSUNG_FIRMWARE_PROVIDER.id,
      cleanup.resources,
      { reason: cleanup.reason },
      { cause: cleanupCause, operation: context.operation },
    ),
    context.operation,
  );
};
