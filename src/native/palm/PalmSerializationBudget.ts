import { jsonParts } from "../../domain/jsonSerialization.js";
import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";

/** Bound serialized inventory/export metadata before allocating a complete JSON string. */
export const palmMetadataBytes = (value: unknown): number => {
  let total = 0;
  for (const part of jsonParts(value)) {
    total += Buffer.byteLength(part, "utf8");
    if (total > 8 * 1024 * 1024)
      throw new ArtifactReaderFailure(
        "limit",
        "Palm resource metadata exceeds the 8 MiB complete-result allocation budget.",
      );
  }
  return total;
};
