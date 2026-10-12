import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { expect } from "vitest";
import { instylerArchiveFixture } from "../../../src/artifacts/instyler/InstylerDirectory.fixture.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { analysisCliErrorEnvelopeSchema } from "../../../src/contracts/errorSchemas.js";
import {
  artifactExtractionResultSchema,
  artifactInventoryResultSchema,
} from "../../../src/domain/artifactGraph.js";
import { artifactInspectionResultSchema } from "../../../src/domain/artifactInspection.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const digest = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");

cliTest(
  "inventories and extracts Instyler through compiled CLI and real stdio MCP without executing an engine or payload",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-instyler-acceptance-");
    const path = join(root, "archive.exe");
    const payload = Buffer.from([0, 0xff, 0xe9, 42]);
    const fixture = instylerArchiveFixture([
      { filename: "%appfolder%\\data.bin", bytes: payload },
      { filename: "%appfolder%\\empty.bin", bytes: Buffer.alloc(0) },
    ]);
    await writeFile(path, fixture.bytes);
    const environment = { TEMP: root, TMP: root, REA_LOG_LEVEL: "silent" };
    const client = new Client({ name: "instyler-acceptance", version: "1" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve("scripts/rea.mjs"), "mcp"],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "", ...environment },
    });
    const inspection = toolContract("inspect_artifact");
    const extraction = toolContract("extract_artifact");
    try {
      await client.connect(transport);
      expect(
        (await client.callTool({ name: "open_binary", arguments: { path } }))
          .isError,
      ).not.toBe(true);
      const cliInspection = await cli.run({
        arguments: ["inspect-artifact", path, "--json"],
        environment,
      });
      expect(cliInspection.exitCode).toBe(0);
      const cliEvidence = inspection.outputSchema.parse(cliInspection.json);
      const mcpInspection = await client.callTool({
        name: inspection.name,
        arguments: {},
      });
      expect(mcpInspection.isError).not.toBe(true);
      const mcpEvidence = inspection.outputSchema.parse(
        mcpInspection.structuredContent,
      );
      expect(mcpEvidence).toEqual(cliEvidence);
      const report = artifactInspectionResultSchema.parse(
        mcpEvidence.normalized_result,
      );
      const inventory = artifactInventoryResultSchema.parse(
        report.substeps[0]!.evidence.normalized_result,
      );
      expect(inventory.manifest).toMatchObject({
        root_format: "pe",
        root_sha256: digest(fixture.bytes),
      });
      const member = inventory.occurrences.find(
        ({ logical_path }) => logical_path === "%appfolder%/data.bin",
      )!;
      expect(member.source_location).toBeNull();
      expect(inventory.nodes).toContainEqual(
        expect.objectContaining({
          sha256: digest(payload),
          size: payload.length,
        }),
      );
      const cliExtraction = await cli.run({
        arguments: ["extract-artifact", path, "--json"],
        environment,
      });
      expect(cliExtraction.exitCode).toBe(0);
      const mcpExtraction = await client.callTool({
        name: extraction.name,
        arguments: {},
      });
      expect(mcpExtraction.isError).not.toBe(true);
      const results = [
        extraction.outputSchema.parse(cliExtraction.json),
        extraction.outputSchema.parse(mcpExtraction.structuredContent),
      ].map((evidence) =>
        artifactExtractionResultSchema.parse(evidence.normalized_result),
      );
      expect(results[0]!.artifacts).toEqual(results[1]!.artifacts);
      for (const result of results) {
        // Both public adapters must keep their exclusively owned output in this test root.
        expect(resolve(result.output_root).startsWith(`${root}${sep}`)).toBe(
          true,
        );
        expect(result.artifacts).toHaveLength(3);
        expect(result.containment_verified).toBe(true);
        for (const artifact of result.artifacts) {
          const bytes = await readFile(
            join(result.output_root, artifact.relative_path),
          );
          expect(bytes.length).toBe(artifact.bytes_written);
          expect(digest(bytes)).toBe(artifact.sha256);
        }
        expect(
          await readFile(join(result.output_root, "%appfolder%", "data.bin")),
        ).toEqual(payload);
        expect(
          await readFile(join(result.output_root, "%appfolder%", "empty.bin")),
        ).toEqual(Buffer.alloc(0));
        expect(
          await readFile(join(result.output_root, "__instyler_metadata.bin")),
        ).toEqual(
          fixture.bytes.subarray(fixture.overlayOffset, fixture.dataOffset),
        );
      }
      expect(await readFile(path)).toEqual(fixture.bytes);
      expect(
        (await client.callTool({ name: "close_binary", arguments: {} }))
          .isError,
      ).not.toBe(true);
    } finally {
      await client.close();
    }
  },
  40_000,
);

