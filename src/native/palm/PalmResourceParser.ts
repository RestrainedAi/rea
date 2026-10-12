import { createHash } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import { palmMetadataBytes as jsonBytes } from "./PalmSerializationBudget.js";
import type {
  InspectPalmResourcesInput,
  PalmResources,
} from "../../domain/native/palmResources.js";

const HEADER_BYTES = 78;
const ENTRY_BYTES = 10;
const METADATA_BYTES = 8 * 1024 * 1024;
const fail = (message: string): never => {
  throw new ArtifactReaderFailure("format", message);
};
const limit = (): never => {
  throw new ArtifactReaderFailure(
    "limit",
    "Palm resource metadata exceeds the 8 MiB complete-result allocation budget.",
  );
};

/** Original Palm File Format Specification single-list resource-database profile. */
export const parsePalmResources = async (
  bytes: Buffer,
  artifact: PalmResources["artifact"],
  input: InspectPalmResourcesInput,
  signal?: AbortSignal,
): Promise<PalmResources> => {
  signal?.throwIfAborted();
  if (bytes.length < HEADER_BYTES)
    fail("Truncated Palm database header: at least 78 bytes are required.");
  if ((bytes.readUInt16BE(32) & 1) === 0)
    fail(
      "Selected file is not a Palm resource database: the resource-database flag is clear. Record databases, including PalmDOC/Mobipocket ebooks, require a separate reader.",
    );
  if (bytes.readUInt32BE(72) !== 0)
    fail(
      "Chained Palm record lists are unsupported; refusing to return a truncated resource inventory.",
    );
  const nameBytes = bytes.subarray(0, 32);
  const nameEnd = nameBytes.indexOf(0);
  if (nameEnd < 0)
    fail(
      "Palm database name is not NUL-terminated within its 32-byte header field.",
    );
  const count = bytes.readUInt16BE(76);
  if (count > input.max_entries)
    throw new ArtifactReaderFailure(
      "limit",
      "Palm resource directory entry budget exceeded; no partial inventory was returned.",
    );
  const directoryEnd = HEADER_BYTES + count * ENTRY_BYTES;
  if (directoryEnd > bytes.length)
    fail("Truncated Palm resource directory: declared entries leave the file.");
  const fourcc = (offset: number) => ({
    value: bytes.toString("latin1", offset, offset + 4),
    raw_hex: bytes.subarray(offset, offset + 4).toString("hex"),
  });
  const header: PalmResources["header"] = {
    location: { offset: 0, bytes: HEADER_BYTES },
    name: {
      value: nameBytes.toString("latin1", 0, nameEnd),
      raw_hex: nameBytes.toString("hex"),
    },
    attributes: bytes.readUInt16BE(32),
    database_version: bytes.readUInt16BE(34),
    created_raw: bytes.readUInt32BE(36),
    modified_raw: bytes.readUInt32BE(40),
    backup_raw: bytes.readUInt32BE(44),
    modification_number: bytes.readUInt32BE(48),
    app_info_offset: bytes.readUInt32BE(52),
    sort_info_offset: bytes.readUInt32BE(56),
    database_type: fourcc(60),
    creator: fourcc(64),
    unique_id_seed: bytes.readUInt32BE(68),
    next_record_list_offset: bytes.readUInt32BE(72),
    resource_count: count,
  };
  const resources: PalmResources["resources"] = [];
  const keys = new Set<string>();
  let metadataBytes = jsonBytes(header) + 1024;
  let previousOffset = directoryEnd - 1;
  // Validate the complete directory before hashing or decoding payload metadata.
  for (let index = 0; index < count; index++) {
    if (index % 128 === 0) {
      await setImmediate();
      signal?.throwIfAborted();
    }
    const at = HEADER_BYTES + index * ENTRY_BYTES;
    const type = fourcc(at);
    const id = bytes.readUInt16BE(at + 4);
    const offset = bytes.readUInt32BE(at + 6);
    if (offset < directoryEnd || offset > bytes.length)
      fail(
        `Palm resource ${String(index)} at directory offset ${String(at)} has an out-of-file or directory-overlapping payload offset ${String(offset)}.`,
      );
    if (offset <= previousOffset)
      fail(
        `Palm resource ${String(index)} has a duplicate or descending payload offset; resource lengths are ambiguous.`,
      );
    const key = `${type.raw_hex}:${String(id)}`;
    if (keys.has(key))
      fail(
        `Duplicate Palm resource type/ID at directory entry ${String(index)}.`,
      );
    keys.add(key);
    previousOffset = offset;
  }
  const firstResource =
    count === 0 ? bytes.length : bytes.readUInt32BE(HEADER_BYTES + 6);
  const { app_info_offset: appOffset, sort_info_offset: sortOffset } = header;
  for (const [name, offset] of [
    ["appInfo", appOffset],
    ["sortInfo", sortOffset],
  ] as const)
    if (offset !== 0 && (offset < directoryEnd || offset > firstResource))
      fail(`Palm ${name} offset overlaps the directory or resource payloads.`);
  if (appOffset !== 0 && sortOffset !== 0 && appOffset > sortOffset)
    fail("Palm appInfo offset follows sortInfo; block lengths are ambiguous.");
  const hashed = async (offset: number, size: number) => {
    const hash = createHash("sha256");
    for (let start = 0; start < size; start += 1048576) {
      await setImmediate();
      signal?.throwIfAborted();
      hash.update(
        bytes.subarray(
          offset + start,
          offset + Math.min(size, start + 1048576),
        ),
      );
    }
    return { location: { offset, bytes: size }, sha256: hash.digest("hex") };
  };
  const gapEnd = appOffset || sortOffset || firstResource;
  const directoryGap = await hashed(directoryEnd, gapEnd - directoryEnd);
  const appInfo =
    appOffset === 0
      ? null
      : await hashed(appOffset, (sortOffset || firstResource) - appOffset);
  const sortInfo =
    sortOffset === 0
      ? null
      : await hashed(sortOffset, firstResource - sortOffset);
  for (let index = 0; index < count; index++) {
    await setImmediate();
    signal?.throwIfAborted();
    const at = HEADER_BYTES + index * ENTRY_BYTES;
    const type = fourcc(at);
    const id = bytes.readUInt16BE(at + 4);
    const offset = bytes.readUInt32BE(at + 6);
    const end =
      index + 1 === count
        ? bytes.length
        : bytes.readUInt32BE(at + ENTRY_BYTES + 6);
    const size = end - offset;
    let text: PalmResources["resources"][number]["text"] = null;
    if (type.value === "tAIN" || type.value === "tver") {
      const payload = bytes.subarray(offset, end);
      const nul = payload.indexOf(0);
      const textBytes = nul < 0 ? size : nul;
      // Each source byte can expand to six JSON bytes. Admit before allocating.
      if (metadataBytes + textBytes * 6 + 1024 > METADATA_BYTES) limit();
      text = {
        value: payload.toString("latin1", 0, textBytes),
        encoding: "byte-preserving-latin1",
        nul_terminated: nul >= 0,
      };
    }
    const resource: PalmResources["resources"][number] = {
      index,
      type,
      id,
      entry_location: { offset: at, bytes: ENTRY_BYTES },
      payload: await hashed(offset, size),
      classification:
        type.value === "code"
          ? "code-tagged"
          : type.value === "data"
            ? "data-tagged"
            : "other",
      text,
    };
    metadataBytes += jsonBytes(resource) + 1;
    if (metadataBytes > METADATA_BYTES) limit();
    resources.push(resource);
  }
  const report: PalmResources = {
    artifact,
    format: "palm-resource-database",
    header,
    directory_location: { offset: HEADER_BYTES, bytes: count * ENTRY_BYTES },
    directory_gap: directoryGap,
    app_info: appInfo,
    sort_info: sortInfo,
    resources,
    coverage: { status: "complete", examined_entries: count, resources: count },
    limitations: [
      "Static single-list Palm resource-database inventory; record databases and chained lists are unsupported.",
      "Resource lengths follow ascending directory offsets; the final resource ends at EOF. Directory padding and optional appInfo/sortInfo bytes are retained separately.",
      "Code/data classification observes resource tags only. Code 0 can contain tables rather than instructions; CPU architecture, entry points, Palm API behavior and execution remain unobserved.",
      "Only tAIN and tver expose byte-preserving Latin-1 text through the first NUL. Other payloads, forms and bitmaps remain opaque; original bytes are represented by file ranges and hashes.",
      "Header dates remain raw Palm values; no timestamp authenticity, authorship or source-code recovery is established.",
    ],
  };
  jsonBytes(report);
  signal?.throwIfAborted();
  return report;
};
