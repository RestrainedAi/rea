import { Cli } from "incur";
import { resolve } from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SamsungFirmwareService } from "../../../src/application/binaryDiagnostics/SamsungFirmwareService.js";
import { SAMSUNG_FIRMWARE_PROVIDER } from "../../../src/application/InvestigationProviders.js";
import { ArtifactReaderFailure } from "../../../src/artifacts/ArtifactReader.js";
import { CLI_COMMANDS } from "../../../src/cliCommandNames.js";
import { registerSamsungFirmwareCommands } from "../../../src/cli/samsungFirmwareCommands.js";
import type { AnalysisError } from "../../../src/domain/analysisErrorBase.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { ArtifactOperationError } from "../../../src/domain/artifactOperationError.js";
import { createEvidence, type Evidence } from "../../../src/domain/evidence.js";
import { err, ok, type Result } from "../../../src/domain/result.js";

type Service = Pick<SamsungFirmwareService, "inspect" | "extract" | "close">;
const logger = pino({ level: "silent" });
const initialExitCode = process.exitCode;
afterEach(() => {
  process.exitCode = initialExitCode;
});
const path = resolve("samsung-cli-fixture.tar.md5");
const output = resolve("samsung-cli-fixture-export");
const commands = [
  {
    name: CLI_COMMANDS.inspectSamsungFirmware,
    operation: "inspect_samsung_firmware" as const,
  },
  {
    name: CLI_COMMANDS.extractSamsungFirmware,
    operation: "extract_samsung_firmware" as const,
  },
];

const completedEvidence = (operation: string) =>
  createEvidence(
    { path, format: "samsung-tar-md5", sha256: "a".repeat(64) },
    SAMSUNG_FIRMWARE_PROVIDER,
    {
      operation,
      parameters: { path },
      result: { source: path, checksum: "match" },
      confidence: "observed",
      limitations: ["Injected CLI fixture; no input is read."],
    },
  );

const serviceFor = (
  result: Result<Evidence, AnalysisError>,
  closeFailure?: unknown,
): Service => ({
  inspect: vi.fn(async () => result),
  extract: vi.fn(async () => result),
  close: vi.fn(async () => {
    await Promise.resolve();
    if (closeFailure !== undefined) throw closeFailure;
  }),
});

const serve = async (name: string, service: Service) => {
  const cli = Cli.create("samsung-cleanup-test", { sync: false });
  registerSamsungFirmwareCommands(cli, logger, () => service);
  let stdout = "";
  await cli.serve(
    [
      name,
      path,
      ...(name === CLI_COMMANDS.extractSamsungFirmware
        ? ["--output", output]
        : []),
      "--json",
    ],
    {
      env: {},
      stdout: (text) => {
        stdout += text;
      },
      exit: () => {},
    },
  );
  return JSON.parse(stdout) as unknown;
};

describe.each(commands)("Samsung CLI cleanup: $name", ({ name, operation }) => {
  it("preserves the primary typed failure, resources and observation when draining still fails", async () => {
    const observation = {
      kind: "firmware" as const,
      result: { source: path, observed: true },
    };
    const primary = new ArtifactOperationError(
      operation,
      "integrity",
      undefined,
      "Probe: operation refused",
      {
        cleanup: { reason: "First source close refused", resources: [path] },
        partialObservation: observation,
      },
    );
    const cleanup = new ArtifactReaderFailure(
      "unavailable",
      "Probe: retained owners still cannot close",
      {
        cleanup: {
          reason: "Persistent close refusal",
          resources: [path, output],
        },
      },
    );
    const service = serviceFor(err(primary), cleanup);
    expect(await serve(name, service)).toMatchObject({
      code: "cleanup_incomplete",
      retryable: false,
      details: {
        resources: [path, output],
        partial_observation: observation,
        diagnostics: {
          primary_error: projectAnalysisError(primary),
          cleanup_error: { code: "cleanup_incomplete" },
        },
      },
    });
    expect(service.close).toHaveBeenCalledTimes(1);
  });

  it("projects a close-only failure and retains the complete completed Evidence", async () => {
    const evidence = completedEvidence(operation);
    const cleanup = new ArtifactReaderFailure(
      "unavailable",
      "Probe: cleanup could not finish",
      {
        cleanup: { reason: "Persistent cleanup failure", resources: [output] },
      },
    );
    const service = serviceFor(ok(evidence), cleanup);
    expect(await serve(name, service)).toMatchObject({
      code: "cleanup_incomplete",
      retryable: false,
      details: {
        cleanup: "incomplete",
        resources: [output],
        partial_observation: evidence,
      },
    });
    expect(service.close).toHaveBeenCalledTimes(1);
  });

  it("awaits successful cleanup while preserving the original structured operation failure", async () => {
    const primary = new ArtifactOperationError(
      operation,
      "integrity",
      undefined,
      "Probe: MD5 mismatch",
    );
    const service = serviceFor(err(primary));
    expect(await serve(name, service)).toEqual(projectAnalysisError(primary));
    expect(service.close).toHaveBeenCalledTimes(1);
    expect(service.close).toHaveResolvedWith(undefined);
  });

  it("returns completed Evidence after successful cleanup", async () => {
    const evidence = completedEvidence(operation);
    const service = serviceFor(ok(evidence));
    expect(await serve(name, service)).toEqual(evidence);
    expect(service.close).toHaveBeenCalledTimes(1);
    expect(service.close).toHaveResolvedWith(undefined);
  });
});

it.each(commands)(
  "drains after an unexpected operation throw in $name without losing that primary cause",
  async ({ name }) => {
    const primary = new ArtifactReaderFailure(
      "integrity",
      "Probe: source changed during acquisition",
    );
    const cleanup = new ArtifactReaderFailure(
      "unavailable",
      "Probe: owner still cannot close",
      {
        cleanup: { reason: "Persistent close failure", resources: [path] },
      },
    );
    const service = serviceFor(ok(completedEvidence("unused")), cleanup);
    vi.mocked(service.inspect).mockRejectedValue(primary);
    vi.mocked(service.extract).mockRejectedValue(primary);
    expect(await serve(name, service)).toMatchObject({
      code: "cleanup_incomplete",
      details: {
        resources: [path],
        diagnostics: {
          primary_error: { code: "artifact_changed" },
          cleanup_error: { code: "cleanup_incomplete" },
        },
      },
    });
    expect(service.close).toHaveBeenCalledTimes(1);
  },
);
