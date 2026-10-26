import { createHash } from "node:crypto";
import { access, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SafeOutputTree } from "../../artifacts/SafeOutputTree.js";
import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
import {
  extractSamsungFirmwareInputSchema,
  inspectSamsungFirmwareInputSchema,
} from "../../domain/firmware/samsungFirmware.js";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { SamsungFirmwareProvider } from "./SamsungFirmwareProvider.js";
import { SamsungFirmwareSource } from "./SamsungFirmwareSource.js";
import { samsungTarFixture } from "./SamsungTarDirectory.fixture.js";

afterEach(() => vi.restoreAllMocks());

const sha256 = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const extractInput = ({
  path,
  output_root,
}: {
  path: string;
  output_root: string;
}) => extractSamsungFirmwareInputSchema.parse({ path, output_root });
const fixtureFile = async (mismatch = false) => {
  const root = await createTestTempDirectory("rea-samsung-provider-");
  const path = join(root, "synthetic.tar.md5");
  const output_root = join(root, "export");
  const payload = Buffer.from([0, 1, 2, 0xff, 0x80]);
  const fixture = samsungTarFixture(
    [
      { name: "images/", typeflag: 53, payload: Buffer.alloc(0) },
      { name: "images/boot.img", payload },
      { name: "empty.img", payload: Buffer.alloc(0) },
    ],
    mismatch ? { declaredMd5: "0".repeat(32) } : {},
  );
  await writeFile(path, fixture.bytes);
  return { path, output_root, payload, ...fixture };
};

const refuseFirstSourceClose = () => {
  const open = SamsungFirmwareSource.open;
  let calls = 0;
  vi.spyOn(SamsungFirmwareSource, "open").mockImplementation(
    async (...args) => {
      const source = await open(...args);
      const close = source.owner.handle.close.bind(source.owner.handle);
      vi.spyOn(source.owner.handle, "close").mockImplementation(async () => {
        calls++;
        if (calls === 1) throw new Error("Probe: source close refused");
        await close();
      });
      return source;
    },
  );
  return () => calls;
};

