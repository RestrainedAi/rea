import { Readable } from "node:stream";
import { join } from "node:path";
import { finished } from "node:stream/promises";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import type { ArtifactCommand } from "../../domain/artifactGraph.js";
import { jsonValueSchema, type JsonValue } from "../../domain/jsonValue.js";
import type { ProviderProcessSupervisor } from "../../process/ProviderProcess.js";
import type { WindowsPrivateRuntime } from "../../windows/WindowsPrivateRuntime.js";
import {
  WindowsImmutableFile,
  WindowsImmutableFileAdmissionFailure,
} from "../../windows/WindowsImmutableFile.js";
import { ArtifactReaderFailure } from "../ArtifactReader.js";
import {
  hashStaticArchiveHandle,
  type StaticArchiveInstallation,
  type StaticArchiveToolPin,
} from "./StaticArchiveConfiguration.js";
import {
  STATIC_ARCHIVE_LIMITS,
  type StaticArchiveResponse,
} from "./StaticArchiveProtocol.js";
import type {
  StaticArchiveSnapshot,
  StaticArchiveMember,
} from "./StaticArchiveSnapshot.js";

interface AdmissionContext {
  readonly installation: StaticArchiveInstallation;
  readonly expectedSha256: string;
  readonly expectedBytes: number;
  readonly signal?: AbortSignal;
}

/** All private payloads, analyzer pins, streams and unconfirmed process cleanup have one owner. */
export class StaticArchiveSession implements StaticArchiveSnapshot {
  readonly pins: StaticArchiveToolPin[] = [];
  runtime: WindowsPrivateRuntime | undefined;
  processOwner: ProviderProcessSupervisor | undefined;
  command: ArtifactCommand | undefined;
  metadata: JsonValue = null;
  sourceSha256 = "";
  nameDialect: "posix" | "windows" = "posix";
  members: readonly StaticArchiveMember[] = [];
  readonly #payloads = new Map<
    number,
    { owner: WindowsImmutableFile; bytes: number }
  >();
  readonly #streams = new Set<Readable>();
  #closed = false;
  #closing: Promise<void> | undefined;

  async admit(
    raw: JsonValue,
    response: StaticArchiveResponse,
    context: AdmissionContext,
  ): Promise<void> {
    const { signal } = context;
    this.sourceSha256 = context.expectedSha256;
    this.nameDialect =
      response.metadata.profile === "inno7.0.0.3u-revision2-stored-lzma-v1"
        ? "windows"
        : "posix";
    this.metadata = staticArchiveMetadata(raw, response, context);
    const names = new Set<number>();
    let total = 0;
    const members: StaticArchiveMember[] = [];
    for (const member of response.metadata.members) {
      signal?.throwIfAborted();
      if (names.has(member.ordinal))
        throw new ArtifactReaderFailure(
          "format",
          "Static archive analyzer repeated a member ordinal.",
        );
      names.add(member.ordinal);
      total += member.declared_bytes;
      if (total > STATIC_ARCHIVE_LIMITS.max_unpacked_bytes)
        throw new ArtifactReaderFailure(
          "limit",
          "Static archive member bytes exceed the aggregate ceiling.",
        );
      if (member.kind === "directory") {
        if (
          member.declared_bytes !== 0 ||
          member.observed_sha256 !== null ||
          member.opaque_payload !== undefined
        )
          throw new ArtifactReaderFailure(
            "format",
            "Static archive directory carries payload facts.",
          );
      } else {
        const expectedPath = `payloads/${String(member.ordinal).padStart(8, "0")}.bin`;
        if (
          member.opaque_payload !== expectedPath ||
          member.observed_bytes !== member.declared_bytes ||
          member.observed_sha256 === null
        )
          throw new ArtifactReaderFailure(
            "format",
            "Static archive file lacks complete indexed payload facts.",
          );
        const path = join(
          this.runtime!.observation.path,
          "payloads",
          `${String(member.ordinal).padStart(8, "0")}.bin`,
        );
        const owner = await this.#admitPayload(path, member.ordinal, signal);
        if (
          owner.size !== member.declared_bytes ||
          (await hashStaticArchiveHandle(owner, signal)) !==
            member.observed_sha256
        )
          throw new ArtifactReaderFailure(
            "integrity",
            "Static archive opaque output failed size/hash readback verification.",
          );
      }
      members.push({
        ordinal: member.ordinal,
        rawName: member.raw_name,
        kind: member.kind,
        bytes: member.declared_bytes,
        sha256: member.observed_sha256,
      });
    }
    this.members = members;
  }

