import { createHash } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { ArtifactReaderFailure, type ArtifactEntry } from "./ArtifactReader.js";
import { ArtifactResourceScope } from "./ArtifactResourceScope.js";
import { InstylerArtifactReader } from "./InstylerArtifactReader.js";
import { PeInstallerArtifactReader } from "./PeInstallerArtifactReader.js";
import { materializeArtifactInventory } from "./extraction/ArtifactExtraction.js";
import { scanArtifactInventory } from "./inventory/ArtifactInventory.js";
import { instylerArchiveFixture } from "./instyler/InstylerDirectory.fixture.js";
import * as bridge from "./staticArchive/StaticArchiveBridge.js";
import * as configuration from "./staticArchive/StaticArchiveConfiguration.js";

afterEach(() => vi.restoreAllMocks());
const digest = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const ordinaryPe = () => instylerArchiveFixture().bytes.subarray(0, 1024);
const environment = {
  REA_STATIC_ARCHIVE_MANIFEST: "controlled-static-manifest",
};
const sourceFile = async (bytes: Buffer) => {
  const root = await createTestTempDirectory("rea-pe-dispatch-");
  const path = join(root, "supplied.bin");
  await writeFile(path, bytes);
  return { root, path, bytes };
};
const entriesOf = async (reader: PeInstallerArtifactReader) => {
  const entries: ArtifactEntry[] = [];
  for await (const entry of reader.entries()) entries.push(entry);
  return entries;
};
const collect = async (stream: Readable) => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
};
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const opaque = Buffer.from("controlled static child bytes\n");
const staticSnapshot = (
  sourceSha256: string,
): bridge.StaticArchiveSnapshot => ({
  sourceSha256,
  metadata: { profile: "controlled-static-profile", members_observed: 1 },
  members: [
    {
      ordinal: 0,
      rawName: "inner/payload.bin",
      kind: "file",
      bytes: opaque.length,
      sha256: digest(opaque),
    },
  ],
  open: vi.fn(async () =>
    Readable.from([Buffer.from(opaque)], { objectMode: false }),
  ),
  provenance: () => [
    {
      tool: "controlled-static-decoder",
      arguments: ["$ARTIFACT"],
      tool_version: "1",
      executable_sha256: "b".repeat(64),
      exit_code: 0,
      effects: ["read", "write"],
    },
  ],
  close: vi.fn(async () => {}),
});

describe("PE installer dispatch over real existing format fixtures", () => {
  it("keeps ordinary PE root-only without activating a configured decoder", async () => {
    const source = await sourceFile(ordinaryPe());
    const pinned = vi.spyOn(configuration, "pinStaticArchiveInstallation");
    const scope = new ArtifactResourceScope();
    onTestFinished(() => scope.close());
    const inventory = await scanArtifactInventory(source.path, {
      environment,
      resourceScope: scope,
    });
    expect(inventory.manifest).toMatchObject({
      root_format: "pe",
      root_sha256: digest(source.bytes),
    });
    expect(inventory.occurrences).toHaveLength(1);
    expect(pinned).not.toHaveBeenCalled();
    const outputRoot = join(source.root, "refused");
    await expect(
      materializeArtifactInventory(
        {
          inputPath: source.path,
          inputFormat: "pe",
          outputRoot,
          environment,
          integrityPolicy: "fail",
          resourceScope: scope,
        },
        source.path,
        inventory,
      ),
    ).rejects.toMatchObject({ _tag: "AnalysisUnsupportedTargetError" });
    await expect(access(outputRoot)).rejects.toThrow();
    expect(pinned).not.toHaveBeenCalled();
    expect(await readFile(source.path)).toEqual(source.bytes);
  });

  it("never falls through a recognized malformed Instyler directory", async () => {
    const fixture = instylerArchiveFixture();
    fixture.bytes[fixture.recordOffsets[0]! + 286] = 1;
    const source = await sourceFile(fixture.bytes);
    const fallback = vi
      .spyOn(bridge, "openStaticArchive")
      .mockResolvedValue(undefined);
    const reader = new PeInstallerArtifactReader(
      source.path,
      environment,
      undefined,
      digest(source.bytes),
    );
    onTestFinished(() => reader.close());
    await expect(reader.prepare()).rejects.toMatchObject({
      reason: "format",
      message: expect.stringContaining(
        "outside the supported plain zlib profile",
      ),
    });
    expect(fallback).not.toHaveBeenCalled();
    expect(await readFile(source.path)).toEqual(source.bytes);
  });

  it("preserves valid Instyler decoding without invoking the later static profile", async () => {
    const payload = Buffer.from([0, 0xff, 0x80, 42]);
    const source = await sourceFile(
      instylerArchiveFixture([
        { filename: "%appfolder%\\original.bin", bytes: payload },
      ]).bytes,
    );
    const fallback = vi
      .spyOn(bridge, "openStaticArchive")
      .mockResolvedValue(undefined);
    const reader = new PeInstallerArtifactReader(
      source.path,
      environment,
      undefined,
      digest(source.bytes),
    );
    onTestFinished(() => reader.close());
    const entries = await entriesOf(reader);
    expect(entries.map((entry) => entry.path)).toEqual([
      "__instyler_metadata.bin",
      "%appfolder%/original.bin",
    ]);
    expect(await collect(await reader.open(entries[1]!))).toEqual(payload);
    expect(fallback).not.toHaveBeenCalled();
    expect(reader.limitations.join(" ")).toContain("Instyler Ex-it!");
    expect(await readFile(source.path)).toEqual(source.bytes);
  });
});