describe("Samsung source and output failure ownership", () => {
  it("keeps output readback integrity failure distinct from an unchanged source", async () => {
    const fixture = await fixtureFile();
    const write = SafeOutputTree.prototype.write;
    vi.spyOn(SafeOutputTree.prototype, "write").mockImplementation(
      async function (this: SafeOutputTree, ...args) {
        await write.apply(this, args);
        throw new ArtifactReaderFailure(
          "integrity",
          "Durable readback verification failed: images/boot.img",
        );
      },
    );
    const provider = new SamsungFirmwareProvider();
    try {
      const result = await provider.extract(extractInput(fixture));
      if (result.ok) throw new Error("Expected output integrity refusal");
      expect(result.error).toMatchObject({
        _tag: "ArtifactOperationError",
        reason: "integrity",
      });
      expect(projectAnalysisError(result.error)).toMatchObject({
        code: "artifact_operation_failed",
        details: {
          operation: "extract_samsung_firmware",
          reason: "integrity",
          detail: "Durable readback verification failed: images/boot.img",
        },
      });
      expect(await readFile(fixture.path)).toEqual(fixture.bytes);
      await expect(access(fixture.output_root)).rejects.toThrow();
    } finally {
      await provider.close();
    }
  });

  it("preserves source mutation, both cleanup owners and the inventory after rollback and close fail", async () => {
    const fixture = await fixtureFile();
    const closeCalls = refuseFirstSourceClose();
    const write = SafeOutputTree.prototype.write;
    let altered = false;
    vi.spyOn(SafeOutputTree.prototype, "write").mockImplementation(
      async function (this: SafeOutputTree, ...args) {
        const result = await write.apply(this, args);
        if (!altered) {
          altered = true;
          const bytes = Buffer.from(fixture.bytes);
          bytes[0] = bytes[0]! ^ 1;
          await writeFile(fixture.path, bytes);
        }
        return result;
      },
    );
    vi.spyOn(SafeOutputTree.prototype, "rollback").mockRejectedValueOnce(
      new Error("Probe: rollback refused"),
    );
    const provider = new SamsungFirmwareProvider();
    try {
      const result = await provider.extract(extractInput(fixture));
      if (result.ok) throw new Error("Expected source mutation refusal");
      expect(projectAnalysisError(result.error)).toMatchObject({
        code: "cleanup_incomplete",
        details: {
          resources: [fixture.output_root, fixture.path],
          partial_observation: {
            kind: "firmware",
            result: {
              artifact: { path: fixture.path, sha256: sha256(fixture.bytes) },
            },
          },
          diagnostics: {
            primary_error: {
              code: "cleanup_incomplete",
              details: {
                diagnostics: {
                  primary_error: {
                    code: "artifact_changed",
                    details: { path: fixture.path },
                  },
                },
              },
            },
          },
        },
      });
      expect(closeCalls()).toBe(1);
      await access(fixture.output_root);
      await provider.close();
      expect(closeCalls()).toBe(2);
      await expect(access(fixture.output_root)).rejects.toThrow();
    } finally {
      await provider.close();
    }
  });

  it("retains a typed stored-MD5 refusal and its inventory when source close fails", async () => {
    const fixture = await fixtureFile(true);
    const closeCalls = refuseFirstSourceClose();
    const provider = new SamsungFirmwareProvider();
    try {
      const result = await provider.extract(extractInput(fixture));
      if (result.ok) throw new Error("Expected stored MD5 refusal");
      expect(projectAnalysisError(result.error)).toMatchObject({
        code: "cleanup_incomplete",
        details: {
          resources: [fixture.path],
          partial_observation: {
            kind: "firmware",
            result: { integrity: { status: "mismatch" } },
          },
          diagnostics: {
            primary_error: {
              code: "artifact_operation_failed",
              details: {
                reason: "integrity",
                detail: "Samsung firmware MD5 mismatch; no output was created.",
              },
            },
          },
        },
      });
      expect(closeCalls()).toBe(1);
      await expect(access(fixture.output_root)).rejects.toThrow();
      await provider.close();
      expect(closeCalls()).toBe(2);
    } finally {
      await provider.close();
    }
  });
});

describe("Samsung admitted source path identity", () => {
  it("reports removal after the complete byte pass as source mutation", async () => {
    const fixture = await fixtureFile();
    const read = SamsungFirmwareSource.prototype.readExact;
    vi.spyOn(SamsungFirmwareSource.prototype, "readExact").mockImplementation(
      async function (this: SamsungFirmwareSource, ...args) {
        const bytes = await read.apply(this, args);
        if (args[0] === 0 && args[1] === fixture.bytes.length)
          await unlink(fixture.path);
        return bytes;
      },
    );
    const provider = new SamsungFirmwareProvider();
    try {
      const result = await provider.inspect(
        inspectSamsungFirmwareInputSchema.parse({ path: fixture.path }),
      );
      if (result.ok) throw new Error("Expected removed source refusal");
      expect(projectAnalysisError(result.error)).toMatchObject({
        code: "artifact_changed",
        details: { path: fixture.path, boundary: "stable-artifact-read" },
      });
    } finally {
      await provider.close();
    }
  });
});

