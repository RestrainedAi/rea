import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createHash } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect } from "vitest";
import { samsungTarFixture } from "../../../src/native/samsung/SamsungTarDirectory.fixture.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import {
  samsungFirmwareSchema,
  samsungFirmwareExtractionSchema,
} from "../../../src/domain/firmware/samsungFirmware.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const digest = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");
const connect = async (root: string) => {
  const client = new Client({
    name: "samsung-package-acceptance",
    version: "1",
  });
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [resolve("scripts/rea.mjs"), "mcp"],
        cwd: process.cwd(),
        env: {
          PATH: process.env.PATH ?? "",
          TEMP: root,
          TMP: root,
          REA_LOG_LEVEL: "silent",
        },
      }),
    );
  } catch (cause) {
    await client.close();
    throw cause;
  }
  return client;
};

cliTest.for(["metadata-inclusive", "minimum checksum record"] as const)(
  "inspects and exports %s Samsung packages through compiled CLI and real stdio MCP",
  { timeout: 40_000 },
  async (profile, { cli }) => {
    const root = await createTestTempDirectory("rea-samsung-acceptance-");
    const path = join(root, "package.bin");
    const payload = Buffer.alloc(1024 * 1024 + 65537, 0x5a);
    const minimalRecord = profile === "minimum checksum record";
    const fixture = samsungTarFixture(
      [
        { name: "boot.img", payload },
        { name: "empty.img", payload: Buffer.alloc(0) },
      ],
      minimalRecord
        ? { metadata: "", filename: "x", separator: " ", newline: "" }
        : {},
    );
    await writeFile(path, fixture.bytes);
    const client = await connect(root);
    const inspect = toolContract("inspect_samsung_firmware");
    const extract = toolContract("extract_samsung_firmware");
    try {
      const catalog = await client.listTools();
      expect(catalog.tools).toContainEqual(
        expect.objectContaining({
          name: inspect.name,
          annotations: expect.objectContaining({ openWorldHint: false }),
        }),
      );
      const command = await cli.run({
        arguments: ["inspect-samsung-firmware", path, "--json"],
      });
      expect(command.exitCode).toBe(0);
      const cliEvidence = inspect.outputSchema.parse(command.json);
      const response = await client.callTool({
        name: inspect.name,
        arguments: { path },
      });
      expect(response.isError).not.toBe(true);
      const mcpEvidence = inspect.outputSchema.parse(
        response.structuredContent,
      );
      expect(mcpEvidence).toEqual(cliEvidence);
      const report = samsungFirmwareSchema.parse(mcpEvidence.normalized_result);
      expect(report).toMatchObject({
        artifact: {
          sha256: digest(fixture.bytes),
          bytes: fixture.bytes.length,
        },
        format: "samsung-tar-md5",
        integrity: {
          declared_md5: fixture.declaredMd5,
          calculated_md5: fixture.declaredMd5,
          status: "match",
          checksum_range: { bytes: fixture.checksumRecordOffset },
        },
      });
      if (minimalRecord) {
        expect(report.footer.checksum_record_location.bytes).toBe(34);
        expect(report.footer.checksum_filename).toBe("x");
        expect(report.integrity.checksum_range.bytes).toBe(
          report.tar_location.bytes,
        );
      } else
        expect(report.integrity.checksum_range.bytes).toBeGreaterThan(
          report.tar_location.bytes,
        );
      expect(report.entries[0]!.payload.sha256).toBe(digest(payload));
      const cliOutput = join(root, "cli-export");
      const mcpOutput = join(root, "mcp-export");
      const cliExtraction = await cli.run({
        arguments: [
          "extract-samsung-firmware",
          path,
          "--output",
          cliOutput,
          "--json",
        ],
      });
      expect(cliExtraction.exitCode).toBe(0);
      const mcpExtraction = await client.callTool({
        name: extract.name,
        arguments: { path, output_root: mcpOutput },
      });
      expect(mcpExtraction.isError).not.toBe(true);
      const exports = [
        extract.outputSchema.parse(cliExtraction.json),
        extract.outputSchema.parse(mcpExtraction.structuredContent),
      ].map((evidence) =>
        samsungFirmwareExtractionSchema.parse(evidence.normalized_result),
      );
      expect(exports[0]!.files).toEqual(exports[1]!.files);
      for (const result of exports) {
        expect(result.inventory).toEqual(report);
        expect(result.files).toHaveLength(2);
        for (const file of result.files) {
          const bytes = await readFile(
            join(result.output_root, file.relative_path),
          );
          expect(bytes.length).toBe(file.bytes_written);
          expect(digest(bytes)).toBe(file.sha256);
        }
        expect(
          await readFile(join(result.output_root, "__samsung_footer.bin")),
        ).toEqual(fixture.bytes.subarray(fixture.footerOffset));
        expect(
          JSON.parse(
            await readFile(join(result.output_root, "manifest.json"), "utf8"),
          ),
        ).toEqual(result);
      }
      const again = await client.callTool({
        name: extract.name,
        arguments: { path, output_root: mcpOutput },
      });
      expect(again.isError).toBe(true);
      expect(await readFile(join(mcpOutput, "boot.img"))).toEqual(payload);
      const ledger = await client.callTool({
        name: "get_evidence_bundle",
        arguments: { detail: "summary", filters: { operation: inspect.name } },
      });
      expect(ledger.isError).not.toBe(true);
      expect(JSON.stringify(ledger.structuredContent)).toContain(
        mcpEvidence.evidence_id,
      );
      expect(await readFile(path)).toEqual(fixture.bytes);
    } finally {
      await client.close();
    }
  },
);

