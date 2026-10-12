import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import type { PalmResourcesService } from "../application/binaryDiagnostics/PalmResourcesService.js";
import type { PalmExtractionService } from "../application/binaryDiagnostics/PalmExtractionService.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import { toolContract } from "../contracts/toolContracts.js";
import type { Logger } from "pino";
import { createEvidenceToolHandler } from "./contractToolHandler.js";
import type { WithAdmittedAnalysis } from "./analysisAdmission.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";

export const registerPalmResourcesTool = (
  server: EvidenceMcpServer,
  service: PalmResourcesService,
  extraction: PalmExtractionService,
  logger: Logger,
  recordEvidence?: EvidenceWriter["recordEvidence"],
  withAdmittedAnalysis?: WithAdmittedAnalysis,
): void => {
  const contract = toolContract("inspect_palm_resources");
  const handler = createEvidenceToolHandler(
    server,
    (input, options) => service.inspect(input, options),
    logger,
    recordEvidence,
    withAdmittedAnalysis,
  );
  server.registerTool(
    contract.name,
    toolRegistrationOptions(contract),
    handler(contract),
  );
  const extractionContract = toolContract("extract_palm_resources");
  const extractionHandler = createEvidenceToolHandler(
    server,
    (input, options) => extraction.extract(input, options),
    logger,
    recordEvidence,
    withAdmittedAnalysis,
  );
  server.registerTool(
    extractionContract.name,
    toolRegistrationOptions(extractionContract),
    extractionHandler(extractionContract),
  );
};
