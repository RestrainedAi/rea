import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createInflate } from "node:zlib";
import { OwnedFileHandle } from "../filesystem/OwnedFileHandle.js";
import {
  openRegularFile,
  RegularFileAdmissionFailure,
  sameRegularFileState,
  type StableRegularFileDescriptor,
} from "../filesystem/RegularFile.js";
import { jsonParts } from "../domain/jsonSerialization.js";
import { abortIfNeeded } from "./ArtifactHash.js";
import {
  ArtifactPathRegistry,
  normalizeArtifactPath,
} from "./ArtifactPaths.js";
import {
  ArtifactReaderFailure,
  copyArtifactEntry,
  sameArtifactEntry,
  type ArtifactEntry,
  type ArtifactReader,
} from "./ArtifactReader.js";
import { streamChunkToBuffer } from "./StreamBytes.js";
import {
  INSTYLER_DECODED_BYTES,
  INSTYLER_SIGNATURE,
  INSTYLER_SOURCE_BYTES,
  parseInstylerDirectory,
  type InstylerDirectory,
} from "./instyler/InstylerDirectory.js";
import { readPeFileLayout } from "./pe/PeFileLayout.js";

const METADATA_PATH = "__instyler_metadata.bin";
const ENTRY_METADATA_BYTES = 8 * 1024 * 1024;

type InstylerMember = InstylerDirectory["members"][number];
interface StoredEntry {
  readonly metadata: ArtifactEntry;
  readonly member: InstylerMember | undefined;
}

/** One original Instyler directory owner shared by artifact inventory and export. */
export class InstylerArtifactReader implements ArtifactReader {
  readonly format = "file" as const;
  readonly #lifecycle = new AbortController();
  readonly #entries = new Map<string, StoredEntry>();
  readonly #decoded = new Map<string, Buffer>();
  readonly #decoding = new Map<string, Promise<Buffer>>();
  readonly #active = new Set<Promise<unknown>>();
  readonly #streams = new Set<Readable>();
  #owner: OwnedFileHandle | undefined;
  #preparing: Promise<boolean> | undefined;
  #snapshot: Buffer | undefined;
  #directory: InstylerDirectory | undefined;
  #closing: Promise<void> | undefined;
  #closed = false;

  constructor(
    private readonly path: string,
    private readonly admitted?: StableRegularFileDescriptor,
    private readonly expectedRootSha256?: string,
  ) {}

  get limitations(): readonly string[] {
    return this.#directory === undefined
      ? [
          "PE root hash is observed; the supported Instyler Ex-it! 1.6 profile was not recognized, so no installed-file inventory was produced.",
        ]
      : [
          "Static Instyler Ex-it! single-directory zlib profile; all declared members and the original opaque overlay metadata are represented without executing the installer or its files.",
          "Installer configuration and auxiliary metadata remain opaque; file paths are logical archive names and installer variables are not expanded.",
        ];
  }