describe("streamed Samsung firmware provider", () => {
  it.each([false, true])(
    "retains complete hashes and MD5 mismatch=%s as inspection facts",
    async (mismatch) => {
      const fixture = await fixtureFile(mismatch);
      const provider = new SamsungFirmwareProvider();
      try {
        const result = await provider.inspect(
          inspectSamsungFirmwareInputSchema.parse({ path: fixture.path }),
        );
        if (!result.ok) throw result.error;
        expect(result.value.artifact).toEqual({
          path: fixture.path,
          bytes: fixture.bytes.length,
          sha256: sha256(fixture.bytes),
        });
        expect(result.value.integrity).toMatchObject({
          status: mismatch ? "mismatch" : "match",
          checksum_range: { offset: 0, bytes: fixture.checksumRecordOffset },
        });
        expect(result.value.entries[1]?.payload.sha256).toBe(
          sha256(fixture.payload),
        );
        expect(result.value.coverage).toMatchObject({
          headers: 3,
          files: 2,
          source_bytes_hashed: fixture.bytes.length,
        });
        expect(await readFile(fixture.path)).toEqual(fixture.bytes);
      } finally {
        await provider.close();
      }
    },
  );

  it("exports verified regular files, unchanged footer bytes and a complete manifest", async () => {
    const fixture = await fixtureFile();
    const provider = new SamsungFirmwareProvider();
    try {
      const result = await provider.extract(extractInput(fixture));
      if (!result.ok) throw result.error;
      expect(
        await readFile(join(fixture.output_root, "images", "boot.img")),
      ).toEqual(fixture.payload);
      expect(await readFile(join(fixture.output_root, "empty.img"))).toEqual(
        Buffer.alloc(0),
      );
      expect(
        await readFile(join(fixture.output_root, "__samsung_footer.bin")),
      ).toEqual(fixture.bytes.subarray(fixture.footerOffset));
      expect(
        JSON.parse(
          await readFile(join(fixture.output_root, "manifest.json"), "utf8"),
        ),
      ).toEqual(result.value);
      expect(result.value.files.map((file) => file.entry_index)).toEqual([
        1, 2,
      ]);
      expect(await readFile(fixture.path)).toEqual(fixture.bytes);
    } finally {
      await provider.close();
    }
  });

  it("refuses mismatched firmware before creating any output", async () => {
    const fixture = await fixtureFile(true);
    const provider = new SamsungFirmwareProvider();
    const create = vi.spyOn(SafeOutputTree, "create");
    try {
      const result = await provider.extract(extractInput(fixture));
      expect(result).toMatchObject({
        ok: false,
        error: { _tag: "ArtifactOperationError", reason: "integrity" },
      });
      expect(create).not.toHaveBeenCalled();
      await expect(access(fixture.output_root)).rejects.toThrow();
    } finally {
      await provider.close();
    }
  });

  it("refuses a source changed after output reads and rolls back verified output", async () => {
    const fixture = await fixtureFile();
    const original = SafeOutputTree.prototype.write;
    let changed = false;
    vi.spyOn(SafeOutputTree.prototype, "write").mockImplementation(
      async function (this: SafeOutputTree, ...args) {
        const result = await original.apply(this, args);
        if (!changed) {
          changed = true;
          const altered = Buffer.from(fixture.bytes);
          altered[0] = altered[0]! ^ 1;
          await writeFile(fixture.path, altered);
        }
        return result;
      },
    );
    const provider = new SamsungFirmwareProvider();
    try {
      expect(await provider.extract(extractInput(fixture))).toMatchObject({
        ok: false,
        error: { _tag: "AnalysisArtifactChangedError" },
      });
      await expect(access(fixture.output_root)).rejects.toThrow();
    } finally {
      await provider.close();
    }
  });
});