cliTest(
  "reports a stored MD5 mismatch while refusing export and public malformed requests without output",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-samsung-refusal-");
    const path = join(root, "mismatch.tar.md5");
    const fixture = samsungTarFixture();
    const corrupted = Buffer.from(fixture.bytes);
    const payloadOffset = fixture.entries[0]!.payloadOffset;
    corrupted[payloadOffset] = corrupted[payloadOffset]! ^ 1;
    await writeFile(path, corrupted);
    const client = await connect(root);
    const inspect = toolContract("inspect_samsung_firmware");
    try {
      const result = await client.callTool({
        name: inspect.name,
        arguments: { path },
      });
      expect(result.isError).not.toBe(true);
      expect(
        samsungFirmwareSchema.parse(
          inspect.outputSchema.parse(result.structuredContent)
            .normalized_result,
        ).integrity.status,
      ).toBe("mismatch");
      const output = join(root, "refused-export");
      const rejected = await client.callTool({
        name: "extract_samsung_firmware",
        arguments: { path, output_root: output },
      });
      expect(rejected.isError).toBe(true);
      expect(parseMcpToolError(rejected).error.code).not.toBe(
        "artifact_changed",
      );
      await expect(access(output)).rejects.toThrow();
      const failedCli = await cli.run({
        arguments: [
          "extract-samsung-firmware",
          path,
          "--output",
          output,
          "--json",
        ],
      });
      expect(failedCli.exitCode).toBe(1);
      expect(parseMcpToolError(rejected)).toEqual({ error: failedCli.json });
      await expect(access(output)).rejects.toThrow();
      const limited = await client.callTool({
        name: inspect.name,
        arguments: { path, max_file_bytes: 1024 },
      });
      expect(parseMcpToolError(limited).error).toMatchObject({
        code: "resource_constraint",
        details: { resource: "file-size" },
      });
      for (const input of [
        { path: "relative.tar.md5" },
        { path, max_entries: 0 },
        { path, unexpected: true },
      ])
        expect(
          (await client.callTool({ name: inspect.name, arguments: input }))
            .isError,
        ).toBe(true);
      const malformed = join(root, "bad-header.tar.md5");
      const invalid = Buffer.from(fixture.bytes);
      invalid[0] = invalid[0]! ^ 1;
      await writeFile(malformed, invalid);
      expect(
        (
          await client.callTool({
            name: "extract_samsung_firmware",
            arguments: { path: malformed, output_root: output },
          })
        ).isError,
      ).toBe(true);
      await expect(access(output)).rejects.toThrow();
      expect(await readFile(path)).toEqual(corrupted);
    } finally {
      await client.close();
    }
  },
  40_000,
);
