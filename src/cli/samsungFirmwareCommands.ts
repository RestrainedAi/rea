import { z } from "incur";
import { resolve } from "node:path";
import type { Logger } from "pino";
import type { CliInstance } from "./types.js";
import { createSamsungFirmwareService } from "../composition/binaryDiagnostics.js";
import type { SamsungFirmwareService } from "../application/binaryDiagnostics/SamsungFirmwareService.js";
import { directAnalysisCleanupFailure } from "../application/DirectAnalysisCleanup.js";
import { inspectionFailure } from "../artifacts/inspectionFailure.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import { err } from "../domain/result.js";
import {
  inspectSamsungFirmwareInputSchema,
  type InspectSamsungFirmwareInput,
} from "../domain/firmware/samsungFirmware.js";
import { withCommandCancellation } from "./commandCancellation.js";

type SamsungCliService = Pick<
  SamsungFirmwareService,
  "inspect" | "extract" | "close"
>;
type SamsungCliResult = Awaited<ReturnType<SamsungCliService["inspect"]>>;
type SamsungOperation = "inspect_samsung_firmware" | "extract_samsung_firmware";

export const registerSamsungFirmwareCommands = (
  cli: CliInstance,
  logger: Logger,
  createService: () => SamsungCliService = createSamsungFirmwareService,
): void => {
  const budgets = {
    maxFileBytes: inspectSamsungFirmwareInputSchema.shape.max_file_bytes,
    maxEntries: inspectSamsungFirmwareInputSchema.shape.max_entries,
  };
  cli.command(CLI_COMMANDS.inspectSamsungFirmware, {
    description:
      "Inspect Samsung TAR.MD5 headers, member hashes and metadata-inclusive checksum without a device",
    args: z.object({
      path: z.string().describe("Local Samsung TAR.MD5 package"),
    }),
    options: z.object(budgets),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.inspectSamsungFirmware, async () => {
          const service = createService();
          const input = {
            path: resolve(args.path),
            max_file_bytes: options.maxFileBytes,
            max_entries: options.maxEntries,
          };
          return runWithCleanup(
            service,
            { input, operation: "inspect_samsung_firmware", signal },
            () => service.inspect(input, { signal }),
          );
        }),
      ),
  });
  cli.command(CLI_COMMANDS.extractSamsungFirmware, {
    description:
      "Export verified Samsung TAR.MD5 member bytes into a new directory with a manifest",
    args: z.object({
      path: z.string().describe("Local Samsung TAR.MD5 package"),
    }),
    options: z.object({
      ...budgets,
      output: z
        .string()
        .describe("Absent output directory with an existing parent"),
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.extractSamsungFirmware, async () => {
          const service = createService();
          const input = {
            path: resolve(args.path),
            output_root: resolve(options.output),
            max_file_bytes: options.maxFileBytes,
            max_entries: options.maxEntries,
          };
          return runWithCleanup(
            service,
            { input, operation: "extract_samsung_firmware", signal },
            () => service.extract(input, { signal }),
          );
        }),
      ),
  });
};

/** Await the owner drain without allowing it to replace an observed outcome. */
const runWithCleanup = async (
  service: SamsungCliService,
  context: {
    readonly input: InspectSamsungFirmwareInput;
    readonly operation: SamsungOperation;
    readonly signal: AbortSignal;
  },
  run: () => Promise<SamsungCliResult>,
) => {
  const { input, operation, signal } = context;
  let result: SamsungCliResult;
  try {
    result = await run();
  } catch (cause) {
    result = err(
      inspectionFailure(
        cause,
        input,
        operation,
        "Samsung firmware package",
        signal,
      ),
    );
  }
  try {
    await service.close();
  } catch (cause) {
    // Cleanup runs outside cancellation: preserve the drain's own resources
    // and cause, alongside the operation's typed failure or complete Evidence.
    const cleanup = inspectionFailure(
      cause,
      input,
      operation,
      "Samsung firmware service cleanup",
    );
    return result.ok
      ? directAnalysisCleanupFailure(result.value, cleanup)
      : projectAnalysisError(
          analysisErrorWithCleanupFailure(result.error, cleanup, operation),
        );
  }
  return result.ok ? result.value : projectAnalysisError(result.error);
};
