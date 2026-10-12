import type {
  ExecutionOptions,
  ProviderIdentity,
} from "../AnalysisProvider.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type {
  ExtractPalmResourcesInput,
  PalmExtraction,
} from "../../domain/native/palmResources.js";
import type { Result } from "../../domain/result.js";

export interface PalmExtractionPort {
  readonly identity: ProviderIdentity;
  extract(
    input: ExtractPalmResourcesInput,
    options?: ExecutionOptions,
  ): Promise<Result<PalmExtraction, AnalysisError>>;
  close(): Promise<void>;
}