  async #admitPayload(
    path: string,
    ordinal: number,
    signal?: AbortSignal,
  ): Promise<WindowsImmutableFile> {
    try {
      signal?.throwIfAborted();
      const owner = this.runtime!.openImmutableFile(
        `payloads/${String(ordinal).padStart(8, "0")}.bin`,
      );
      const payload = { owner, bytes: 0 };
      this.#payloads.set(ordinal, payload);
      payload.bytes = owner.size;
      return owner;
    } catch (cause) {
      if (cause instanceof WindowsImmutableFileAdmissionFailure)
        this.pins.push({ path, owner: cause.owner });
      throw cause;
    }
  }

  async open(ordinal: number, signal?: AbortSignal): Promise<Readable> {
    signal?.throwIfAborted();
    if (this.#closed)
      throw new ArtifactReaderFailure(
        "unavailable",
        "Static archive snapshot is closed.",
      );
    const payload = this.#payloads.get(ordinal);
    if (payload === undefined)
      throw new ArtifactReaderFailure(
        "format",
        "Static archive member has no admitted regular payload.",
      );
    const stream = Readable.from(
      readPayload(payload.owner, payload.bytes, signal),
      { objectMode: false },
    );
    this.#streams.add(stream);
    stream.on("error", () => undefined);
    stream.once("close", () => this.#streams.delete(stream));
    return stream;
  }

  provenance(): readonly ArtifactCommand[] {
    return this.command === undefined ? [] : [this.command];
  }

  close(): Promise<void> {
    this.#closed = true;
    this.#closing ??= this.#close().finally(() => {
      this.#closing = undefined;
    });
    return this.#closing;
  }

  async #close(): Promise<void> {
    for (const stream of this.#streams) stream.destroy();
    await Promise.allSettled(
      [...this.#streams].map((stream) => finished(stream)),
    );
    if (this.processOwner !== undefined) {
      const stopped = await this.processOwner.stop();
      if (stopped.status === "incomplete")
        throw new ArtifactReaderFailure("unavailable", stopped.reason, {
          cleanup: {
            reason: stopped.reason,
            resources: [
              this.runtime?.observation.path ??
                "static archive analyzer process",
            ],
          },
        });
      this.processOwner = undefined;
    }
    const failures: { path: string; cause: unknown }[] = [];
    for (const [ordinal, payload] of this.#payloads) {
      try {
        await payload.owner.close();
        this.#payloads.delete(ordinal);
      } catch (cause) {
        failures.push({
          path: `private static archive payload ${String(ordinal)}`,
          cause,
        });
      }
    }
    for (let index = this.pins.length - 1; index >= 0; index--) {
      const pin = this.pins[index]!;
      try {
        await pin.owner.close();
        this.pins.splice(index, 1);
      } catch (cause) {
        failures.push({ path: pin.path, cause });
      }
    }
    if (failures.length > 0)
      throw new ArtifactReaderFailure(
        "unavailable",
        "Static archive descriptor cleanup remains incomplete.",
        {
          cause: new AggregateError(failures.map(({ cause }) => cause)),
          cleanup: {
            reason: failures.map(({ cause }) => message(cause)).join("; "),
            resources: failures.map(({ path }) => path),
          },
        },
      );
    if (this.runtime !== undefined) {
      const runtime = this.runtime;
      try {
        await runtime.close();
        this.runtime = undefined;
      } catch (cause) {
        throw new ArtifactReaderFailure(
          "unavailable",
          "Static archive private runtime cleanup remains incomplete.",
          {
            cause,
            cleanup: {
              reason: message(cause),
              resources: [runtime.observation.path],
            },
          },
        );
      }
    }
  }
}

async function* readPayload(
  handle: WindowsImmutableFile,
  bytes: number,
  signal?: AbortSignal,
): AsyncGenerator<Buffer> {
  for (let offset = 0; offset < bytes;) {
    signal?.throwIfAborted();
    const buffer = handle.read(offset, Math.min(65536, bytes - offset));
    if (buffer.length === 0)
      throw new ArtifactReaderFailure(
        "integrity",
        "Private static archive payload was truncated.",
      );
    offset += buffer.length;
    yield buffer;
    if (offset % (1024 * 1024) === 0) await yieldToEventLoop();
  }
  signal?.throwIfAborted();
}

const staticArchiveMetadata = (
  raw: JsonValue,
  response: StaticArchiveResponse,
  context: AdmissionContext,
): JsonValue => {
  const { installation, expectedSha256, expectedBytes } = context;
  if (
    response.source.sha256 !== expectedSha256 ||
    response.source.bytes !== expectedBytes
  )
    throw new ArtifactReaderFailure(
      "integrity",
      "Static archive analyzer returned a different source identity.",
    );
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw new ArtifactReaderFailure(
      "format",
      "Static archive analyzer result is not an object.",
    );
  return jsonValueSchema.parse({
    protocol: response.protocol,
    analyzer: {
      package: response.analyzer.package,
      version: response.analyzer.version,
      repository: installation.backend_repository,
      revision: installation.backend_revision,
    },
    source_sha256: expectedSha256,
    source_bytes: expectedBytes,
    limits: response.limits,
    decoded_budget: raw.decoded_budget,
    metadata: raw.metadata,
    target_executed: false,
    script_emulated: false,
    password_guessing: false,
    limitations: [
      "Decoded members have no direct source byte range; encoded solid-stream extents and decoded offsets are separate metadata facts.",
      "The optional trusted analyzer executes; supplied target code and installer scripts do not.",
    ],
  });
};
const message = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);
