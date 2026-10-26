import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import type { SamsungFirmwareService } from "../application/binaryDiagnostics/SamsungFirmwareService.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import type { Logger } from "pino";
import type { WithAdmittedAnalysis } from "./analysisAdmission.js";
import { toolContract } from "../contracts/toolContracts.js";
import { createEvidenceToolHandler } from "./contractToolHandler.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";

export const registerSamsungFirmwareTools = (
  server: EvidenceMcpServer,
  service: SamsungFirmwareService,
  logger: Logger,
  recordEvidence?: EvidenceWriter["recordEvidence"],
  withAdmittedAnalysis?: WithAdmittedAnalysis,
): void => {
  const inspect = toolContract("inspect_samsung_firmware");
  const inspectHandler = createEvidenceToolHandler(
    server,
    (input, options) => service.inspect(input, options),
    logger,
    recordEvidence,
    withAdmittedAnalysis,
  );
  server.registerTool(
    inspect.name,
    toolRegistrationOptions(inspect),
    inspectHandler(inspect),
  );
  const extract = toolContract("extract_samsung_firmware");
  const extractHandler = createEvidenceToolHandler(
    server,
    (input, options) => service.extract(input, options),
    logger,
    recordEvidence,
    withAdmittedAnalysis,
  );
  server.registerTool(
    extract.name,
    toolRegistrationOptions(extract),
    extractHandler(extract),
  );
};
