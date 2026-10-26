import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { ArtifactEntry } from "../ArtifactReader.js";
import { artifactInventoryResultSchema } from "../../domain/artifactGraph.js";
import {
  artifactGraphDigest,
  artifactManifestId,
} from "../../domain/artifactIdentity.js";
import {
  classifyArtifactBytes,
  classifyArtifactContent,
  createArtifactNode,
  createOccurrence,
  createRootNode,
  noteUnreadContainerSuffix,
  rootOccurrenceFor,
} from "./ArtifactGraphConstruction.js";

const signature = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]);
const entry = (kind: ArtifactEntry["kind"] = "file"): ArtifactEntry => ({
  path: "payload.7z",
  kind,
  declaredSize: null,
  compressedSize: null,
  executable: false,
  encrypted: false,
  byteOffset: null,
  declaredSha256: null,
  unpacked: false,
  limitations: [],
  adapterKey: "fixture",
});

describe("7z content and occurrence classification", () => {
  it("identifies complete 7z magic from bytes despite executable or package suffixes", () => {
    for (const path of [
      "payload",
      "payload.exe",
      "payload.js",
      "payload.zip",
      "payload.7Z",
    ])
      expect(classifyArtifactContent(path, signature)).toEqual({
        kind: "container",
        format: "7z",
      });
    expect(classifyArtifactBytes(signature)).toBe("7z");
    expect(
      classifyArtifactContent("decoy.7z", Buffer.from("ordinary data")),
    ).toEqual({ kind: "resource", format: "file" });
  });

  it("requires all six signature bytes at offset zero", () => {
    for (let length = 0; length < signature.length; length++)
      expect(classifyArtifactBytes(signature.subarray(0, length))).toBe("file");
    const wrong = Buffer.from(signature);
    wrong[5] = wrong[5]! ^ 1;
    expect(classifyArtifactBytes(wrong)).toBe("file");
    expect(
      classifyArtifactBytes(Buffer.concat([Buffer.from([0]), signature])),
    ).toBe("file");
  });

  it("keeps unread 7z members unknown and does not reinterpret directory names", () => {
    const unread = createOccurrence(
      { ...entry(), encrypted: true },
      "inner.7Z",
      "parent",
    );
    noteUnreadContainerSuffix(unread);
    expect(unread).toMatchObject({
      artifact_kind: "unknown",
      artifact_format: "unknown",
      artifact_id: null,
      hash_status: "unavailable",
      limitations: [
        "The path suffix suggests 7Z, but these bytes were not read, so the container family is unknown.",
      ],
    });
    const directory = createOccurrence(
      entry("directory"),
      "assets.7z",
      "parent",
    );
    noteUnreadContainerSuffix(directory);
    expect(directory).toMatchObject({
      artifact_kind: "container",
      artifact_format: "directory",
      limitations: [],
    });
  });

  it("retains content identity and a 7z root occurrence without architecture claims", () => {
    const sha256 = createHash("sha256").update(signature).digest("hex");
    const node = createRootNode({
      digest: { sha256, bytes: signature.length, prefix: signature },
      occurrences: [],
    });
    const occurrence = rootOccurrenceFor(node, {
      size: signature.length,
      executable: false,
      format: "7z",
      path: "opaque.data",
    });
    const graph = {
      nodes: [node],
      occurrences: [occurrence],
      edges: [],
      contradictions: [],
    };
    const graphSha256 = artifactGraphDigest(graph);
    const inventory = artifactInventoryResultSchema.parse({
      manifest: {
        manifest_id: artifactManifestId(node.artifact_id, graphSha256),
        root_artifact_id: node.artifact_id,
        root_sha256: sha256,
        root_format: "7z",
        graph_sha256: graphSha256,
        node_count: 1,
        occurrence_count: 1,
        edge_count: 0,
      },
      nodes: graph.nodes,
      occurrences: graph.occurrences,
      edges: graph.edges,
      provenance: [],
      integrity_contradictions: [],
      limitations: [],
    });
    expect(inventory.nodes[0]).toMatchObject({
      format: "7z",
      architecture: null,
    });
    expect(inventory.occurrences[0]).toMatchObject({
      artifact_kind: "container",
      artifact_format: "7z",
      executable: false,
      source_location: null,
    });
    expect(node.artifact_id).toBe(
      createArtifactNode({
        sha256,
        size: signature.length,
        format: "file",
        contentState: "materialized",
      }).artifact_id,
    );
  });
});
