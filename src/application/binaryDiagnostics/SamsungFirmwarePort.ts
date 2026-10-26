import type {
  ExecutionOptions,
  ProviderIdentity,
} from "../AnalysisProvider.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { Result } from "../../domain/result.js";
import type {
  ExtractSamsungFirmwareInput,
  InspectSamsungFirmwareInput,
  SamsungFirmware,
  SamsungFirmwareExtraction,
} from "../../domain/firmware/samsungFirmware.js";

export interface SamsungFirmwarePort {
  readonly identity: ProviderIdentity;
  inspect(
    input: InspectSamsungFirmwareInput,
    options?: ExecutionOptions,
  ): Promise<Result<SamsungFirmware, AnalysisError>>;
  extract(
    input: ExtractSamsungFirmwareInput,
    options?: ExecutionOptions,
  ): Promise<Result<SamsungFirmwareExtraction, AnalysisError>>;
  close(): Promise<void>;
}
