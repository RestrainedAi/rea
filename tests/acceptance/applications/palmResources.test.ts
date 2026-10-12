import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { palmResourceFixture } from "../../../src/native/palm/PalmResources.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "inspects all Palm resources through compiled CLI and real stdio MCP without an engine",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-palm-resource-acceptance-");
    const path = join(root, "resource-database.bin");
    const fixture = palmResourceFixture(
      undefined,
      7,
      Buffer.from("APP"),
      Buffer.from("SORT"),
    );
    await writeFile(path, fixture.bytes);
    const inputHash = createHash("sha256").update(fixture.bytes).digest("hex");
    const client = new Client({
      name: "palm-resource-acceptance",
      version: "1",
    });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve("scripts/rea.mjs"), "mcp"],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "", REA_LOG_LEVEL: "silent" },
    });
    const contract = toolContract("inspect_palm_resources");
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools).toContainEqual(
        expect.objectContaining({
          name: contract.name,
          annotations: expect.objectContaining({ openWorldHint: false }),
        }),
      );
      const cliResult = await cli.run({
        arguments: ["inspect-palm-resources", path, "--json"],
      });
      expect(cliResult.exitCode).toBe(0);
      const cliEvidence = contract.outputSchema.parse(cliResult.json);
      expect(cliEvidence).toMatchObject({
        operation: "inspect_palm_resources",
        subject: { digest: { sha256: inputHash } },
        normalized_result: {
          format: "palm-resource-database",
          header: { resource_count: 4 },
          coverage: { status: "complete", examined_entries: 4, resources: 4 },
        },
      });
      const mcp = await client.callTool({
        name: contract.name,
        arguments: { path },
      });
      expect(mcp.isError).not.toBe(true);
      const mcpEvidence = contract.outputSchema.parse(mcp.structuredContent);
      expect(mcpEvidence).toEqual(cliEvidence);
      const last = mcpEvidence.normalized_result.resources.at(-1)!;
      expect(last.payload.location.offset + last.payload.location.bytes).toBe(
        fixture.bytes.length,
      );
      const bundle = await client.callTool({
        name: "get_evidence_bundle",
        arguments: {
          detail: "summary",
          filters: { operation: "inspect_palm_resources" },
        },
      });
      expect(bundle.isError).not.toBe(true);
      expect(JSON.stringify(bundle.structuredContent)).toContain(
        mcpEvidence.evidence_id,
      );
      expect(
        createHash("sha256")
          .update(await readFile(path))
          .digest("hex"),
      ).toBe(inputHash);
      for (const [name, mutate] of [
        [
          "ebook.prc",
          (b: Buffer) => {
            b.writeUInt16BE(0, 32);
            b.write("BOOK", 60);
            b.write("MOBI", 64);
          },
        ],
        ["chained.prc", (b: Buffer) => b.writeUInt32BE(0x100, 72)],
        ["bad-offset.prc", (b: Buffer) => b.writeUInt32BE(0xffffffff, 84)],
      ] as const) {
        const badPath = join(root, name);
        const bytes = Buffer.from(fixture.bytes);
        mutate(bytes);
        await writeFile(badPath, bytes);
        const badCli = await cli.run({
          arguments: ["inspect-palm-resources", badPath, "--json"],
        });
        expect(badCli.exitCode).toBe(1);
        const badMcp = await client.callTool({
          name: contract.name,
          arguments: { path: badPath },
        });
        expect(badMcp.isError).toBe(true);
        expect(parseMcpToolError(badMcp)).toEqual({ error: badCli.json });
      }
      for (const args of [
        { path, max_entries: 1 },
        { path, max_file_bytes: 78 },
        { path: "relative.prc" },
        { path, unexpected: true },
      ]) {
        const failed = await client.callTool({
          name: contract.name,
          arguments: args,
        });
        expect(failed.isError).toBe(true);
      }
    } finally {
      await client.close();
    }
  },
);
