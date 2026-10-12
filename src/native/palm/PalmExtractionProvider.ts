import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { readStableArtifact } from "../../artifacts/readStableArtifact.js";
import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import { SafeOutputTree } from "../../artifacts/SafeOutputTree.js";
import { SafeOutputTreeCreationFailure } from "../../artifacts/SafeOutputTreeCreationFailure.js";
import { inspectionFailure } from "../../artifacts/inspectionFailure.js";
import type { PalmExtractionPort } from "../../application/binaryDiagnostics/PalmExtractionPort.js";
import type { ExecutionOptions } from "../../application/AnalysisProvider.js";
import { PALM_RESOURCES_PROVIDER } from "../../application/InvestigationProviders.js";
import {
  palmExtractionSchema,
  palmResourceExportPath,
  type ExtractPalmResourcesInput,
  type PalmExtraction,
} from "../../domain/native/palmResources.js";
import { err, ok } from "../../domain/result.js";
import { parsePalmResources } from "./PalmResourceParser.js";
import { palmMetadataBytes } from "./PalmSerializationBudget.js";

/** Raw resource export from the same stable snapshot used for directory inspection. */
export class PalmExtractionProvider implements PalmExtractionPort {
  readonly identity = PALM_RESOURCES_PROVIDER;
  readonly #resources = new ArtifactResourceScope();
  close(): Promise<void> {
    return this.#resources.close();
  }
  async extract(input: ExtractPalmResourcesInput, options?: ExecutionOptions) {
    try {
      return ok(
        await this.#resources.run(() => this.#extract(input, options?.signal)),
      );
    } catch (cause) {
      return err(
        inspectionFailure(
          cause,
          input,
          "extract_palm_resources",
          "Palm resource export",
          options?.signal,
        ),
      );
    }
  }
  async #extract(
    input: ExtractPalmResourcesInput,
    signal?: AbortSignal,
  ): Promise<PalmExtraction> {
    const snapshot = await readStableArtifact(
      input.path,
      input.max_file_bytes,
      signal,
    );
    const inventory = await parsePalmResources(
      snapshot.bytes,
      {
        path: input.path,
        bytes: snapshot.bytes.length,
        sha256: snapshot.sha256,
      },
      input,
      signal,
    );
    const files = inventory.resources.map((resource) => ({
      resource_index: resource.index,
      relative_path: palmResourceExportPath(resource),
      sha256: resource.payload.sha256,
      bytes_written: resource.payload.location.bytes,
    }));
    const planned = {
      inventory,
      output_root: input.output_root,
      manifest_relative_path: "manifest.json" as const,
      files,
    };
    palmMetadataBytes(planned);
    let output: SafeOutputTree | undefined;
    let completed: PalmExtraction | undefined;
    try {
      signal?.throwIfAborted();
      try {
        output = await SafeOutputTree.create(input.output_root);
      } catch (cause) {
        if (cause instanceof SafeOutputTreeCreationFailure) output = cause.tree;
        throw cause;
      }
      for (const file of files) {
        const resource = inventory.resources[file.resource_index]!;
        const { offset, bytes } = resource.payload.location;
        await output.write(
          file.relative_path,
          Readable.from([snapshot.bytes.subarray(offset, offset + bytes)]),
          { sha256: file.sha256, bytes },
          signal,
        );
      }
      completed = palmExtractionSchema.parse({
        ...planned,
        output_root: input.output_root,
      });
      const manifest = Buffer.from(JSON.stringify(completed) + "\n");
      await output.write(
        "manifest.json",
        Readable.from([manifest]),
        {
          bytes: manifest.length,
          sha256: createHash("sha256").update(manifest).digest("hex"),
        },
        signal,
      );
      signal?.throwIfAborted();
      await output.commit();
      return completed;
    } catch (cause) {
      if (output !== undefined) {
        const attempt = await this.#resources.release({
          kind: "output-tree",
          tree: output,
          resource: input.output_root,
        });
        if (attempt.kind === "failed")
          throw ArtifactReaderFailure.withCleanup(
            cause,
            ArtifactReaderFailure.cleanupObservation(
              attempt.cause,
              input.output_root,
            ),
            output.published && completed !== undefined
              ? { kind: "palm-extraction", extraction: completed }
              : undefined,
          );
        if (output.published && completed !== undefined) return completed;
      }
      throw cause;
    }
  }
}
