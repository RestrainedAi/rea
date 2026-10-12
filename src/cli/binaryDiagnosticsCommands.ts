import { z } from "incur";
import { resolve } from "node:path";
import {
  createRecordedCrashService,
  createBinaryLayoutService,
  createPeResourcesService,
  createPalmResourcesService,
  createPalmExtractionService,
} from "../composition/binaryDiagnostics.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import type { Logger } from "pino";
import type { CliInstance } from "./types.js";
import { withCommandCancellation } from "./commandCancellation.js";
import { inspectPeResourcesInputSchema } from "../domain/native/peResources.js";
import { inspectPalmResourcesInputSchema } from "../domain/native/palmResources.js";

/** Inspect operator-selected files through the same shared workflow as MCP. */
export const registerBinaryDiagnosticsCommands = (
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<NodeJS.ProcessEnv>,
): void => {
  registerPalmExtractionCommand(cli, logger);
  const palm = createPalmResourcesService();
  cli.command(CLI_COMMANDS.inspectPalmResources, {
    description:
      "Inspect Palm resource-database header, resource file ranges and hashes without executing the app",
    args: z.object({
      path: z.string().describe("Local Palm PRC/resource database"),
    }),
    options: z.object({
      maxFileBytes: inspectPalmResourcesInputSchema.shape.max_file_bytes,
      maxEntries: inspectPalmResourcesInputSchema.shape.max_entries,
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.inspectPalmResources, async () => {
          const result = await palm.inspect(
            {
              path: resolve(args.path),
              max_file_bytes: options.maxFileBytes,
              max_entries: options.maxEntries,
            },
            { signal },
          );
          return result.ok ? result.value : projectAnalysisError(result.error);
        }),
      ),
  });
  const pe = createPeResourcesService();
  cli.command(CLI_COMMANDS.inspectPeResources, {
    description:
      "Inspect PE resource identities, payload ranges, hashes and icon-group relationships",
    args: z.object({ path: z.string().describe("Local PE32/PE32+ image") }),
    options: z.object({
      maxFileBytes: inspectPeResourcesInputSchema.shape.max_file_bytes,
      maxEntries: inspectPeResourcesInputSchema.shape.max_entries,
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.inspectPeResources, async () => {
          const result = await pe.inspect(
            {
              path: resolve(args.path),
              max_file_bytes: options.maxFileBytes,
              max_entries: options.maxEntries,
            },
            { signal },
          );
          return result.ok ? result.value : projectAnalysisError(result.error);
        }),
      ),
  });
  const service = createBinaryLayoutService(environment);
  cli.command(CLI_COMMANDS.inspectBinaryLayout, {
    description:
      "Inspect binary file/linked layout without executing the selected object",
    args: z.object({
      path: z.string().describe("Local ELF binary or relocatable object"),
    }),
    run: ({ args }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.inspectBinaryLayout, async () => {
          const result = await service.inspect(
            { path: resolve(args.path) },
            { signal },
          );
          return result.ok ? result.value : projectAnalysisError(result.error);
        }),
      ),
  });
  const recorded = createRecordedCrashService(environment);
  cli.command(CLI_COMMANDS.inspectRecordedCrash, {
    description:
      "Inspect supplied core registers/signals and optional debugger mapping evidence",
    args: z.object({ path: z.string().describe("Local Linux amd64 ELF core") }),
    options: z.object({
      debuggerContext: z
        .boolean()
        .default(false)
        .describe("Add BYO core-only GDB/pwndbg mapping candidates"),
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.inspectRecordedCrash, async () => {
          const result = await recorded.inspect(
            {
              path: resolve(args.path),
              include_debugger_context: options.debuggerContext,
            },
            { signal },
          );
          return result.ok ? result.value : projectAnalysisError(result.error);
        }),
      ),
  });
};

const registerPalmExtractionCommand = (
  cli: CliInstance,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.extractPalmResources, {
    description:
      "Export all Palm resource blocks unchanged to a fresh directory with a verified manifest",
    args: z.object({
      path: z.string().describe("Local Palm PRC/resource database"),
    }),
    options: z.object({
      output: z
        .string()
        .describe("Absent output directory; its parent must exist"),
      maxFileBytes: inspectPalmResourcesInputSchema.shape.max_file_bytes,
      maxEntries: inspectPalmResourcesInputSchema.shape.max_entries,
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.extractPalmResources, async () => {
          const service = createPalmExtractionService();
          try {
            const result = await service.extract(
              {
                path: resolve(args.path),
                output_root: resolve(options.output),
                max_file_bytes: options.maxFileBytes,
                max_entries: options.maxEntries,
              },
              { signal },
            );
            return result.ok
              ? result.value
              : projectAnalysisError(result.error);
          } finally {
            await service.close();
          }
        }),
      ),
  });
};