describe("Samsung firmware cancellation and retained ownership", () => {
  it("checks cancellation after closing the source and before commit", async () => {
    const fixture = await fixtureFile();
    const controller = new AbortController();
    const close = SamsungFirmwareSource.prototype.close;
    vi.spyOn(SamsungFirmwareSource.prototype, "close").mockImplementation(
      async function (this: SamsungFirmwareSource) {
        await close.call(this);
        controller.abort();
      },
    );
    const commit = vi.spyOn(SafeOutputTree.prototype, "commit");
    const provider = new SamsungFirmwareProvider();
    try {
      expect(
        await provider.extract(extractInput(fixture), {
          signal: controller.signal,
        }),
      ).toMatchObject({ ok: false, error: { _tag: "AnalysisCancelledError" } });
      expect(commit).not.toHaveBeenCalled();
      await expect(access(fixture.output_root)).rejects.toThrow();
    } finally {
      await provider.close();
    }
  });

  it.each(["inspect", "extract"] as const)(
    "retains a failed %s source close without retrying it in the same operation",
    async (operation) => {
      const fixture = await fixtureFile();
      const open = SamsungFirmwareSource.open;
      let closeCalls = 0;
      vi.spyOn(SamsungFirmwareSource, "open").mockImplementation(
        async (...args) => {
          const source = await open(...args);
          const close = source.owner.handle.close.bind(source.owner.handle);
          vi.spyOn(source.owner.handle, "close").mockImplementation(
            async () => {
              closeCalls++;
              if (closeCalls === 1)
                throw new Error("Probe: source close refused");
              await close();
            },
          );
          return source;
        },
      );
      const provider = new SamsungFirmwareProvider();
      const result =
        operation === "inspect"
          ? await provider.inspect(
              inspectSamsungFirmwareInputSchema.parse({ path: fixture.path }),
            )
          : await provider.extract(extractInput(fixture));
      expect(result).toMatchObject({
        ok: false,
        error: {
          cleanupIncomplete: true,
          cleanupResources: [fixture.path],
          partialObservation: {
            kind: "firmware",
            result: {
              artifact: { path: fixture.path },
              integrity: { status: "match" },
            },
          },
        },
      });
      expect(closeCalls).toBe(1);
      await expect(access(fixture.output_root)).rejects.toThrow();
      await provider.close();
      expect(closeCalls).toBe(2);
    },
  );

  it("retains failed cancellation rollback and retries only its owned tree on close", async () => {
    const fixture = await fixtureFile();
    const controller = new AbortController();
    const original = SafeOutputTree.prototype.write;
    vi.spyOn(SafeOutputTree.prototype, "write").mockImplementation(
      async function (this: SafeOutputTree, ...args) {
        const result = await original.apply(this, args);
        controller.abort();
        return result;
      },
    );
    vi.spyOn(SafeOutputTree.prototype, "rollback").mockRejectedValueOnce(
      new ArtifactReaderFailure("io", "Probe: cleanup refused"),
    );
    const provider = new SamsungFirmwareProvider();
    const result = await provider.extract(extractInput(fixture), {
      signal: controller.signal,
    });
    expect(result).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisCancelledError",
        cleanupIncomplete: true,
        cleanupResources: [fixture.output_root],
        partialObservation: { kind: "firmware" },
      },
    });
    await access(fixture.output_root);
    await provider.close();
    await expect(access(fixture.output_root)).rejects.toThrow();
  });
});

describe("Samsung firmware publication and resource limits", () => {
  it("preserves a published extraction when later output cleanup fails", async () => {
    const fixture = await fixtureFile();
    const commit = SafeOutputTree.prototype.commit;
    vi.spyOn(SafeOutputTree.prototype, "commit").mockImplementation(
      async function (this: SafeOutputTree) {
        await commit.call(this);
        throw new Error("Probe: post-publication cleanup failure");
      },
    );
    vi.spyOn(SafeOutputTree.prototype, "rollback").mockRejectedValueOnce(
      new Error("Probe: output cleanup refused"),
    );
    const provider = new SamsungFirmwareProvider();
    try {
      const result = await provider.extract(extractInput(fixture));
      expect(result).toMatchObject({
        ok: false,
        error: {
          cleanupIncomplete: true,
          cleanupResources: [fixture.output_root],
          partialObservation: {
            kind: "firmware",
            result: {
              output_root: fixture.output_root,
              files: [{ entry_index: 1 }, { entry_index: 2 }],
            },
          },
        },
      });
      expect(
        await readFile(join(fixture.output_root, "images", "boot.img")),
      ).toEqual(fixture.payload);
      await provider.close();
      await access(join(fixture.output_root, "manifest.json"));
    } finally {
      await provider.close();
    }
  });

  it("keeps a source byte-budget refusal in the file-size resource category", async () => {
    const fixture = await fixtureFile();
    const provider = new SamsungFirmwareProvider();
    try {
      expect(
        await provider.inspect(
          inspectSamsungFirmwareInputSchema.parse({
            path: fixture.path,
            max_file_bytes: 1024,
          }),
        ),
      ).toMatchObject({
        ok: false,
        error: {
          _tag: "AnalysisResourceConstraintError",
          resource: "file-size",
        },
      });
    } finally {
      await provider.close();
    }
  });
});
