import { createHash } from "node:crypto";
import {
  access,
  open,
  readFile,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { join } from "node:path";
import { Writable, type Readable } from "node:stream";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { OwnedFileHandle } from "../filesystem/OwnedFileHandle.js";
import { ArtifactResourceScope } from "./ArtifactResourceScope.js";
import { InstylerArtifactReader } from "./InstylerArtifactReader.js";
import type { ArtifactEntry } from "./ArtifactReader.js";
import {
  extractArtifact,
  materializeArtifactInventory,
} from "./extraction/ArtifactExtraction.js";
import { scanArtifactInventory } from "./inventory/ArtifactInventory.js";
import { instylerArchiveFixture } from "./instyler/InstylerDirectory.fixture.js";
import { INSTYLER_SOURCE_BYTES } from "./instyler/InstylerDirectory.js";

afterEach(() => vi.restoreAllMocks());

const digest = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");
const collect = async (stream: Readable): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
};
const entriesOf = async (
  reader: InstylerArtifactReader,
): Promise<ArtifactEntry[]> => {
  const entries: ArtifactEntry[] = [];
  for await (const entry of reader.entries()) entries.push(entry);
  return entries;
};

describe("Instyler artifact reader ownership and decompression", () => {
  it("exports opaque metadata and decoded members while preserving borrowed input and entry identity", async () => {
    const root = await createTestTempDirectory("rea-instyler-borrowed-");
    const path = join(root, "archive.exe");
    const payload = Buffer.from([0xe9, 0, 0xff, 42]);
    const fixture = instylerArchiveFixture([
      { filename: "%appfolder%\\caf\xe9.bin", bytes: payload },
    ]);
    await writeFile(path, fixture.bytes);
    const handle = await open(path, "r");
    onTestFinished(() => handle.close());
    const reader = new InstylerArtifactReader(path, {
      handle,
      initial: await handle.stat(),
    });
    onTestFinished(() => reader.close());
    const entries = await entriesOf(reader);
    const metadata = entries[0]!;
    const member = entries[1]!;
    expect(metadata).toMatchObject({
      path: "__instyler_metadata.bin",
      byteOffset: fixture.overlayOffset,
      declaredSize: fixture.dataOffset - fixture.overlayOffset,
    });
    expect(await collect(await reader.open(metadata))).toEqual(
      fixture.bytes.subarray(fixture.overlayOffset, fixture.dataOffset),
    );
    expect(member).toMatchObject({
      path: "%appfolder%/caf\xe9.bin",
      byteOffset: null,
      declaredSize: payload.length,
    });
    expect(member.limitations.join(" ")).toContain("636166e92e62696e");
    await expect(
      reader.open({ ...member, declaredSize: payload.length + 1 }),
    ).rejects.toMatchObject({ reason: "integrity" });
    await expect(
      reader.open({ ...member, adapterKey: "instyler-member:999" }),
    ).rejects.toMatchObject({ reason: "integrity" });
    expect(await collect(await reader.open(member))).toEqual(payload);
    await reader.close();
    expect((await handle.stat()).size).toBe(fixture.bytes.length);
    expect(await readFile(path)).toEqual(fixture.bytes);
  });

  it.each(["checksum", "trailing", "short", "long"] as const)(
    "refuses invalid %s compressed-member observations",
    async (fault) => {
      const root = await createTestTempDirectory("rea-instyler-integrity-");
      const path = join(root, "archive.exe");
      const fixture = instylerArchiveFixture([
        { filename: "data.bin", bytes: Buffer.alloc(250_000, 0x5a) },
      ]);
      let bytes = Buffer.from(fixture.bytes);
      const record = fixture.recordOffsets[0]!;
      if (fault === "checksum")
        bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
      if (fault === "trailing") {
        bytes.writeUInt32LE(bytes.readUInt32LE(record + 282) + 1, record + 282);
        bytes = Buffer.concat([bytes, Buffer.from([0x5a])]);
      }
      if (fault === "short") bytes.writeUInt32LE(0, record + 278);
      if (fault === "long") bytes.writeUInt32LE(250_001, record + 278);
      await writeFile(path, bytes);
      const reader = new InstylerArtifactReader(path);
      onTestFinished(() => reader.close());
      const entries = await entriesOf(reader);
      await expect(reader.open(entries[1]!)).rejects.toMatchObject({
        reason: "integrity",
      });
    },
  );

  it("cancels an active inflater without closing a borrowed source or retaining failed decoded bytes", async () => {
    const root = await createTestTempDirectory("rea-instyler-cancel-");
    const path = join(root, "archive.exe");
    const payload = Buffer.alloc(256 * 1024, 0x5a);
    const fixture = instylerArchiveFixture([
      { filename: "large.bin", bytes: payload },
    ]);
    await writeFile(path, fixture.bytes);
    const handle = await open(path, "r");
    onTestFinished(() => handle.close());
    const reader = new InstylerArtifactReader(path, {
      handle,
      initial: await handle.stat(),
    });
    onTestFinished(() => reader.close());
    const entries = await entriesOf(reader);
    const controller = new AbortController();
    const originalWrite = Writable.prototype.write;
    const progress = vi
      .spyOn(Writable.prototype, "write")
      .mockImplementation(function (this: Writable, ...args) {
        const accepted = originalWrite.apply(this, args);
        // The plain Writable is the decoded-byte sink, after a real zlib output chunk.
        if (this.constructor === Writable) controller.abort();
        return accepted;
      });
    try {
      await expect(
        reader.open(entries[1]!, controller.signal),
      ).rejects.toMatchObject({ reason: "cancelled" });
    } finally {
      progress.mockRestore();
    }
    expect((await handle.stat()).size).toBe(fixture.bytes.length);
    expect(await collect(await reader.open(entries[1]!))).toEqual(payload);
    await reader.close();
    expect((await handle.stat()).size).toBe(fixture.bytes.length);
  });

  it("retains the exact acquired descriptor after an unconfirmed close and retries its cleanup", async () => {
    const root = await createTestTempDirectory("rea-instyler-close-");
    const path = join(root, "archive.exe");
    await writeFile(path, instylerArchiveFixture().bytes);
    const reader = new InstylerArtifactReader(path);
    onTestFinished(() => reader.close());
    await reader.prepare();
    let retained: FileHandle | undefined;
    const originalClose = OwnedFileHandle.prototype.close;
    const spy = vi
      .spyOn(OwnedFileHandle.prototype, "close")
      .mockImplementationOnce(function (this: OwnedFileHandle) {
        retained = this.handle;
        return Promise.reject(new Error("Probe: descriptor close failed"));
      });
    await expect(reader.close()).rejects.toThrow(
      "Probe: descriptor close failed",
    );
    if (retained === undefined) throw new Error("Expected retained descriptor");
    expect((await retained.stat()).isFile()).toBe(true);
    spy.mockImplementation(originalClose);
    await reader.close();
    expect(retained.fd).toBe(-1);
    expect(await readFile(path)).toEqual(instylerArchiveFixture().bytes);
  });

  it.each(["__instyler_metadata.bin", "folder\\..\\escape.bin"])(
    "rejects conflicting or unsafe logical path %s",
    async (filename) => {
      const root = await createTestTempDirectory("rea-instyler-path-");
      const path = join(root, "archive.exe");
      const fixture = instylerArchiveFixture([
        { filename, bytes: Buffer.from("controlled") },
      ]);
      await writeFile(path, fixture.bytes);
      const reader = new InstylerArtifactReader(path);
      onTestFinished(() => reader.close());
      await expect(reader.prepare()).rejects.toMatchObject({ reason: "path" });
      expect(await readFile(path)).toEqual(fixture.bytes);
    },
  );
});

