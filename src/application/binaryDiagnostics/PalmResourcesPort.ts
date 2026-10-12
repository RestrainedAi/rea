import type {
  ExecutionOptions,
  ProviderIdentity,
} from "../AnalysisProvider.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type {
  InspectPalmResourcesInput,
  PalmResources,
} from "../../domain/native/palmResources.js";
import type { Result } from "../../domain/result.js";

export interface PalmResourcesPort {
  readonly identity: ProviderIdentity;
  inspect(
    input: InspectPalmResourcesInput,
    options?: ExecutionOptions,
  ): Promise<Result<PalmResources, AnalysisError>>;
}
