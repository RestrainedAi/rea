import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import type { ExecutionOptions } from "../../application/AnalysisProvider.js";
import { SAMSUNG_FIRMWARE_PROVIDER } from "../../application/InvestigationProviders.js";
import type { SamsungFirmwarePort } from "../../application/binaryDiagnostics/SamsungFirmwarePort.js";
import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import { SafeOutputTree } from "../../artifacts/SafeOutputTree.js";
import { SafeOutputTreeCreationFailure } from "../../artifacts/SafeOutputTreeCreationFailure.js";
import {
  AnalysisError,
  type AnalysisPartialObservation,
} from "../../domain/analysisErrorBase.js";
import { ArtifactOperationError } from "../../domain/artifactOperationError.js";
import { SAMSUNG_METADATA_BYTES } from "../../domain/firmware/samsungFirmwareBudget.js";
import {
  samsungFirmwareExtractionSchema,
  type ExtractSamsungFirmwareInput,
  type InspectSamsungFirmwareInput,
  type SamsungFirmware,
  type SamsungFirmwareExtraction,
} from "../../domain/firmware/samsungFirmware.js";
import { err, ok } from "../../domain/result.js";
import { inspectSamsungFirmwareSource } from "./SamsungFirmwareHash.js";
import { samsungMetadataBytes } from "./SamsungFirmwareBudget.js";
import {
  samsungFailureWithCleanup,
  samsungFirmwareFailure,
  samsungOutputFailure,
} from "./SamsungFirmwareFailure.js";
import {
  SamsungFirmwareSource,
  type SamsungFirmwareOperation,
} from "./SamsungFirmwareSource.js";

type CompleteObservation = SamsungFirmware | SamsungFirmwareExtraction;

/** Stable streamed source inspection and verified, operation-owned raw export. */
export class SamsungFirmwareProvider implements SamsungFirmwarePort {
  readonly identity = SAMSUNG_FIRMWARE_PROVIDER;
  readonly #resources = new ArtifactResourceScope();

  close(): Promise<void> {
    return this.#resources.close();
  }

