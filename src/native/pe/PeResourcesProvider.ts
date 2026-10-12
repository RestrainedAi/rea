import { readStableArtifact } from "../../artifacts/readStableArtifact.js";
import { inspectionFailure } from "../../artifacts/inspectionFailure.js";
import type { PeResourcesPort } from "../../application/binaryDiagnostics/PeResourcesPort.js";
import type { ExecutionOptions } from "../../application/AnalysisProvider.js";
import type { InspectPeResourcesInput } from "../../domain/native/peResources.js";
import { err, ok } from "../../domain/result.js";
import { PE_RESOURCES_PROVIDER } from "../../application/InvestigationProviders.js";
import { parsePeResources } from "./PeResourceParser.js";

/** Portable parser over one bounded, identity-checked regular file. */
export class PeResourcesProvider implements PeResourcesPort {
  readonly identity = PE_RESOURCES_PROVIDER;

  async inspect(input: InspectPeResourcesInput, options?: ExecutionOptions) {
    try {
      const snapshot = await readStableArtifact(
        input.path,
        input.max_file_bytes,
        options?.signal,
      );
      return ok(
        await parsePeResources(
          snapshot.bytes,
          {
            path: input.path,
            sha256: snapshot.sha256,
            bytes: snapshot.bytes.length,
          },
          input,
          options?.signal,
        ),
      );
    } catch (cause) {
      return err(
        inspectionFailure(
          cause,
          input,
          "inspect_pe_resources",
          "PE image",
          options?.signal,
        ),
      );
    }
  }
}
