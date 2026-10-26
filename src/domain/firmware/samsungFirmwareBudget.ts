import { jsonParts } from "../jsonSerialization.js";

export const SAMSUNG_METADATA_BYTES = 8 * 1024 * 1024;

/** Count a complete JSON representation, stopping as soon as its budget is exceeded. */
export const samsungMetadataByteCount = (value: unknown): number => {
  let bytes = 0;
  for (const part of jsonParts(value)) {
    bytes += Buffer.byteLength(part, "utf8");
    if (bytes > SAMSUNG_METADATA_BYTES) break;
  }
  return bytes;
};
