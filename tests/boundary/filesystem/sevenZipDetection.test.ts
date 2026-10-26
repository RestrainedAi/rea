import { createHash } from "node:crypto";
import { lstat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseBinaryTarget } from "../../../src/application/BinaryTargetResolver.js";
import { ArtifactResourceScope } from "../../../src/artifacts/ArtifactResourceScope.js";
import {
  classifyAndHashRoot,
  classifyAndHashRootForInventory,
} from "../../../src/artifacts/inventory/classify.js";
import { elf } from "../../../src/domain/binaryTarget.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

// These bytes establish a signature only; validity belongs to the archive reader.
const signature = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]);
const disguisedDmg = Buffer.alloc(1024);
signature.copy(disguisedDmg);
disguisedDmg.write("koly", 512, "ascii");

describe("7z root file classification", () => {
  it.each([
    { name: "opaque", bytes: signature, format: "7z" },
    { name: "renamed.exe", bytes: signature, format: "7z" },
    { name: "renamed.js", bytes: signature, format: "7z" },
    { name: "renamed.zip", bytes: signature, format: "7z" },
    { name: "renamed.hop", bytes: signature, format: "7z" },
    { name: "renamed.dmg", bytes: disguisedDmg, format: "7z" },
    { name: "decoy.7z", bytes: Buffer.from("ordinary data"), format: "file" },
    { name: "short.7z", bytes: signature.subarray(0, 5), format: "file" },
    {
      name: "wrong.7z",
      bytes: Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1d]),
      format: "file",
    },
    {
      name: "zip.7z",
      bytes: Buffer.from([0x50, 0x4b, 0x05, 0x06]),
      format: "zip",
    },
    { name: "program.7z", bytes: elf(2, 1, 0x3e), format: "elf" },
  ] as const)(
    "uses bytes for $name through target and root classification",
    async ({ name, bytes, format }) => {
      const root = await createTestTempDirectory("rea-7z-classification-");
      const path = join(root, name);
      await writeFile(path, bytes);
      const resources = new ArtifactResourceScope();
      try {
        const classified = await classifyAndHashRoot(
          path,
          false,
          await lstat(path),
          { resourceScope: resources },
        );
        expect(classified.format).toBe(format);
        expect(classified.digest?.sha256).toBe(
          createHash("sha256").update(bytes).digest("hex"),
        );
        const target = await parseBinaryTarget(path);
        if (format === "file") {
          expect(target).toMatchObject({
            ok: false,
            error: { _tag: "BinaryTargetError" },
          });
          return;
        }
        if (!target.ok) throw target.error;
        expect(target.value.format).toBe(format);
        expect(target.value.sha256).toBe(classified.digest?.sha256);
        if (format === "elf") {
          expect(target.value).toMatchObject({
            kind: "executable",
            architecture: "x86_64",
          });
        } else {
          expect(target.value.kind).toBe("archive");
          expect(target.value).not.toHaveProperty("architecture");
          expect(target.value).not.toHaveProperty("availableArchitectures");
          expect(target.value).not.toHaveProperty("managed");
        }
      } finally {
        await resources.close();
      }
    },
  );

  it("preserves explicit database selection and other implicit database identities", async () => {
    const root = await createTestTempDirectory("rea-7z-database-selection-");
    const explicit = join(root, "archive.data");
    const implicit = join(root, "analysis.hop");
    await writeFile(explicit, signature);
    await writeFile(implicit, Buffer.from("synthetic database bytes"));
    for (const result of [
      await parseBinaryTarget(explicit, { targetKind: "database" }),
      await parseBinaryTarget(implicit),
    ]) {
      if (!result.ok) throw result.error;
      expect(result.value).toMatchObject({
        kind: "database",
        format: "analysis-database",
      });
      expect(result.value).not.toHaveProperty("architecture");
    }
  });

  it("retains the same admitted root descriptor for a forthcoming 7z reader", async () => {
    const root = await createTestTempDirectory("rea-7z-retained-source-");
    const path = join(root, "archive.data");
    await writeFile(path, signature);
    const resources = new ArtifactResourceScope();
    try {
      await resources.run(async () => {
        const classified = await classifyAndHashRootForInventory(
          path,
          false,
          await lstat(path),
          { resourceScope: resources },
        );
        try {
          expect(classified.format).toBe("7z");
          expect(classified.rootSource).toBeDefined();
          if (classified.rootSource === undefined)
            throw new Error("Missing admitted 7z source");
          expect(classified.rootSource.initial.size).toBe(signature.length);
          const observed = Buffer.alloc(signature.length);
          await classified.rootSource.handle.read(
            observed,
            0,
            observed.length,
            0,
          );
          expect(observed).toEqual(signature);
        } finally {
          if (classified.rootSource !== undefined) {
            await resources.release({
              kind: "file-handle",
              handle: classified.rootSource.owner,
              resource: path,
            });
          }
        }
      });
    } finally {
      await resources.close();
    }
  });
});