  /** Prepare under an already registered reader owner, before creating output. */
  async prepare(signal?: AbortSignal): Promise<boolean> {
    this.#assertOpen();
    abortIfNeeded(signal);
    if (this.#preparing === undefined) {
      const operationSignal = this.#signal(signal);
      this.#preparing = this.#prepare(operationSignal).catch((cause) => {
        abortIfNeeded(operationSignal);
        throw cause;
      });
    }
    const supported = await this.#preparing;
    abortIfNeeded(signal);
    this.#assertOpen();
    return supported;
  }

  async *entries(signal?: AbortSignal): AsyncIterable<ArtifactEntry> {
    await this.prepare(signal);
    for (const stored of this.#entries.values()) {
      abortIfNeeded(signal);
      this.#assertOpen();
      yield copyArtifactEntry(stored.metadata);
    }
  }

  open(entry: ArtifactEntry, signal?: AbortSignal): Promise<Readable> {
    return this.#run(async () => {
      await this.prepare(signal);
      const stored = this.#entries.get(entry.adapterKey);
      if (stored === undefined || !sameArtifactEntry(entry, stored.metadata))
        throw new ArtifactReaderFailure(
          "integrity",
          "Instyler entry metadata does not match this reader's inventory",
        );
      const snapshot = this.#snapshot;
      const directory = this.#directory;
      if (snapshot === undefined || directory === undefined)
        throw new ArtifactReaderFailure(
          "unavailable",
          "Instyler snapshot is unavailable",
        );
      const operationSignal = this.#signal(signal);
      const bytes =
        stored.member === undefined
          ? snapshot.subarray(directory.overlay_offset, directory.data_offset)
          : await this.#memberBytes(
              entry.adapterKey,
              stored.member,
              operationSignal,
            );
      abortIfNeeded(operationSignal);
      this.#assertOpen();
      // Copy bounded emitted chunks so consumers cannot mutate the private snapshot/cache.
      const stream = Readable.from(
        (async function* () {
          for (let offset = 0; offset < bytes.length; offset += 65536) {
            abortIfNeeded(operationSignal);
            yield Buffer.from(
              bytes.subarray(offset, Math.min(bytes.length, offset + 65536)),
            );
          }
        })(),
        { objectMode: false, signal: operationSignal },
      );
      this.#streams.add(stream);
      stream.once("close", () => this.#streams.delete(stream));
      return stream;
    });
  }

  provenance(): readonly [] {
    return [];
  }

  /** Abort producers, drain acquired operations, and retain an unconfirmed handle close. */
  close(): Promise<void> {
    this.#closed = true;
    for (const stream of this.#streams) stream.destroy();
    this.#lifecycle.abort();
    if (this.#closing !== undefined) return this.#closing;
    this.#closing = this.#close().finally(() => {
      this.#closing = undefined;
    });
    return this.#closing;
  }

  async #close(): Promise<void> {
    for (const stream of this.#streams) stream.destroy();
    await this.#preparing?.catch(() => undefined);
    while (this.#active.size > 0) await Promise.allSettled(this.#active);
    this.#streams.clear();
    this.#decoded.clear();
    this.#decoding.clear();
    this.#entries.clear();
    this.#snapshot = undefined;
    this.#directory = undefined;
    if (this.#owner !== undefined) {
      await this.#owner.close();
      this.#owner = undefined;
    }
  }

  async #prepare(signal: AbortSignal): Promise<boolean> {
    abortIfNeeded(signal);
    let source = this.admitted;
    if (source === undefined) {
      try {
        const handle = await openRegularFile(this.path, {
          symlinks: "reject",
          signal,
        });
        this.#owner = new OwnedFileHandle(handle);
        source = { handle, initial: await handle.stat() };
      } catch (cause) {
        if (cause instanceof RegularFileAdmissionFailure) {
          this.#owner = cause.owner;
          throw ArtifactReaderFailure.withCleanup(
            cause.cause,
            ArtifactReaderFailure.cleanupObservation(
              cause.cleanupCause,
              this.path,
            ),
          );
        }
        throw cause;
      }
    }
    await this.#assertStable(source, signal);
    if (!(await this.#recognizes(source, signal))) {
      await this.#assertStable(source, signal);
      return false;
    }
    if (source.initial.size > INSTYLER_SOURCE_BYTES)
      throw new ArtifactReaderFailure(
        "limit",
        "Instyler source exceeds the 64 MiB snapshot budget",
      );
    const snapshot = await this.#readRange(
      source,
      0,
      source.initial.size,
      signal,
    );
    await this.#assertStable(source, signal);
    const sha256 = createHash("sha256").update(snapshot).digest("hex");
    if (
      this.expectedRootSha256 !== undefined &&
      sha256 !== this.expectedRootSha256
    )
      throw new ArtifactReaderFailure(
        "integrity",
        "Instyler root bytes changed after inventory",
      );
    const directory = await parseInstylerDirectory(snapshot, signal);
    if (directory === undefined)
      throw new ArtifactReaderFailure(
        "integrity",
        "Instyler profile changed after recognition",
      );
    abortIfNeeded(signal);
    this.#projectEntries(directory);
    this.#directory = directory;
    this.#snapshot = snapshot;
    return true;
  }

  async #recognizes(
    source: StableRegularFileDescriptor,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (source.initial.size < 64) return false;
    const dos = await this.#readRange(source, 0, 64, signal);
    const peOffset = dos.readUInt32LE(60);
    if (peOffset > source.initial.size - 24) return false;
    const coff = await this.#readRange(source, peOffset, 24, signal);
    const headerBytes =
      peOffset + 24 + coff.readUInt16LE(20) + coff.readUInt16LE(6) * 40;
    if (headerBytes > source.initial.size) return false;
    if (headerBytes > INSTYLER_SOURCE_BYTES)
      throw new ArtifactReaderFailure(
        "limit",
        "PE headers exceed the Instyler recognition read budget",
      );
    const header = await this.#readRange(source, 0, headerBytes, signal);
    let layout: ReturnType<typeof readPeFileLayout>;
    try {
      layout = readPeFileLayout(header, source.initial.size);
    } catch (cause) {
      if (cause instanceof ArtifactReaderFailure && cause.reason === "format")
        return false;
      throw cause;
    }
    if (layout.file_body_end > source.initial.size - INSTYLER_SIGNATURE.length)
      return false;
    const signature = await this.#readRange(
      source,
      layout.file_body_end,
      INSTYLER_SIGNATURE.length,
      signal,
    );
    return signature.equals(INSTYLER_SIGNATURE);
  }

  async #readRange(
    source: StableRegularFileDescriptor,
    offset: number,
    length: number,
    signal: AbortSignal,
  ): Promise<Buffer> {
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 0 ||
      offset > source.initial.size - length
    )
      throw new ArtifactReaderFailure(
        "format",
        "Instyler read range leaves the admitted source",
      );
    const bytes = Buffer.allocUnsafe(length);
    for (let position = 0; position < length;) {
      abortIfNeeded(signal);
      const read = await source.handle.read(
        bytes,
        position,
        Math.min(65536, length - position),
        offset + position,
      );
      if (read.bytesRead === 0)
        throw new ArtifactReaderFailure(
          "integrity",
          "Instyler source was truncated while reading",
        );
      position += read.bytesRead;
    }
    abortIfNeeded(signal);
    return bytes;
  }

  async #assertStable(
    source: StableRegularFileDescriptor,
    signal: AbortSignal,
  ): Promise<void> {
    abortIfNeeded(signal);
    const [opened, selected] = await Promise.all([
      source.handle.stat(),
      lstat(this.path),
    ]);
    abortIfNeeded(signal);
    if (
      !sameRegularFileState(source.initial, opened) ||
      !sameRegularFileState(source.initial, selected)
    )
      throw new ArtifactReaderFailure(
        "integrity",
        "Instyler source identity changed while reading",
      );
  }

  #projectEntries(directory: InstylerDirectory): void {
    const registry = new ArtifactPathRegistry();
    let metadataBytes = 0;
    let decodedBytes = 0;
    const add = (metadata: ArtifactEntry, member?: InstylerMember) => {
      registry.add(metadata.path, metadata.kind);
      for (const part of jsonParts(metadata)) {
        metadataBytes += Buffer.byteLength(part, "utf8");
        if (metadataBytes > ENTRY_METADATA_BYTES)
          throw new ArtifactReaderFailure(
            "limit",
            "Instyler entry metadata exceeds the 8 MiB inventory budget",
          );
      }
      this.#entries.set(metadata.adapterKey, {
        metadata: copyArtifactEntry(metadata),
        member,
      });
    };
    add({
      path: METADATA_PATH,
      kind: "file",
      declaredSize: directory.metadata_bytes,
      compressedSize: null,
      executable: false,
      encrypted: false,
      byteOffset: directory.overlay_offset,
      declaredSha256: null,
      unpacked: false,
      limitations: [
        "Original Instyler overlay metadata through the start of file data is exported verbatim; configuration, attributes and auxiliary records remain opaque.",
      ],
      adapterKey: "instyler-metadata",
    });
    for (const member of directory.members) {
      decodedBytes += member.decoded_bytes;
      if (
        !Number.isSafeInteger(decodedBytes) ||
        decodedBytes > INSTYLER_DECODED_BYTES
      )
        throw new ArtifactReaderFailure(
          "limit",
          "Instyler declared decoded members exceed the 64 MiB aggregate budget",
        );
      add(
        {
          path: normalizeArtifactPath(member.filename.replaceAll("\\", "/")),
          kind: "file",
          declaredSize: member.decoded_bytes,
          compressedSize: member.compressed_bytes,
          executable: false,
          encrypted: false,
          byteOffset: null,
          declaredSha256: null,
          unpacked: false,
          limitations: [
            `Original filename is byte-preserving Latin-1: ${JSON.stringify(member.filename)}; raw filename hex ${member.filename_hex}; directory record starts at source offset ${String(member.record_offset)}. Installer variables are not expanded.`,
            `Encoded zlib source range: offset ${String(member.compressed_offset)}, length ${String(member.compressed_bytes)}; the preceding four-byte frame marker is excluded. Decoded bytes have no direct physical source range.`,
          ],
          adapterKey: `instyler-member:${String(member.index)}`,
        },
        member,
      );
    }
  }

  async #memberBytes(
    key: string,
    member: InstylerMember,
    signal: AbortSignal,
  ): Promise<Buffer> {
    const cached = this.#decoded.get(key);
    if (cached !== undefined) return cached;
    let decoding = this.#decoding.get(key);
    if (decoding === undefined) {
      decoding = this.#inflate(member, signal);
      this.#decoding.set(key, decoding);
    }
    try {
      const decoded = await decoding;
      abortIfNeeded(signal);
      this.#decoded.set(key, decoded);
      return decoded;
    } finally {
      if (this.#decoding.get(key) === decoding) this.#decoding.delete(key);
    }
  }

  async #inflate(member: InstylerMember, signal: AbortSignal): Promise<Buffer> {
    abortIfNeeded(signal);
    const snapshot = this.#snapshot;
    if (snapshot === undefined)
      throw new ArtifactReaderFailure(
        "unavailable",
        "Instyler snapshot is unavailable",
      );
    const decoded = Buffer.allocUnsafe(member.decoded_bytes);
    let bytes = 0;
    const producer = Readable.from(
      [
        snapshot.subarray(
          member.compressed_offset,
          member.compressed_offset + member.compressed_bytes,
        ),
      ],
      { objectMode: false },
    );
    const inflater = createInflate();
    const consumer = new Writable({
      write: (raw: unknown, _encoding, callback) => {
        const chunk = streamChunkToBuffer(raw);
        if (chunk.length > decoded.length - bytes) {
          callback(
            new ArtifactReaderFailure(
              "integrity",
              "Instyler member exceeds its declared decoded size",
            ),
          );
          return;
        }
        chunk.copy(decoded, bytes);
        bytes += chunk.length;
        callback();
      },
    });
    try {
      await pipeline(producer, inflater, consumer, { signal });
      abortIfNeeded(signal);
      if (
        bytes !== member.decoded_bytes ||
        inflater.bytesWritten !== member.compressed_bytes
      )
        throw new ArtifactReaderFailure(
          "integrity",
          "Instyler decoded size or consumed compressed extent disagrees with its directory",
        );
      return decoded;
    } catch (cause) {
      abortIfNeeded(signal);
      if (cause instanceof ArtifactReaderFailure) throw cause;
      throw new ArtifactReaderFailure(
        "integrity",
        "Instyler zlib member failed complete checksum validation",
        { cause },
      );
    } finally {
      producer.destroy();
      inflater.destroy();
      consumer.destroy();
    }
  }

  async #run<T>(operation: () => Promise<T>): Promise<T> {
    this.#assertOpen();
    const running = Promise.resolve().then(operation);
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
        "Instyler reader is closed",
      );
  }
}