cliTest(
  "preserves public malformed-member refusals and ordinary PE inventory",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-instyler-refusal-");
    const payload = Buffer.from("Controlled payload");
    const fixture = instylerArchiveFixture();
    const environment = { TEMP: root, TMP: root, REA_LOG_LEVEL: "silent" };
    const client = new Client({ name: "instyler-refusal", version: "1" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve("scripts/rea.mjs"), "mcp"],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "", ...environment },
    });
    const inspection = toolContract("inspect_artifact");
    try {
      await client.connect(transport);
      for (const [label, invalid] of [
        [
          "checksum",
          (() => {
            const bytes = Buffer.from(fixture.bytes);
            bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
            return bytes;
          })(),
        ],
        [
          "traversal",
          instylerArchiveFixture([
            { filename: "folder\\..\\escape.bin", bytes: payload },
          ]).bytes,
        ],
        [
          "expansion",
          (() => {
            const bytes = Buffer.from(fixture.bytes);
            bytes.writeUInt32LE(
              64 * 1024 * 1024 + 1,
              fixture.recordOffsets[0]! + 278,
            );
            return bytes;
          })(),
        ],
      ] as const) {
        const invalidPath = join(root, `${label}.exe`);
        await writeFile(invalidPath, invalid);
        expect(
          (
            await client.callTool({
              name: "open_binary",
              arguments: { path: invalidPath },
            })
          ).isError,
        ).not.toBe(true);
        const failedCli = await cli.run({
          arguments: ["inspect-artifact", invalidPath, "--json"],
          environment,
        });
        const failedMcp = await client.callTool({
          name: inspection.name,
          arguments: {},
        });
        expect(failedCli.exitCode).toBe(1);
        expect(failedMcp.isError).toBe(true);
        const { error: _cliLabel, ...projection } =
          analysisCliErrorEnvelopeSchema.parse(failedCli.json);
        const mcpError = parseMcpToolError(failedMcp);
        expect(mcpError).toEqual({ error: projection });
        if (label === "checksum") {
          expect(mcpError.error.message).not.toContain("record-and-continue");
          expect(
            (
              await client.callTool({
                name: inspection.name,
                arguments: { integrity_policy: "record-and-continue" },
              })
            ).isError,
          ).toBe(true);
        }
        expect(await readFile(invalidPath)).toEqual(invalid);
      }

      const ordinary = join(root, "ordinary.exe");
      await writeFile(
        ordinary,
        fixture.bytes.subarray(0, fixture.overlayOffset),
      );
      const ordinaryInspection = await cli.run({
        arguments: ["inspect-artifact", ordinary, "--json"],
        environment,
      });
      expect(ordinaryInspection.exitCode).toBe(0);
      const ordinaryReport = artifactInspectionResultSchema.parse(
        inspection.outputSchema.parse(ordinaryInspection.json)
          .normalized_result,
      );
      const ordinaryInventory = artifactInventoryResultSchema.parse(
        ordinaryReport.substeps[0]!.evidence.normalized_result,
      );
      expect(ordinaryInventory.occurrences).toHaveLength(1);
      expect(ordinaryInventory.limitations.join(" ")).toContain(
        "profile was not recognized",
      );
      expect(
        (
          await cli.run({
            arguments: ["extract-artifact", ordinary, "--json"],
            environment,
          })
        ).exitCode,
      ).toBe(1);
      expect(
        (await client.callTool({ name: "close_binary", arguments: {} }))
          .isError,
      ).not.toBe(true);
    } finally {
      await client.close();
    }
  },
  40_000,
);
