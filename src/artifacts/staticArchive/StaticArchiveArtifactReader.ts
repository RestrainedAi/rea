import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import type { AnalysisCleanupObservation } from "../../domain/analysisErrorBase.js";
import type { ArtifactCommand } from "../../domain/artifactGraph.js";
import {
  canonicalJsonParts,
  jsonParts,
} from "../../domain/jsonSerialization.js";
import { abortIfNeeded } from "../ArtifactHash.js";
import {
  ArtifactPathRegistry,
  annotateEnglishUnicodeCaseCollisions,
  normalizeArtifactPath,
} from "../ArtifactPaths.js";
import {
  ArtifactReaderFailure,
  copyArtifactEntry,
  sameArtifactEntry,
  type ArtifactEntry,
  type ArtifactReader,
} from "../ArtifactReader.js";
import {
  openStaticArchive,
  StaticArchiveBridgeFailure,
  type StaticArchiveMember,
  type StaticArchiveSnapshot,
} from "./StaticArchiveBridge.js";
import {
  STATIC_ARCHIVE_LIMITS,
  STATIC_ARCHIVE_METADATA_BYTES,
} from "./StaticArchiveProtocol.js";

const METADATA_PATH = "__rea_archive_metadata.json";
const SHA256 = /^[a-f0-9]{64}$/u;
const WINDOWS_RESERVED_NAME =
  /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu;

interface StoredEntry {
  readonly metadata: ArtifactEntry;
  readonly ordinal: number | undefined;
}

/** One owned decoder snapshot, with no supplied program or member execution. */
export class StaticArchiveArtifactReader implements ArtifactReader {
  readonly format = "file" as const;
  readonly #lifecycle = new AbortController();
  readonly #active = new Set<Promise<unknown>>();
  readonly #streams = new Map<Readable, Promise<void>>();
  readonly #environment: Readonly<NodeJS.ProcessEnv>;
  #entries = new Map<string, StoredEntry>();
  #snapshot: StaticArchiveSnapshot | undefined;
  #cleanupOwner: { close(): Promise<void> } | undefined;
  #cleanupContext: AnalysisCleanupObservation | undefined;
  #metadata: Buffer | undefined;
  #commands: readonly ArtifactCommand[] = [];
  #preparing: Promise<boolean> | undefined;
  #closing: Promise<void> | undefined;
  #supported: boolean | undefined;
  #closed = false;

  constructor(
    private readonly path: string,
    environment: Readonly<NodeJS.ProcessEnv>,
    private readonly expectedRootSha256?: string,
    private readonly factory: typeof openStaticArchive = openStaticArchive,
  ) {
    this.#environment = { ...environment };
  }

  get limitations(): readonly string[] {
    return this.#supported === true
      ? [
          "Static archive member bytes and decoder metadata were observed without executing supplied programs, emulating installer scripts or expanding installer path variables.",
          "Member SHA-256 values describe observed decoded bytes rather than archive-declared checksums or publisher authentication. Raw names are preserved in the generated metadata child.",
        ]
      : [
          this.#supported === false
            ? "No admitted static archive profile was recognized; no member inventory was produced."
            : "A static archive member profile has not been established.",
        ];
  }

  async prepare(signal?: AbortSignal): Promise<boolean> {
    this.#assertOpen();
    abortIfNeeded(signal);
    this.#preparing ??= this.#prepare(this.#signal(signal));
    const supported = await this.#preparing;
    abortIfNeeded(this.#signal(signal));
    this.#assertOpen();
    return supported;
  }

  async *entries(signal?: AbortSignal): AsyncIterable<ArtifactEntry> {
    const operationSignal = this.#signal(signal);
    await this.prepare(operationSignal);
    for (const entry of this.#entries.values()) {
      abortIfNeeded(operationSignal);
      this.#assertOpen();
      yield copyArtifactEntry(entry.metadata);
      // A paused iterator must not report successful completion if close
      // cleared its remaining entries while the consumer held the last yield.
      abortIfNeeded(operationSignal);
      this.#assertOpen();
    }
  }

  async open(entry: ArtifactEntry, signal?: AbortSignal): Promise<Readable> {
    const requested = copyArtifactEntry(entry);
    return this.#run(async () => {
      const operationSignal = this.#signal(signal);
      await this.prepare(operationSignal);
      const stored = this.#entries.get(requested.adapterKey);
      if (
        stored === undefined ||
        !sameArtifactEntry(requested, stored.metadata)
      )
        throw new ArtifactReaderFailure(
          "integrity",
          "Static archive entry metadata does not match this reader's inventory.",
        );
      if (stored.metadata.kind !== "file")
        throw new ArtifactReaderFailure(
          "format",
          "Static archive directories cannot be opened as regular files.",
        );
      abortIfNeeded(operationSignal);
      let stream: Readable;
      if (stored.ordinal === undefined) {
        const bytes = this.#metadata;
        if (bytes === undefined)
          throw new ArtifactReaderFailure(
            "unavailable",
            "Static archive metadata bytes are unavailable.",
          );
        stream = copiedMetadataStream(bytes, operationSignal);
      } else {
        if (this.#snapshot === undefined)
          throw new ArtifactReaderFailure(
            "unavailable",
            "Static archive snapshot is unavailable.",
          );
        stream = await this.#snapshot.open(stored.ordinal, operationSignal);
      }
      this.#ownStream(stream, operationSignal);
      abortIfNeeded(operationSignal);
      this.#assertOpen();
      return stream;
    });
  }