describe("shared artifact factory inventory/extraction selection", () => {
  it.each(["pe", "7z"] as const)(
    "uses the configured static profile consistently for %s inventory and materialization",
    async (format) => {
      const bytes =
        format === "pe"
          ? ordinaryPe()
          : Buffer.concat([
              Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]),
              Buffer.alloc(26),
            ]);
      const source = await sourceFile(bytes);
      const snapshots: bridge.StaticArchiveSnapshot[] = [];
      const fallback = vi
        .spyOn(bridge, "openStaticArchive")
        .mockImplementation(async (input) => {
          expect(input.path).toBe(source.path);
          expect(input.expectedRootSha256).toBe(digest(bytes));
          const snapshot = staticSnapshot(digest(bytes));
          snapshots.push(snapshot);
          return snapshot;
        });
      const scope = new ArtifactResourceScope();
      onTestFinished(() => scope.close());
      const inventory = await scanArtifactInventory(source.path, {
        environment,
        resourceScope: scope,
      });
      expect(inventory.manifest).toMatchObject({
        root_format: format,
        root_sha256: digest(bytes),
      });
      expect(
        inventory.occurrences
          .filter(
            (entry) =>
              entry.entry_kind === "file" && entry.logical_path !== ".",
          )
          .map((entry) => entry.logical_path)
          .sort(),
      ).toEqual(["__rea_archive_metadata.json", "inner/payload.bin"]);
      const outputRoot = join(source.root, "export");
      const extracted = await materializeArtifactInventory(
        {
          inputPath: source.path,
          inputFormat: format,
          outputRoot,
          environment,
          integrityPolicy: "fail",
          resourceScope: scope,
        },
        source.path,
        inventory,
      );
      expect(await readFile(join(outputRoot, "inner", "payload.bin"))).toEqual(
        opaque,
      );
      const metadata = JSON.parse(
        await readFile(join(outputRoot, "__rea_archive_metadata.json"), "utf8"),
      );
      expect(metadata).toMatchObject({
        source_sha256: digest(bytes),
        members: [{ ordinal: 0, rawName: "inner/payload.bin" }],
      });
      expect(extracted.artifacts).toHaveLength(2);
      expect(fallback).toHaveBeenCalledTimes(2);
      expect(
        snapshots.every(
          (snapshot) => vi.mocked(snapshot.close).mock.calls.length === 1,
        ),
      ).toBe(true);
      expect(await readFile(source.path)).toEqual(bytes);
    },
  );
});