describe("Instyler shared artifact integration", () => {
  it("keeps unrecognized PE headers root-only while recognized malformed Instyler framing fails explicitly", async () => {
    const root = await createTestTempDirectory("rea-instyler-pe-fallback-");
    const path = join(root, "signature-only.exe");
    const ordinary = Buffer.alloc(160);
    ordinary.write("MZ", 0);
    ordinary.writeUInt32LE(128, 60);
    ordinary.writeUInt32LE(0x4550, 128);
    await writeFile(path, ordinary);
    const scope = new ArtifactResourceScope();
    onTestFinished(() => scope.close());
    const snapshot = await scanArtifactInventory(path, {
      resourceScope: scope,
    });
    expect(snapshot.manifest.root_format).toBe("pe");
    expect(snapshot.occurrences).toHaveLength(1);
    expect(snapshot.limitations.join(" ")).toContain(
      "profile was not recognized",
    );

    const malformed = instylerArchiveFixture();
    malformed.bytes.writeUInt16LE(0, 0x98);
    await writeFile(path, malformed.bytes);
    expect(
      (await scanArtifactInventory(path, { resourceScope: scope })).occurrences,
    ).toHaveLength(1);
    const recognized = instylerArchiveFixture();
    recognized.bytes[recognized.recordOffsets[0]! + 286] = 1;
    await writeFile(path, recognized.bytes);
    await expect(
      scanArtifactInventory(path, { resourceScope: scope }),
    ).rejects.toMatchObject({
      reason: "format",
      message: expect.stringContaining(
        "outside the supported plain zlib profile",
      ),
    });
  });

  it("preserves root PE identity through inventory/export and refuses changed metadata before output creation", async () => {
    const root = await createTestTempDirectory("rea-instyler-integration-");
    const path = join(root, "archive.exe");
    const fixture = instylerArchiveFixture();
    await writeFile(path, fixture.bytes);
    const scope = new ArtifactResourceScope();
    onTestFinished(() => scope.close());
    const snapshot = await scanArtifactInventory(path, {
      resourceScope: scope,
    });
    expect(snapshot.manifest).toMatchObject({
      root_format: "pe",
      root_sha256: digest(fixture.bytes),
    });
    expect(
      snapshot.occurrences
        .filter(
          (entry) => entry.logical_path !== "." && entry.entry_kind === "file",
        )
        .map((entry) => entry.logical_path),
    ).toEqual([
      "%appfolder%/application.exe",
      "%appfolder%/empty.bin",
      "__instyler_metadata.bin",
    ]);
    const output = join(root, "export");
    const input = {
      inputPath: path,
      inputFormat: "pe" as const,
      outputRoot: output,
      environment: {},
      integrityPolicy: "fail" as const,
      resourceScope: scope,
    };
    const result = await materializeArtifactInventory(input, path, snapshot);
    expect(result.artifacts).toHaveLength(3);
    expect(
      await readFile(join(output, "%appfolder%", "application.exe"), "utf8"),
    ).toBe("Controlled payload");
    expect(await readFile(join(output, "__instyler_metadata.bin"))).toEqual(
      fixture.bytes.subarray(fixture.overlayOffset, fixture.dataOffset),
    );
    const changed = Buffer.from(fixture.bytes);
    changed[fixture.dataOffset - 1] = 1;
    await writeFile(path, changed);
    const refused = join(root, "refused");
    await expect(
      materializeArtifactInventory(
        { ...input, outputRoot: refused },
        path,
        snapshot,
      ),
    ).rejects.toMatchObject({
      reason: "integrity",
      message: "Instyler root bytes changed after inventory",
    });
    await expect(access(refused)).rejects.toThrow();
    expect(await readFile(path)).toEqual(changed);
  });

  it("keeps large ordinary PE inspection root-only and refuses extraction before creating output", async () => {
    const root = await createTestTempDirectory("rea-instyler-ordinary-pe-");
    const path = join(root, "ordinary.exe");
    await writeFile(path, instylerArchiveFixture().bytes.subarray(0, 1024));
    const handle = await open(path, "r+");
    await handle.truncate(INSTYLER_SOURCE_BYTES + 1);
    await handle.close();
    const reader = new InstylerArtifactReader(path);
    onTestFinished(() => reader.close());
    expect(await reader.prepare()).toBe(false);
    expect(await entriesOf(reader)).toEqual([]);
    expect(reader.limitations.join(" ")).toContain(
      "profile was not recognized",
    );
    const scope = new ArtifactResourceScope();
    onTestFinished(() => scope.close());
    const output = join(root, "refused");
    await expect(
      extractArtifact({
        inputPath: path,
        inputFormat: "pe",
        outputRoot: output,
        environment: {},
        integrityPolicy: "fail",
        resourceScope: scope,
      }),
    ).rejects.toMatchObject({ _tag: "AnalysisUnsupportedTargetError" });
    await expect(access(output)).rejects.toThrow();
  });
});
