import { setImmediate } from "node:timers/promises";
import { ArtifactReaderFailure } from "../ArtifactReader.js";
import { readPeFileLayout, requirePeRange } from "../pe/PeFileLayout.js";
import { jsonParts } from "../../domain/jsonSerialization.js";

export const INSTYLER_SOURCE_BYTES = 64 * 1024 * 1024;
export const INSTYLER_DECODED_BYTES = 64 * 1024 * 1024;
export const INSTYLER_SIGNATURE = Buffer.from([
  0x49, 0x53, 0x01, 0x1a, 0, 0x20,
]);
const FRAME_SIGNATURE = Buffer.from([0x7a, 0x6c, 0x62, 0x1a]);
const CONFIG_BYTES = 0x1b9a;
const ATTRIBUTE_ROW_BYTES = 0x30;
const FILE_ROW_BYTES = 0x11f;

export interface InstylerMember {
  readonly index: number;
  readonly filename: string;
  readonly filename_hex: string;
  readonly record_offset: number;
  readonly compressed_offset: number;
  readonly compressed_bytes: number;
  readonly decoded_bytes: number;
}
export interface InstylerDirectory {
  readonly overlay_offset: number;
  readonly metadata_bytes: number;
  readonly data_offset: number;
  readonly members: readonly InstylerMember[];
}
const fail = (message: string): never => {
  throw new ArtifactReaderFailure("format", message);
};
const capacity = (message: string): never => {
  throw new ArtifactReaderFailure("limit", message);
};

/**
 * Original narrow Instyler IS011A0020 profile derived from its read-only wrapper
 * directory routine and corroborated by the independent detection signature.
 * Configuration/attribute/auxiliary semantics are deliberately left opaque.
 */
export const parseInstylerDirectory = async (
  bytes: Buffer,
  signal?: AbortSignal,
): Promise<InstylerDirectory | undefined> => {
  signal?.throwIfAborted();
  if (bytes.indexOf(INSTYLER_SIGNATURE) < 0) return undefined;
  const overlay = readPeFileLayout(bytes).file_body_end;
  if (
    !bytes
      .subarray(overlay, overlay + INSTYLER_SIGNATURE.length)
      .equals(INSTYLER_SIGNATURE)
  )
    return undefined;
  if (bytes.length > INSTYLER_SOURCE_BYTES)
    capacity(
      "Recognized Instyler archive exceeds the 64 MiB stable-source budget.",
    );
  const config = overlay + INSTYLER_SIGNATURE.length;
  requirePeRange(bytes, config, CONFIG_BYTES);
  const attributeCount = bytes.readUInt16LE(config + 0x1a90);
  const memberCount = bytes.readUInt16LE(config + 0x1a92);
  const directory =
    config + CONFIG_BYTES + attributeCount * ATTRIBUTE_ROW_BYTES;
  requirePeRange(
    bytes,
    config + CONFIG_BYTES,
    attributeCount * ATTRIBUTE_ROW_BYTES,
  );
  requirePeRange(bytes, directory, memberCount * FILE_ROW_BYTES);
  const directoryEnd = directory + memberCount * FILE_ROW_BYTES;
  let totalFrames = 0;
  let totalDecoded = 0;
  const rows: {
    member: Omit<InstylerMember, "compressed_offset">;
    dataOffset: number;
  }[] = [];
  const names = new Set<string>();
  let metadataBytes = 0;
  for (let index = 0; index < memberCount; index++) {
    if (index % 128 === 0) {
      await setImmediate();
      signal?.throwIfAborted();
    }
    const at = directory + index * FILE_ROW_BYTES;
    if (bytes[at] !== 1 || bytes[at + 1] !== 1 || bytes[at + 286] !== 0)
      fail(
        `Instyler file record ${String(index)} is outside the supported plain zlib profile.`,
      );
    const dataOffset = bytes.readUInt32LE(at + 2);
    if (dataOffset !== totalFrames)
      fail(
        `Instyler file record ${String(index)} has noncontiguous or overlapping encoded data.`,
      );
    const length = bytes[at + 6]!;
    if (length === 0)
      fail(`Instyler file record ${String(index)} has an empty filename.`);
    const nameBytes = bytes.subarray(at + 7, at + 7 + length);
    if (nameBytes.includes(0))
      fail(`Instyler file record ${String(index)} has a NUL filename byte.`);
    const filename = nameBytes.toString("latin1");
    const filename_hex = nameBytes.toString("hex");
    if (names.has(filename_hex))
      fail(`Instyler file record ${String(index)} duplicates a filename.`);
    names.add(filename_hex);
    const decoded_bytes = bytes.readUInt32LE(at + 278);
    const compressed_bytes = bytes.readUInt32LE(at + 282);
    if (compressed_bytes < 8)
      fail(`Instyler file record ${String(index)} has a truncated zlib frame.`);
    totalFrames += 4 + compressed_bytes;
    totalDecoded += decoded_bytes;
    if (totalDecoded > INSTYLER_DECODED_BYTES)
      capacity(
        "Instyler declared decoded payload exceeds the 64 MiB aggregate expansion budget.",
      );
    const member = {
      index,
      filename,
      filename_hex,
      record_offset: at,
      compressed_bytes,
      decoded_bytes,
    };
    for (const part of jsonParts(member))
      metadataBytes += Buffer.byteLength(part, "utf8");
    if (metadataBytes > 8 * 1024 * 1024)
      capacity(
        "Instyler complete member metadata exceeds the 8 MiB allocation budget.",
      );
    rows.push({ member, dataOffset });
  }
  const dataOffset = bytes.length - totalFrames;
  if (dataOffset < directoryEnd)
    fail(
      "Instyler encoded payload overlaps or truncates its declared directory.",
    );
  const members = rows.map(({ member, dataOffset: relative }) => {
    const frame = dataOffset + relative;
    requirePeRange(bytes, frame, 4 + member.compressed_bytes);
    if (!bytes.subarray(frame, frame + 4).equals(FRAME_SIGNATURE))
      fail(
        `Instyler file record ${String(member.index)} lacks its zlb frame signature.`,
      );
    return { ...member, compressed_offset: frame + 4 };
  });
  signal?.throwIfAborted();
  return {
    overlay_offset: overlay,
    metadata_bytes: dataOffset - overlay,
    data_offset: dataOffset,
    members,
  };
};
