import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { palmResourceFixture } from "../../../src/native/palm/PalmResources.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const hash = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");

cliTest(
  "exports all raw Palm resources through compiled CLI and real stdio MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-palm-export-acceptance-");
    const path = join(root, "untrusted-resource.bin");
    const fixture = palmResourceFixture([
      { type: "code", id: 1, bytes: Buffer.from([1, 2, 3]) },
      { type: "../x", id: 65535, bytes: Buffer.from([0xe9, 0xff]) },
      { type: "tFRM", id: 1000, bytes: Buffer.from("opaque form bytes") },
      { type: "data", id: 0, bytes: Buffer.alloc(0) },
    ]);
    await writeFile(path, fixture.bytes);
    const cliRoot = join(root, "cli-export");
    const mcpRoot = join(root, "mcp-export");
    const contract = toolContract("extract_palm_resources");
    const client = new Client({ name: "palm-export-acceptance", version: "1" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve("scripts/rea.mjs"), "mcp"],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "", REA_LOG_LEVEL: "silent" },
    });
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools).toContainEqual(
        expect.objectContaining({
          name: contract.name,
          annotations: expect.objectContaining({
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: false,
          }),
        }),
      );
      const cliResult = await cli.run({
        arguments: [
          "extract-palm-resources",
          path,
          "--output",
          cliRoot,
          "--json",
        ],
      });
      expect(cliResult.exitCode).toBe(0);
      const cliEvidence = contract.outputSchema.parse(cliResult.json);
      const mcpResult = await client.callTool({
        name: contract.name,
        arguments: { path, output_root: mcpRoot },
      });
      expect(mcpResult.isError).not.toBe(true);
      const mcpEvidence = contract.outputSchema.parse(
        mcpResult.structuredContent,
      );
      expect(mcpEvidence.normalized_result.inventory).toEqual(
        cliEvidence.normalized_result.inventory,
      );
      expect(mcpEvidence.normalized_result.files).toEqual(
        cliEvidence.normalized_result.files,
      );
      for (const evidence of [cliEvidence, mcpEvidence]) {
        const report = evidence.normalized_result;
        expect(report.files).toHaveLength(4);
        expect(
          JSON.parse(
            await readFile(join(report.output_root, "manifest.json"), "utf8"),
          ),
        ).toEqual(report);
        expect(
          (await readdir(join(report.output_root, "resources"))).length,
        ).toBe(4);
        for (const file of report.files) {
          const resource = report.inventory.resources[file.resource_index]!;
          const { offset, bytes } = resource.payload.location;
          const exported = await readFile(
            join(report.output_root, file.relative_path),
          );
          expect(exported).toEqual(
            fixture.bytes.subarray(offset, offset + bytes),
          );
          expect(hash(exported)).toBe(resource.payload.sha256);
        }
      }
      expect(hash(await readFile(path))).toBe(hash(fixture.bytes));
      const repeated = await cli.run({
        arguments: [
          "extract-palm-resources",
          path,
          "--output",
          cliRoot,
          "--json",
        ],
      });
      const repeatedMcp = await client.callTool({
        name: contract.name,
        arguments: { path, output_root: cliRoot },
      });
      expect(repeated.exitCode).toBe(1);
      expect(parseMcpToolError(repeatedMcp)).toEqual({ error: repeated.json });
      expect(
        await readFile(
          join(cliRoot, cliEvidence.normalized_result.files[0]!.relative_path),
          "hex",
        ),
      ).toBe("010203");
    } finally {
      await client.close();
    }
  },
);

cliTest(
  "refuses malformed, limited and occupied Palm exports before changing caller files",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-palm-export-refusal-");
    const path = join(root, "malformed.prc");
    const fixture = palmResourceFixture();
    fixture.bytes.writeUInt32BE(100, 72);
    await writeFile(path, fixture.bytes);
    const output = join(root, "refused-export");
    const rejected = await cli.run({
      arguments: ["extract-palm-resources", path, "--output", output, "--json"],
    });
    expect(rejected.exitCode).toBe(1);
    await expect(access(output)).rejects.toThrow();
    fixture.bytes.writeUInt32BE(0, 72);
    await writeFile(path, fixture.bytes);
    const limited = await cli.run({
      arguments: [
        "extract-palm-resources",
        path,
        "--output",
        output,
        "--max-entries",
        "1",
        "--json",
      ],
    });
    expect(limited.exitCode).toBe(1);
    await expect(access(output)).rejects.toThrow();
    await mkdir(output);
    const sentinel = join(output, "keep.txt");
    await writeFile(sentinel, "Caller-owned bytes");
    const occupied = await cli.run({
      arguments: ["extract-palm-resources", path, "--output", output, "--json"],
    });
    expect(occupied.exitCode).toBe(1);
    expect(await readFile(sentinel, "utf8")).toBe("Caller-owned bytes");
    expect(await readdir(output)).toEqual(["keep.txt"]);
  },
);
