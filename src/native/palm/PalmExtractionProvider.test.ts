import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SafeOutputTree } from "../../artifacts/SafeOutputTree.js";
import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import { extractPalmResourcesInputSchema } from "../../domain/native/palmResources.js";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { PalmExtractionProvider } from "./PalmExtractionProvider.js";
import { palmResourceFixture } from "./PalmResources.fixture.js";

afterEach(() => vi.restoreAllMocks());

describe("Palm export cancellation and retained ownership", () => {
  it.each([false, true])(
    "rolls back an owned output tree and retains failed cleanup=%s",
    async (failedCleanup) => {
      const root = await createTestTempDirectory("rea-palm-export-cancel-");
      const path = join(root, "input.prc");
      const output_root = join(root, "export");
      const bytes = palmResourceFixture().bytes;
      await writeFile(path, bytes);
      const controller = new AbortController();
      const originalWrite = SafeOutputTree.prototype.write;
      vi.spyOn(SafeOutputTree.prototype, "write").mockImplementation(
        async function (this: SafeOutputTree, ...args) {
          const file = await originalWrite.apply(this, args);
          controller.abort();
          return file;
        },
      );
      if (failedCleanup)
        vi.spyOn(SafeOutputTree.prototype, "rollback").mockRejectedValueOnce(
          new ArtifactReaderFailure("io", "Probe: one cleanup attempt failed"),
        );
      const provider = new PalmExtractionProvider();
      const result = await provider.extract(
        extractPalmResourcesInputSchema.parse({ path, output_root }),
        { signal: controller.signal },
      );
      expect(result).toMatchObject({
        ok: false,
        error: {
          _tag: "AnalysisCancelledError",
          cleanupIncomplete: failedCleanup,
        },
      });
      if (failedCleanup) {
        expect(result).toMatchObject({
          error: { cleanupResources: [output_root] },
        });
        await access(output_root);
      } else await expect(access(output_root)).rejects.toThrow();
      await provider.close();
      await expect(access(output_root)).rejects.toThrow();
      expect(await readFile(path)).toEqual(bytes);
    },
  );
});
