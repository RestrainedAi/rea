import { readStableArtifact } from "../../artifacts/readStableArtifact.js";
import { inspectionFailure } from "../../artifacts/inspectionFailure.js";
import type { PalmResourcesPort } from "../../application/binaryDiagnostics/PalmResourcesPort.js";
import type { ExecutionOptions } from "../../application/AnalysisProvider.js";
import type { InspectPalmResourcesInput } from "../../domain/native/palmResources.js";
import { err, ok } from "../../domain/result.js";
import { PALM_RESOURCES_PROVIDER } from "../../application/InvestigationProviders.js";
import { parsePalmResources } from "./PalmResourceParser.js";

export class PalmResourcesProvider implements PalmResourcesPort {
  readonly identity = PALM_RESOURCES_PROVIDER;
  async inspect(input: InspectPalmResourcesInput, options?: ExecutionOptions) {
    try {
      const snapshot = await readStableArtifact(
        input.path,
        input.max_file_bytes,
        options?.signal,
      );
      return ok(
        await parsePalmResources(
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
          "inspect_palm_resources",
          "Palm resource database",
          options?.signal,
        ),
      );
    }
  }
}
