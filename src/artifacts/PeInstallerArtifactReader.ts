import type { Readable } from "node:stream";
import type { ArtifactCommand } from "../domain/artifactGraph.js";
import type { StableRegularFileDescriptor } from "../filesystem/RegularFile.js";
import {
  ArtifactReaderFailure,
  type ArtifactEntry,
  type ArtifactReader,
} from "./ArtifactReader.js";
import { InstylerArtifactReader } from "./InstylerArtifactReader.js";
import { StaticArchiveArtifactReader } from "./staticArchive/StaticArchiveArtifactReader.js";

/** One explicit PE archive dispatch: a recognized invalid profile never falls through. */
export class PeInstallerArtifactReader implements ArtifactReader {
  readonly format = "file" as const;
  readonly #lifecycle = new AbortController();
  #instyler: InstylerArtifactReader | undefined;
  #static: StaticArchiveArtifactReader | undefined;
  #selected: ArtifactReader | undefined;
  #preparing: Promise<boolean> | undefined;
  #closing: Promise<void> | undefined;
  #closed = false;

  constructor(
    private readonly path: string,
    private readonly environment: Readonly<NodeJS.ProcessEnv>,
    rootSource?: StableRegularFileDescriptor,
    private readonly expectedRootSha256?: string,
  ) {
    this.#instyler = new InstylerArtifactReader(
      path,
      rootSource,
      expectedRootSha256,
    );
  }

  get limitations(): readonly string[] {
    if (this.#selected === this.#instyler && this.#instyler !== undefined)
      return this.#instyler.limitations;
    if (this.#selected === this.#static && this.#static !== undefined)
      return this.#static.limitations;
    return [
      "PE root hash is observed; a supported archive profile was not recognized, so no installed-file inventory was produced.",
    ];
  }

  async prepare(signal?: AbortSignal): Promise<boolean> {
    this.#assertOpen();
    signal?.throwIfAborted();
    this.#preparing ??= this.#prepare(
      signal === undefined
        ? this.#lifecycle.signal
        : AbortSignal.any([this.#lifecycle.signal, signal]),
    );
    const result = await this.#preparing;
    this.#assertOpen();
    signal?.throwIfAborted();
    return result;
  }

  async #prepare(signal: AbortSignal): Promise<boolean> {
    const instyler = this.#instyler!;
    if (await instyler.prepare(signal)) {
      this.#selected = instyler;
      return true;
    }
    await instyler.close();
    this.#instyler = undefined;
    signal.throwIfAborted();
    const reader = new StaticArchiveArtifactReader(
      this.path,
      this.environment,
      this.expectedRootSha256,
    );
    this.#static = reader;
    if (await reader.prepare(signal)) {
      this.#selected = reader;
      return true;
    }
    return false;
  }

  async *entries(signal?: AbortSignal): AsyncIterable<ArtifactEntry> {
    if (!(await this.prepare(signal))) return;
    yield* this.#selected!.entries(signal);
  }

  async open(entry: ArtifactEntry, signal?: AbortSignal): Promise<Readable> {
    await this.prepare(signal);
    if (this.#selected === undefined)
      throw new ArtifactReaderFailure(
        "unavailable",
        "PE artifact has no admitted child archive reader.",
      );
    return this.#selected.open(entry, signal);
  }

  provenance(): readonly ArtifactCommand[] {
    return this.#selected?.provenance() ?? [];
  }

  close(): Promise<void> {
    this.#closed = true;
    this.#lifecycle.abort();
    this.#closing ??= this.#close().finally(() => {
      this.#closing = undefined;
    });
    return this.#closing;
  }

  async #close(): Promise<void> {
    await this.#preparing?.catch(() => undefined);
    const failures: unknown[] = [];
    if (this.#instyler !== undefined) {
      try {
        await this.#instyler.close();
        this.#instyler = undefined;
      } catch (cause) {
        failures.push(cause);
      }
    }
    if (this.#static !== undefined) {
      try {
        await this.#static.close();
        this.#static = undefined;
      } catch (cause) {
        failures.push(cause);
      }
    }
    if (failures.length > 0) {
      const observations = failures.map((cause) =>
        ArtifactReaderFailure.cleanupObservation(
          cause,
          `PE archive reader for ${this.path}`,
        ),
      );
      throw new ArtifactReaderFailure(
        "unavailable",
        "PE archive reader cleanup remains incomplete.",
        {
          cause: new AggregateError(failures),
          cleanup: {
            reason: observations.map(({ reason }) => reason).join("; "),
            resources: [
              ...new Set(observations.flatMap(({ resources }) => resources)),
            ],
          },
        },
      );
    }
  }

  #assertOpen(): void {
    if (this.#closed)
      throw new ArtifactReaderFailure(
        "unavailable",
        "PE archive reader is closed.",
      );
  }
}