describe("PE preparation cancellation and retained child ownership", () => {
  it("prevents fallback when the first reader cannot close and retains that reader for cleanup", async () => {
    const source = await sourceFile(ordinaryPe());
    const fallback = vi
      .spyOn(bridge, "openStaticArchive")
      .mockResolvedValue(undefined);
    const close = vi
      .spyOn(InstylerArtifactReader.prototype, "close")
      .mockRejectedValueOnce(
        new ArtifactReaderFailure(
          "unavailable",
          "Probe: first descriptor still held",
        ),
      );
    const reader = new PeInstallerArtifactReader(
      source.path,
      environment,
      undefined,
      digest(source.bytes),
    );
    onTestFinished(() => reader.close());
    await expect(reader.prepare()).rejects.toThrow(
      "Probe: first descriptor still held",
    );
    expect(fallback).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
    await reader.close();
    expect(close).toHaveBeenCalledTimes(2);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("drains the first acquired reader when close interrupts its pending preparation", async () => {
    const source = await sourceFile(ordinaryPe());
    const started = deferred<AbortSignal>();
    const release = deferred<void>();
    const original = InstylerArtifactReader.prototype.prepare;
    vi.spyOn(InstylerArtifactReader.prototype, "prepare").mockImplementation(
      async function (this: InstylerArtifactReader, signal) {
        const result = await original.call(this, signal);
        started.resolve(signal!);
        await release.promise;
        return result;
      },
    );
    const close = vi.spyOn(InstylerArtifactReader.prototype, "close");
    const fallback = vi
      .spyOn(bridge, "openStaticArchive")
      .mockResolvedValue(undefined);
    const reader = new PeInstallerArtifactReader(
      source.path,
      environment,
      undefined,
      digest(source.bytes),
    );
    onTestFinished(() => reader.close());
    const preparing = reader.prepare();
    const refused = expect(preparing).rejects.toBeDefined();
    const signal = await started.promise;
    const closed = reader.close();
    expect(signal.aborted).toBe(true);
    release.resolve();
    await refused;
    await closed;
    expect(close).toHaveBeenCalledTimes(1);
    expect(fallback).not.toHaveBeenCalled();
    expect(await readFile(source.path)).toEqual(source.bytes);
  });

  it("retains a late static snapshot when cancellation and its first cleanup both fail", async () => {
    const source = await sourceFile(ordinaryPe());
    const started = deferred<AbortSignal>();
    const gate = deferred<bridge.StaticArchiveSnapshot>();
    const fallback = vi
      .spyOn(bridge, "openStaticArchive")
      .mockImplementation(async (input) => {
        started.resolve(input.signal!);
        return gate.promise;
      });
    const firstClose = vi.spyOn(InstylerArtifactReader.prototype, "close");
    const snapshot = staticSnapshot(digest(source.bytes));
    vi.mocked(snapshot.close).mockRejectedValueOnce(
      new ArtifactReaderFailure(
        "unavailable",
        "Probe: private decoder runtime held",
        {
          cleanup: {
            reason: "Close refused",
            resources: ["private-runtime-owner"],
          },
        },
      ),
    );
    const reader = new PeInstallerArtifactReader(
      source.path,
      environment,
      undefined,
      digest(source.bytes),
    );
    onTestFinished(() => reader.close());
    const preparing = reader.prepare();
    const refused = expect(preparing).rejects.toBeDefined();
    const signal = await started.promise;
    expect(firstClose).toHaveBeenCalledTimes(1);
    const closed = reader.close();
    expect(signal.aborted).toBe(true);
    gate.resolve(snapshot);
    await refused;
    await expect(closed).rejects.toMatchObject({
      cleanup: { resources: ["private-runtime-owner"] },
    });
    expect(snapshot.close).toHaveBeenCalledTimes(1);
    expect(firstClose).toHaveBeenCalledTimes(1);
    await reader.close();
    expect(snapshot.close).toHaveBeenCalledTimes(2);
    expect(fallback).toHaveBeenCalledTimes(1);
  });
});
