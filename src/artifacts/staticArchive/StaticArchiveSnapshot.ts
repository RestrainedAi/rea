import type { Readable } from "node:stream";
import type { ArtifactCommand } from "../../domain/artifactGraph.js";
import type { JsonValue } from "../../domain/jsonValue.js";
import { ArtifactReaderFailure } from "../ArtifactReader.js";

export interface StaticArchiveMember {
  readonly ordinal: number;
  readonly rawName: string;
  readonly kind: "file" | "directory";
  readonly bytes: number;
  readonly sha256: string | null;
}

export interface StaticArchiveSnapshot {
  readonly metadata: JsonValue;
  readonly sourceSha256: string;
  readonly nameDialect?: "posix" | "windows";
  readonly members: readonly StaticArchiveMember[];
  open(ordinal: number, signal?: AbortSignal): Promise<Readable>;
  provenance(): readonly ArtifactCommand[];
  close(): Promise<void>;
}

/** A failed preparation whose exact resource owner must remain reachable. */
export class StaticArchiveBridgeFailure extends ArtifactReaderFailure {
  constructor(
    cause: unknown,
    readonly cleanupOwner: { close(): Promise<void> },
    resource: string,
  ) {
    const primary =
      cause instanceof ArtifactReaderFailure
        ? cause
        : new ArtifactReaderFailure("io", message(cause), { cause });
    super(
      primary.reason,
      primary.message,
      {
        cause: primary,
        cleanup: ArtifactReaderFailure.cleanupObservation(primary, resource),
        ...(primary.partialObservation === undefined
          ? {}
          : { partialObservation: primary.partialObservation }),
      },
      primary.details,
    );
  }
}

const message = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);
