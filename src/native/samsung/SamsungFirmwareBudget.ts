import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import {
  SAMSUNG_METADATA_BYTES,
  samsungMetadataByteCount,
} from "../../domain/firmware/samsungFirmwareBudget.js";

/** Complete serialized metadata is bounded before retention or publication. */
export const samsungMetadataBytes = (value: unknown): number => {
  const bytes = samsungMetadataByteCount(value);
  if (bytes > SAMSUNG_METADATA_BYTES)
    throw new ArtifactReaderFailure(
      "limit",
      "Samsung complete directory metadata exceeds the 8 MiB budget.",
    );
  return bytes;
};
