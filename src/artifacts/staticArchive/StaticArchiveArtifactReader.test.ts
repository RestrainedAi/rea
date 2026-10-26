import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import type { ArtifactCommand } from "../../domain/artifactGraph.js";
import {
  ArtifactReaderFailure,
  type ArtifactEntry,
} from "../ArtifactReader.js";
import { StaticArchiveArtifactReader } from "./StaticArchiveArtifactReader.js";
import {
  StaticArchiveBridgeFailure,
  type StaticArchiveMember,
  type StaticArchiveSnapshot,
  type openStaticArchive,
} from "./StaticArchiveBridge.js";
import { STATIC_ARCHIVE_METADATA_BYTES } from "./StaticArchiveProtocol.js";

const path = "D:/fixtures/static-archive.exe";
const environment = {
  REA_TEST_PRIVATE_VARIABLE: "must-not-enter-generated-metadata",
};
const payload = Buffer.from([0, 0xff, 0x80, 4, 5]);
const sha256 = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");
const rootSha = sha256("original source");
const member = (rawName: string, ordinal = 0): StaticArchiveMember => ({
  ordinal,
  rawName,
  kind: "file",
  bytes: payload.length,
  sha256: sha256(payload),
});
const snapshotFixture = (
  overrides: Partial<StaticArchiveSnapshot> = {},
): StaticArchiveSnapshot => ({
  sourceSha256: rootSha,
  metadata: { profile: "controlled-static-fixture", untouched: [1, "literal"] },
  members: [
    {
      ordinal: 0,
      rawName: "%appfolder%/",
      kind: "directory",
      bytes: 0,
      sha256: null,
    },
    member("%appfolder%/cafe\u0301.bin", 7),
  ],
  open: vi.fn(async () =>
    Readable.from([Buffer.from(payload)], { objectMode: false }),
  ),
  provenance: vi.fn((): ArtifactCommand[] => [
    {
      tool: "controlled-decoder",
      arguments: ["$ARTIFACT"],
      tool_version: "1",
      executable_sha256: "b".repeat(64),
      exit_code: 0,
      effects: ["read", "write"],
    },
  ]),
  close: vi.fn(async () => {}),
  ...overrides,
});
const readerFor = (snapshot = snapshotFixture(), expected = rootSha) => {
  const factory = vi.fn<typeof openStaticArchive>(async () => snapshot);
  return {
    reader: new StaticArchiveArtifactReader(
      path,
      environment,
      expected,
      factory,
    ),
    factory,
    snapshot,
  };
};
const entriesOf = async (
  reader: StaticArchiveArtifactReader,
  signal?: AbortSignal,
) => {
  const entries: ArtifactEntry[] = [];
  for await (const entry of reader.entries(signal)) entries.push(entry);
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

describe("format-owned Windows destination names", () => {
  it("projects Inno separators while preserving exact literal names and directory placeholders", async () => {
    const rawName = "{app}\\SamFwTool.exe";
    const { reader } = readerFor(
      snapshotFixture({ nameDialect: "windows", members: [member(rawName)] }),
    );
    try {
      const entries = await entriesOf(reader);
      expect(entries[1]!.path).toBe("{app}/SamFwTool.exe");
      const envelope = JSON.parse(
        (await collect(await reader.open(entries[0]!))).toString("utf8"),
      );
      expect(envelope.name_dialect).toBe("windows");
      expect(envelope.members[0].rawName).toBe(rawName);
      expect(entries[1]!.limitations.join(" ")).toContain(
        JSON.stringify(rawName),
      );
      expect(await collect(await reader.open(entries[1]!))).toEqual(payload);
    } finally {
      await reader.close();
    }
  });

  it.each([
    "..\\escape.bin",
    "C:\\escape.bin",
    "\\\\server\\share\\x",
    "folder\\..\\x",
    "folder\\\\x",
    "{app}\\CON.txt",
    "{app}\\safe\\",
  ])("keeps Windows name refusal for %s", async (rawName) => {
    const { reader } = readerFor(
      snapshotFixture({ nameDialect: "windows", members: [member(rawName)] }),
    );
    try {
      await expect(entriesOf(reader)).rejects.toMatchObject({ reason: "path" });
    } finally {
      await reader.close();
    }
  });

  it("refuses collisions introduced by Windows separator projection", async () => {
    const { reader } = readerFor(
      snapshotFixture({
        nameDialect: "windows",
        members: [member("{app}\\x", 0), member("{app}/x", 1)],
      }),
    );
    try {
      await expect(entriesOf(reader)).rejects.toMatchObject({ reason: "path" });
    } finally {
      await reader.close();
    }
  });
});

describe("static archive snapshot projection", () => {
  it("caches one session, preserves literal names and exports bounded deterministic metadata", async () => {
    const { reader, factory, snapshot } = readerFor();
    try {
      expect(await Promise.all([reader.prepare(), reader.prepare()])).toEqual([
        true,
        true,
      ]);
      expect(factory).toHaveBeenCalledTimes(1);
      expect(factory).toHaveBeenCalledWith({
        path,
        environment,
        expectedRootSha256: rootSha,
        signal: expect.any(AbortSignal),
      });
      const entries = await entriesOf(reader);
      expect(entries.map((entry) => entry.path)).toEqual([
        "__rea_archive_metadata.json",
        "%appfolder%",
        "%appfolder%/caf\u00e9.bin",
      ]);
      const [metadata, directory, file] = entries;
      expect(file).toMatchObject({
        declaredSize: payload.length,
        compressedSize: null,
        byteOffset: null,
        executable: false,
        encrypted: false,
        declaredSha256: sha256(payload),
        unpacked: false,
      });
      expect(file!.limitations.join(" ")).toContain("observed");
      const metadataBytes = await collect(await reader.open(metadata!));
      expect(JSON.parse(metadataBytes.toString("utf8"))).toEqual({
        source_sha256: rootSha,
        members: snapshot.members,
        metadata: snapshot.metadata,
      });
      expect(metadataBytes.toString("utf8")).not.toContain(
        environment.REA_TEST_PRIVATE_VARIABLE,
      );
      expect(await collect(await reader.open(file!))).toEqual(payload);
      expect(snapshot.open).toHaveBeenCalledWith(7, expect.any(AbortSignal));
      await expect(reader.open(directory!)).rejects.toMatchObject({
        reason: "format",
      });
      const provenance = reader.provenance();
      provenance[0]!.arguments[0] = "caller mutation";
      expect(reader.provenance()[0]!.arguments).toEqual(["$ARTIFACT"]);
    } finally {
      await reader.close();
    }
    expect(snapshot.close).toHaveBeenCalledTimes(1);
    await reader.close();
    expect(snapshot.close).toHaveBeenCalledTimes(1);
  });

  it("copies emitted metadata and inventoried entry facts instead of sharing mutable storage", async () => {
    const { reader } = readerFor();
    try {
      const entries = await entriesOf(reader);
      const first = entries[0]!;
      const original = await collect(await reader.open(first));
      const stream = await reader.open(first);
      const iterator = stream[Symbol.asyncIterator]();
      const chunk = await iterator.next();
      (chunk.value as Buffer).fill(0);
      stream.destroy();
      expect(await collect(await reader.open(first))).toEqual(original);
      (first.limitations as string[]).push("caller mutation");
      await expect(reader.open(first)).rejects.toMatchObject({
        reason: "integrity",
      });
      expect((await entriesOf(reader))[0]!.limitations).not.toContain(
        "caller mutation",
      );
    } finally {
      await reader.close();
    }
  });

  it("keeps an unrecognized profile empty without reopening the factory", async () => {
    const factory = vi.fn<typeof openStaticArchive>(async () => undefined);
    const reader = new StaticArchiveArtifactReader(
      path,
      environment,
      undefined,
      factory,
    );
    expect(await reader.prepare()).toBe(false);
    expect(await entriesOf(reader)).toEqual([]);
    expect(await reader.prepare()).toBe(false);
    expect(factory).toHaveBeenCalledTimes(1);
    await reader.close();
  });

  it("rejects stale root identity and altered produced entries", async () => {
    const stale = readerFor(snapshotFixture(), "c".repeat(64));
    await expect(stale.reader.prepare()).rejects.toMatchObject({
      reason: "integrity",
    });
    await stale.reader.close();
    const { reader, snapshot } = readerFor();
    try {
      const file = (await entriesOf(reader))[2]!;
      for (const changed of [
        { ...file, declaredSize: 99 },
        { ...file, adapterKey: "another-owner" },
        {
          ...file,
          sourceIdentity: {
            device: 1n,
            inode: 1n,
            size: 5n,
            mode: 0n,
            mtimeNs: 0n,
            ctimeNs: 0n,
          },
        },
      ])
        await expect(reader.open(changed)).rejects.toMatchObject({
          reason: "integrity",
        });
      expect(snapshot.open).not.toHaveBeenCalled();
    } finally {
      await reader.close();
    }
  });
});

describe("static archive complete path and metadata admission", () => {
  it.each([
    ["../escape.bin"],
    ["/absolute.bin"],
    ["folder\\file.bin"],
    ["a//b.bin"],
    ["name:stream"],
    ["CON.txt"],
    ["COM\u00b9.bin"],
    ["bad?.bin"],
    ["tail."],
    ["tail "],
    ["control\u0001.bin"],
    ["unpaired\ud800.bin"],
    ["unpaired\udfff.bin"],
    ["__rea_archive_metadata.json"],
    ["__REA_ARCHIVE_METADATA.JSON"],
    ["Folder/a.bin", "folder/b.bin"],
    ["prefix", "prefix/child"],
    ["same.bin", "same.bin"],
    ["caf\u00e9.bin", "cafe\u0301.bin"],
  ])(
    "refuses unsafe or colliding member paths before exposing any entry: %j",
    async (...names) => {
      const { reader, snapshot } = readerFor(
        snapshotFixture({
          members: names.map((name, ordinal) => member(name, ordinal)),
        }),
      );
      try {
        await expect(entriesOf(reader)).rejects.toMatchObject({
          reason: "path",
        });
        expect(snapshot.open).not.toHaveBeenCalled();
      } finally {
        await reader.close();
      }
    },
  );

  it.each([
    [member("file.bin"), { ...member("second.bin"), ordinal: 0 }],
    [{ ...member("file.bin"), sha256: null }],
    [{ ...member("file.bin"), bytes: -1 }],
    [
      {
        ...member("folder"),
        kind: "directory" as const,
        bytes: 1,
        sha256: null,
      },
    ],
  ])("rejects incomplete decoded-member identities: %j", async (...members) => {
    const { reader } = readerFor(snapshotFixture({ members }));
    try {
      await expect(reader.prepare()).rejects.toMatchObject({
        reason: "format",
      });
    } finally {
      await reader.close();
    }
  });

  it("refuses the complete metadata envelope before allocating a serialized document", async () => {
    const { reader, snapshot } = readerFor(
      snapshotFixture({
        metadata: { value: "x".repeat(STATIC_ARCHIVE_METADATA_BYTES) },
      }),
    );
    try {
      await expect(reader.prepare()).rejects.toMatchObject({ reason: "limit" });
      expect(snapshot.open).not.toHaveBeenCalled();
    } finally {
      await reader.close();
    }
  });
});

describe("static archive cancellation and exact cleanup ownership", () => {
  it("drains a late factory snapshot after close cancels preparation", async () => {
    const started = deferred<AbortSignal>();
    const gate = deferred<StaticArchiveSnapshot>();
    const snapshot = snapshotFixture();
    const factory: typeof openStaticArchive = async (input) => {
      started.resolve(input.signal!);
      return gate.promise;
    };
    const reader = new StaticArchiveArtifactReader(
      path,
      environment,
      rootSha,
      factory,
    );
    const preparing = reader.prepare();
    const rejected = expect(preparing).rejects.toMatchObject({
      reason: "cancelled",
    });
    const signal = await started.promise;
    const closed = reader.close();
    expect(signal.aborted).toBe(true);
    expect(snapshot.close).not.toHaveBeenCalled();
    gate.resolve(snapshot);
    await rejected;
    await closed;
    expect(snapshot.close).toHaveBeenCalledTimes(1);
    await expect(reader.prepare()).rejects.toMatchObject({
      reason: "unavailable",
    });
  });

  it("owns a late member stream while close drains the pending open", async () => {
    const started = deferred<void>();
    const gate = deferred<Readable>();
    const snapshot = snapshotFixture({
      open: vi.fn(async () => {
        started.resolve();
        return gate.promise;
      }),
    });
    const { reader } = readerFor(snapshot);
    const file = (await entriesOf(reader))[2]!;
    const opening = reader.open(file);
    const rejected = expect(opening).rejects.toMatchObject({
      reason: "cancelled",
    });
    await started.promise;
    const closed = reader.close();
    const late = Readable.from([payload], { objectMode: false });
    gate.resolve(late);
    await rejected;
    await closed;
    expect(late.closed).toBe(true);
    expect(snapshot.close).toHaveBeenCalledTimes(1);
  });

  it("handles cancellation before a stream consumer attaches without an unhandled error", async () => {
    const { reader } = readerFor();
    try {
      const entry = (await entriesOf(reader))[0]!;
      const controller = new AbortController();
      const stream = await reader.open(entry, controller.signal);
      controller.abort();
      await setImmediate();
      await expect(collect(stream)).rejects.toMatchObject({
        reason: "cancelled",
      });
      const iterator = reader.entries()[Symbol.asyncIterator]();
      await iterator.next();
      await reader.close();
      await expect(iterator.next()).rejects.toMatchObject({
        reason: "cancelled",
      });
    } finally {
      await reader.close();
    }
  });

  it("retains the exact failed snapshot close and shares each concurrent drain attempt", async () => {
    const snapshot = snapshotFixture({
      close: vi
        .fn()
        .mockRejectedValueOnce(
          new ArtifactReaderFailure(
            "integrity",
            "Probe: snapshot identity changed",
            undefined,
            {
              logicalPath: "private-runtime-owner",
              declaredSha256: rootSha,
              calculatedSha256: "c".repeat(64),
              unpacked: false,
            },
          ),
        )
        .mockResolvedValue(undefined),
    });
    const { reader } = readerFor(snapshot);
    await reader.prepare();
    const first = reader.close();
    const concurrent = reader.close();
    expect(concurrent).toBe(first);
    await expect(first).rejects.toMatchObject({
      reason: "integrity",
      details: {
        logicalPath: "private-runtime-owner",
        declaredSha256: rootSha,
      },
      cleanup: { resources: [path] },
    });
    expect(snapshot.close).toHaveBeenCalledTimes(1);
    await reader.close();
    await reader.close();
    expect(snapshot.close).toHaveBeenCalledTimes(2);
  });
});

describe("static archive failed preparation ownership", () => {
  it("adopts a failed bridge preparation owner and never retries preparation", async () => {
    const owner = {
      close: vi
        .fn()
        .mockRejectedValueOnce(new Error("Probe: still held"))
        .mockResolvedValue(undefined),
    };
    const failure = new StaticArchiveBridgeFailure(
      new ArtifactReaderFailure(
        "unavailable",
        "Probe: preparation cleanup failed",
        {
          cleanup: {
            reason: "Private runtime held",
            resources: ["private-runtime-owner"],
          },
        },
      ),
      owner,
      path,
    );
    const factory = vi.fn<typeof openStaticArchive>(async () => {
      throw failure;
    });
    const reader = new StaticArchiveArtifactReader(
      path,
      environment,
      rootSha,
      factory,
    );
    await expect(reader.prepare()).rejects.toBe(failure);
    await expect(reader.prepare()).rejects.toBe(failure);
    expect(factory).toHaveBeenCalledTimes(1);
    await expect(reader.close()).rejects.toMatchObject({
      cleanup: { resources: ["private-runtime-owner"] },
    });
    await reader.close();
    expect(owner.close).toHaveBeenCalledTimes(2);
  });
});