  async inspect(
    input: InspectSamsungFirmwareInput,
    options?: ExecutionOptions,
  ) {
    try {
      return ok(
        await this.#resources.run(() =>
          this.#withSource(
            input,
            "inspect_samsung_firmware",
            options?.signal,
            async (source, retain) => {
              const inventory = await inspectSamsungFirmwareSource(
                source,
                input,
                options?.signal,
              );
              samsungMetadataBytes(inventory);
              retain(inventory);
              await source.close();
              options?.signal?.throwIfAborted();
              return inventory;
            },
          ),
        ),
      );
    } catch (cause) {
      return err(
        samsungFirmwareFailure(
          cause,
          input,
          "inspect_samsung_firmware",
          options?.signal,
        ),
      );
    }
  }

  async extract(
    input: ExtractSamsungFirmwareInput,
    options?: ExecutionOptions,
  ) {
    try {
      return ok(
        await this.#resources.run(() =>
          this.#withSource(
            input,
            "extract_samsung_firmware",
            options?.signal,
            (source, retain) =>
              this.#extract(source, input, retain, options?.signal),
          ),
        ),
      );
    } catch (cause) {
      return err(
        samsungFirmwareFailure(
          cause,
          input,
          "extract_samsung_firmware",
          options?.signal,
        ),
      );
    }
  }

  async #withSource<T>(
    input: InspectSamsungFirmwareInput,
    operation: SamsungFirmwareOperation,
    signal: AbortSignal | undefined,
    work: (
      source: SamsungFirmwareSource,
      retain: (value: CompleteObservation) => void,
    ) => Promise<T>,
  ): Promise<T> {
    const source = await SamsungFirmwareSource.open(
      input.path,
      input.max_file_bytes,
      this.#resources,
      operation,
      signal,
    );
    let observed: CompleteObservation | undefined;
    try {
      return await work(source, (value) => {
        observed = value;
      });
    } catch (cause) {
      let failure = cause;
      // Failed closes retain the exact owner in the scope. Retrying belongs
      // to a later scope drain, never this same operation.
      if (!source.closeAttempted) {
        try {
          await source.close();
        } catch (closeCause) {
          failure = samsungFailureWithCleanup(cause, closeCause, {
            resource: input.path,
            operation,
            ...(observed === undefined
              ? {}
              : { partialObservation: observation(observed, operation) }),
          });
        }
      }
      if (
        failure instanceof AnalysisError &&
        failure.cleanupIncomplete &&
        observed !== undefined
      )
        failure.retainPartialObservation(observation(observed, operation));
      if (
        failure instanceof ArtifactReaderFailure &&
        failure.cleanup !== undefined &&
        failure.partialObservation === undefined &&
        observed !== undefined
      )
        throw ArtifactReaderFailure.withCleanup(
          failure,
          failure.cleanup,
          observation(observed, operation),
        );
      throw failure;
    }
  }

  async #extract(
    source: SamsungFirmwareSource,
    input: ExtractSamsungFirmwareInput,
    retain: (value: CompleteObservation) => void,
    signal?: AbortSignal,
  ): Promise<SamsungFirmwareExtraction> {
    const inventory = await inspectSamsungFirmwareSource(source, input, signal);
    samsungMetadataBytes(inventory);
    retain(inventory);
    if (inventory.integrity.status !== "match")
      throw new ArtifactOperationError(
        "extract_samsung_firmware",
        "integrity",
        undefined,
        "Samsung firmware MD5 mismatch; no output was created.",
      );
    const { completed, manifest, footerHash } = planExport(input, inventory);
    let output: SafeOutputTree | undefined;
    try {
      signal?.throwIfAborted();
      try {
        output = await SafeOutputTree.create(input.output_root);
      } catch (cause) {
        if (cause instanceof SafeOutputTreeCreationFailure) output = cause.tree;
        throw cause;
      }
      for (const file of completed.files) {
        signal?.throwIfAborted();
        const entry = inventory.entries[file.entry_index]!;
        const { offset, bytes } = entry.payload.location;
        await output.write(
          file.relative_path,
          source.stream(offset, bytes, signal),
          { bytes, sha256: file.sha256 },
          signal,
        );
      }
      signal?.throwIfAborted();
      const footer = inventory.footer.location;
      await output.write(
        "__samsung_footer.bin",
        source.stream(footer.offset, footer.bytes, signal),
        { bytes: footer.bytes, sha256: footerHash },
        signal,
      );
      signal?.throwIfAborted();
      await output.write(
        "manifest.json",
        Readable.from([manifest]),
        {
          bytes: manifest.length,
          sha256: createHash("sha256").update(manifest).digest("hex"),
        },
        signal,
      );
      await source.verifyDigest(inventory.artifact.sha256, signal);
      await source.close();
      signal?.throwIfAborted();
      await output.commit();
      return completed;
    } catch (cause) {
      const failure = samsungOutputFailure(cause, signal);
      if (output !== undefined) {
        if (output.published) retain(completed);
        const released = await this.#resources.release({
          kind: "output-tree",
          tree: output,
          resource: input.output_root,
        });
        if (released.kind === "failed")
          throw samsungFailureWithCleanup(failure, released.cause, {
            resource: input.output_root,
            operation: "extract_samsung_firmware",
            partialObservation: observation(
              output.published ? completed : inventory,
              "extract_samsung_firmware",
            ),
          });
        if (output.published) return completed;
      }
      throw failure;
    }
  }
}

const planExport = (
  input: ExtractSamsungFirmwareInput,
  inventory: SamsungFirmware,
) => {
  const planned = {
    inventory,
    output_root: input.output_root,
    manifest_relative_path: "manifest.json" as const,
    footer_relative_path: "__samsung_footer.bin" as const,
    files: inventory.entries
      .filter((entry) => entry.kind === "file")
      .map((entry) => ({
        entry_index: entry.index,
        relative_path: entry.path,
        bytes_written: entry.payload.location.bytes,
        sha256: entry.payload.sha256,
      })),
  };
  if (samsungMetadataBytes(planned) + 1 > SAMSUNG_METADATA_BYTES)
    throw new ArtifactReaderFailure(
      "limit",
      "Samsung complete manifest plus newline exceeds the 8 MiB allocation budget.",
    );
  const completed = samsungFirmwareExtractionSchema.parse(planned);
  return {
    completed,
    manifest: Buffer.from(JSON.stringify(completed) + "\n"),
    footerHash: createHash("sha256")
      .update(Buffer.from(inventory.footer.raw_hex, "hex"))
      .digest("hex"),
  };
};

const observation = (
  result: CompleteObservation,
  operation: SamsungFirmwareOperation,
): AnalysisPartialObservation => ({
  kind: "firmware",
  result,
  provenance: { operation, provider: SAMSUNG_FIRMWARE_PROVIDER },
});
