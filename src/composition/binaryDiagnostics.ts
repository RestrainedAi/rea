import { RecordedCrashService } from "../application/binaryDiagnostics/RecordedCrashService.js";
import { PwntoolsRecordedCrashProvider } from "../native/pwntools/PwntoolsRecordedCrashProvider.js";
import { BinaryLayoutService } from "../application/binaryDiagnostics/BinaryLayoutService.js";
import { PwntoolsLayoutProvider } from "../native/pwntools/PwntoolsLayoutProvider.js";
import { PeResourcesService } from "../application/binaryDiagnostics/PeResourcesService.js";
import { PeResourcesProvider } from "../native/pe/PeResourcesProvider.js";
import { PalmResourcesService } from "../application/binaryDiagnostics/PalmResourcesService.js";
import { PalmResourcesProvider } from "../native/palm/PalmResourcesProvider.js";
import { PalmExtractionService } from "../application/binaryDiagnostics/PalmExtractionService.js";
import { PalmExtractionProvider } from "../native/palm/PalmExtractionProvider.js";
import { SamsungFirmwareService } from "../application/binaryDiagnostics/SamsungFirmwareService.js";
import { SamsungFirmwareProvider } from "../native/samsung/SamsungFirmwareProvider.js";

/** Portable PE inspection with no engine, installation or target acquisition. */
export const createPeResourcesService = (): PeResourcesService =>
  new PeResourcesService(new PeResourcesProvider());

/** Portable Palm inspection without target execution or an installed engine. */
export const createPalmResourcesService = (): PalmResourcesService =>
  new PalmResourcesService(new PalmResourcesProvider());

export const createPalmExtractionService = (): PalmExtractionService =>
  new PalmExtractionService(new PalmExtractionProvider());

/** Portable streamed Samsung package inspection/export, with no device connection. */
export const createSamsungFirmwareService = (): SamsungFirmwareService =>
  new SamsungFirmwareService(new SamsungFirmwareProvider());

/** Compose the offline adapter without import-time I/O or dependency acquisition. */
export const createBinaryLayoutService = (
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): BinaryLayoutService =>
  new BinaryLayoutService(new PwntoolsLayoutProvider(environment));

/** Compose recorded-core inspection without acquiring a debugger or toolchain. */
export const createRecordedCrashService = (
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): RecordedCrashService =>
  new RecordedCrashService(new PwntoolsRecordedCrashProvider(environment));