  provenance(): readonly ArtifactCommand[] {
    return this.#commands.map(copyCommand);
  }

  close(): Promise<void> {
    this.#closed = true;
    this.#lifecycle.abort();
    if (this.#closing !== undefined) return this.#closing;
    this.#closing = this.#close().finally(() => {
      this.#closing = undefined;
    });
    return this.#closing;
  }

  async #prepare(signal: AbortSignal): Promise<boolean> {
    if (
      this.expectedRootSha256 !== undefined &&
      !SHA256.test(this.expectedRootSha256)
    )
      throw new ArtifactReaderFailure(
        "format",
        "Static archive expected root SHA-256 is malformed.",
      );
    let snapshot: StaticArchiveSnapshot | undefined;
    try {
      snapshot = await this.factory({
        path: this.path,
        environment: this.#environment,
        signal,
        ...(this.expectedRootSha256 === undefined
          ? {}
          : { expectedRootSha256: this.expectedRootSha256 }),
      });
    } catch (cause) {
      if (cause instanceof StaticArchiveBridgeFailure) {
        this.#cleanupOwner = cause.cleanupOwner;
        this.#cleanupContext = cause.cleanup;
      }
      if (cause instanceof ArtifactReaderFailure) throw cause;
      abortIfNeeded(signal);
      throw new ArtifactReaderFailure(
        "unavailable",
        "Static archive preparation failed.",
        { cause },
      );
    }
    if (snapshot === undefined) {
      abortIfNeeded(signal);
      this.#supported = false;
      return false;
    }
    // Adopt before checking cancellation or metadata: any late successful
    // factory result remains owned until this exact snapshot closes.
    this.#cleanupOwner = snapshot;
    this.#snapshot = snapshot;
    abortIfNeeded(signal);
    if (!SHA256.test(snapshot.sourceSha256))
      throw new ArtifactReaderFailure(
        "format",
        "Static archive source SHA-256 is malformed.",
      );
    if (
      this.expectedRootSha256 !== undefined &&
      snapshot.sourceSha256 !== this.expectedRootSha256
    )
      throw new ArtifactReaderFailure(
        "integrity",
        "Static archive source differs from the selected root identity.",
      );
    const projected = projectSnapshot(snapshot);
    abortIfNeeded(signal);
    this.#assertOpen();
    this.#entries = projected.entries;
    this.#metadata = projected.metadata;
    this.#commands = snapshot.provenance().map(copyCommand);
    this.#supported = true;
    return true;
  }

  #ownStream(stream: Readable, signal: AbortSignal): void {
    // finished installs error ownership before an abort can occur in the
    // handoff interval; later async iteration still receives the same error.
    const drained = finished(stream, { cleanup: true }).catch(() => undefined);
    this.#streams.set(stream, drained);
    const cancel = () => {
      if (!stream.destroyed)
        stream.destroy(
          new ArtifactReaderFailure(
            "cancelled",
            "Static archive read cancelled.",
          ),
        );
    };
    const release = () => {
      signal.removeEventListener("abort", cancel);
      this.#streams.delete(stream);
    };
    void drained.then(release);
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
  }

  async #close(): Promise<void> {
    await this.#preparing?.catch(() => undefined);
    this.#preparing = undefined;
    while (this.#active.size > 0) await Promise.allSettled(this.#active);
    for (const stream of this.#streams.keys()) stream.destroy();
    await Promise.all(this.#streams.values());
    this.#streams.clear();
    this.#entries.clear();
    this.#metadata = undefined;
    this.#snapshot = undefined;
    if (this.#cleanupOwner === undefined) return;
    try {
      await this.#cleanupOwner.close();
    } catch (cause) {
      const cleanup =
        cause instanceof ArtifactReaderFailure && cause.cleanup !== undefined
          ? cause.cleanup
          : {
              reason: cause instanceof Error ? cause.message : String(cause),
              resources: this.#cleanupContext?.resources ?? [this.path],
            };
      this.#cleanupContext = cleanup;
      throw ArtifactReaderFailure.withCleanup(
        cause instanceof ArtifactReaderFailure
          ? cause
          : new ArtifactReaderFailure(
              "unavailable",
              "Static archive cleanup remains incomplete.",
              { cause },
            ),
        cleanup,
      );
    }
    this.#cleanupOwner = undefined;
    this.#cleanupContext = undefined;
  }

  async #run<T>(work: () => Promise<T>): Promise<T> {
    this.#assertOpen();
    const running = Promise.resolve().then(work);
    this.#active.add(running);
    try {
      return await running;
    } finally {
      this.#active.delete(running);
    }
  }

  #signal(signal?: AbortSignal): AbortSignal {
    return signal === undefined
      ? this.#lifecycle.signal
      : AbortSignal.any([signal, this.#lifecycle.signal]);
  }
  #assertOpen(): void {
    if (this.#closed)
      throw new ArtifactReaderFailure(
        "unavailable",
        "Static archive reader is closed.",
      );
  }
}

const projectSnapshot = (snapshot: StaticArchiveSnapshot) => {
  if (
    snapshot.nameDialect !== undefined &&
    snapshot.nameDialect !== "posix" &&
    snapshot.nameDialect !== "windows"
  )
    throw new ArtifactReaderFailure(
      "format",
      "Static archive member-name dialect is unqualified.",
    );
  if (snapshot.members.length > STATIC_ARCHIVE_LIMITS.max_entries)
    throw new ArtifactReaderFailure(
      "limit",
      "Static archive member count exceeds its complete profile budget.",
    );
  const registry = new ArtifactPathRegistry();
  registry.add(METADATA_PATH, "file");
  const paths = [{ logical_path: METADATA_PATH, limitations: [] as string[] }];
  const ordinals = new Set<number>();
  let decoded = 0;
  const members = snapshot.members.map((member) => {
    validateMember(member, ordinals);
    if (member.bytes > STATIC_ARCHIVE_LIMITS.max_unpacked_bytes - decoded)
      throw new ArtifactReaderFailure(
        "limit",
        "Static archive decoded bytes exceed its complete profile budget.",
      );
    decoded += member.bytes;
    const path = safeMemberPath(member, snapshot.nameDialect ?? "posix");
    registry.add(path, member.kind);
    paths.push({ logical_path: path, limitations: [] });
    return { member, path };
  });
  const caseCollision = annotateEnglishUnicodeCaseCollisions(paths);
  if (caseCollision !== undefined)
    throw new ArtifactReaderFailure("path", caseCollision);
  const envelope = {
    source_sha256: snapshot.sourceSha256,
    ...(snapshot.nameDialect === undefined
      ? {}
      : { name_dialect: snapshot.nameDialect }),
    members: members.map(({ member }) => ({
      ordinal: member.ordinal,
      rawName: member.rawName,
      kind: member.kind,
      bytes: member.bytes,
      sha256: member.sha256,
    })),
    metadata: snapshot.metadata,
  };
  const metadata = encodeMetadata(envelope);
  const entries = new Map<string, StoredEntry>();
  const metadataEntry = entryMetadata({
    path: METADATA_PATH,
    declaredSize: metadata.length,
    declaredSha256: createHash("sha256").update(metadata).digest("hex"),
    adapterKey: `static-archive:${snapshot.sourceSha256}:metadata`,
    limitations: [
      "Generated deterministic JSON preserves decoder metadata and literal member names; it is not an original archive member.",
    ],
  });
  entries.set(metadataEntry.adapterKey, {
    metadata: metadataEntry,
    ordinal: undefined,
  });
  for (const { member, path } of members) {
    const entry = entryMetadata({
      path,
      declaredSize: member.bytes,
      declaredSha256: member.sha256,
      adapterKey: `static-archive:${snapshot.sourceSha256}:member:${String(member.ordinal)}`,
      limitations: [
        `Original archive member name (literal): ${JSON.stringify(member.rawName)}. Installer path variables are not expanded.`,
        "SHA-256 describes observed decoded bytes, not an archive-declared checksum or publisher authentication.",
      ],
    });
    entries.set(entry.adapterKey, {
      metadata: { ...entry, kind: member.kind },
      ordinal: member.ordinal,
    });
  }
  return { entries, metadata };
};

const validateMember = (
  member: StaticArchiveMember,
  ordinals: Set<number>,
): void => {
  if (
    !Number.isSafeInteger(member.ordinal) ||
    member.ordinal < 0 ||
    member.ordinal >= STATIC_ARCHIVE_LIMITS.max_entries ||
    ordinals.has(member.ordinal) ||
    typeof member.rawName !== "string" ||
    !Number.isSafeInteger(member.bytes) ||
    member.bytes < 0 ||
    (member.sha256 !== null && !SHA256.test(member.sha256)) ||
    (member.kind === "file"
      ? member.sha256 === null
      : member.kind !== "directory" || member.bytes !== 0)
  )
    throw new ArtifactReaderFailure(
      "format",
      "Static archive member identity is malformed or decoded material is incomplete.",
    );
  ordinals.add(member.ordinal);
};

const safeMemberPath = (
  member: StaticArchiveMember,
  dialect: "posix" | "windows",
): string => {
  const logical =
    dialect === "windows"
      ? member.rawName.replaceAll("\\", "/")
      : member.rawName;
  const path = normalizeArtifactPath(logical);
  if (member.kind === "file" && logical.endsWith("/"))
    throw new ArtifactReaderFailure(
      "path",
      "Static archive regular-file name ends with a directory separator.",
    );
  if (
    path
      .split("/")
      .some(
        (part) =>
          unsafePathCharacters(part) ||
          /[. ]$/u.test(part) ||
          WINDOWS_RESERVED_NAME.test(part),
      )
  )
    throw new ArtifactReaderFailure(
      "path",
      `Static archive member is not safe for portable Windows extraction: ${JSON.stringify(member.rawName)}.`,
    );
  return path;
};

/** Reject control bytes and Unicode names that a UTF-8 path would replace. */
const unsafePathCharacters = (value: string): boolean => {
  if (/[<>:"|?*]/u.test(value)) return true;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
};

const encodeMetadata = (value: unknown): Buffer => {
  let bytes = 1;
  try {
    for (const part of jsonParts(value)) {
      bytes += Buffer.byteLength(part, "utf8");
      if (bytes > STATIC_ARCHIVE_METADATA_BYTES)
        throw new ArtifactReaderFailure(
          "limit",
          "Static archive complete metadata envelope exceeds the 8 MiB allocation budget.",
        );
    }
    return Buffer.from([...canonicalJsonParts(value), "\n"].join(""));
  } catch (cause) {
    if (cause instanceof ArtifactReaderFailure) throw cause;
    throw new ArtifactReaderFailure(
      "format",
      "Static archive metadata is not ordinary JSON.",
      { cause },
    );
  }
};

const entryMetadata = (
  entry: Pick<
    ArtifactEntry,
    "path" | "declaredSize" | "declaredSha256" | "adapterKey" | "limitations"
  >,
): ArtifactEntry => ({
  ...entry,
  kind: "file",
  compressedSize: null,
  executable: false,
  encrypted: false,
  byteOffset: null,
  unpacked: false,
});

const copiedMetadataStream = (bytes: Buffer, signal: AbortSignal): Readable =>
  Readable.from(
    (async function* () {
      for (let offset = 0; offset < bytes.length; offset += 65536) {
        abortIfNeeded(signal);
        yield Buffer.from(
          bytes.subarray(offset, Math.min(bytes.length, offset + 65536)),
        );
      }
    })(),
    { objectMode: false },
  );

const copyCommand = (command: ArtifactCommand): ArtifactCommand => ({
  tool: command.tool,
  arguments: [...command.arguments],
  tool_version: command.tool_version,
  executable_sha256: command.executable_sha256,
  exit_code: command.exit_code,
  effects: [...command.effects],
});
