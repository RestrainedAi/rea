import { createHash } from "node:crypto";
import { setImmediate } from "node:timers/promises";

import {
  ArtifactPathRegistry,
  normalizeArtifactPath,
} from "../../artifacts/ArtifactPaths.js";
import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import type {
  SamsungFirmware,
  SamsungFirmwareEntry,
} from "../../domain/firmware/samsungFirmware.js";
import { samsungMetadataBytes } from "./SamsungFirmwareBudget.js";

const BLOCK_BYTES = 512;
const READ_BYTES = 64 * 1024;
const FOOTER_BYTES = 64 * 1024;
const METADATA_BYTES = 8 * 1024 * 1024;
const POSIX_MAGIC = Buffer.from("ustar\0" + "00", "latin1");
const GNU_MAGIC = Buffer.from("ustar  \0", "latin1");

export type SamsungTarEntry = Omit<SamsungFirmwareEntry, "payload"> & {
  readonly payload: {
    readonly location: { readonly offset: number; readonly bytes: number };
  };
};

export interface SamsungTarDirectory {
  readonly tar_location: SamsungFirmware["tar_location"];
  readonly zero_terminator: SamsungFirmware["zero_terminator"];
  readonly padding_location: SamsungFirmware["padding_location"];
  readonly footer: SamsungFirmware["footer"];
  readonly declared_md5: string;
  readonly entries: readonly SamsungTarEntry[];
}

function fail(message: string): never {
  throw new ArtifactReaderFailure("format", message);
}

function limit(message: string): never {
  throw new ArtifactReaderFailure("limit", message);
}

const checkCancelled = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted)
    throw new ArtifactReaderFailure(
      "cancelled",
      "Samsung TAR.MD5 parsing was cancelled.",
      { cause: signal.reason },
    );
};

const allZero = (bytes: Buffer): boolean => bytes.every((byte) => byte === 0);

const octal = (field: Buffer, label: string): number => {
  if ((field[0]! & 0x80) !== 0)
    fail(`Samsung TAR ${label} uses unsupported base-256 encoding.`);
  const match = /^ *([0-7]+)[\0 ]*$/u.exec(field.toString("latin1"));
  if (match === null) fail(`Samsung TAR ${label} is not an octal number.`);
  const value = Number.parseInt(match[1]!, 8);
  if (!Number.isSafeInteger(value))
    fail(`Samsung TAR ${label} exceeds the exact integer range.`);
  return value;
};

const fieldText = (field: Buffer): string => {
  const nul = field.indexOf(0);
  return field.subarray(0, nul < 0 ? field.length : nul).toString("latin1");
};

const checksumRecord = /^([a-fA-F0-9]{32})[ \t]+([^ \t].*)$/u;

const parseFooter = (
  bytes: Buffer,
  offset: number,
): Pick<SamsungTarDirectory, "footer" | "declared_md5"> => {
  if (
    bytes.length === 0 ||
    bytes.some(
      (byte) =>
        byte !== 9 && byte !== 10 && byte !== 13 && (byte < 32 || byte > 126),
    )
  )
    fail("Samsung TAR.MD5 footer is not nonempty ASCII text.");
  const text = bytes.toString("latin1");
  const trailingNewlineBytes = text.endsWith("\r\n")
    ? 2
    : text.endsWith("\n")
      ? 1
      : 0;
  const body = text.slice(0, text.length - trailingNewlineBytes);
  const finalLineStart = body.lastIndexOf("\n") + 1;
  const finalLine = body.slice(finalLineStart);
  const record = checksumRecord.exec(finalLine);
  if (record === null || finalLine.includes("\r"))
    fail("Samsung TAR.MD5 footer lacks one terminal MD5 and filename record.");
  let declaredTarBytes: number | null = null;
  const metadata = body.slice(0, finalLineStart);
  for (const rawLine of metadata.split("\n").slice(0, -1)) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.includes("\r"))
      fail("Samsung TAR.MD5 metadata contains an unpaired carriage return.");
    if (checksumRecord.test(line))
      fail("Samsung TAR.MD5 footer contains multiple checksum records.");
    if (!line.startsWith("original_tar_file_size")) continue;
    const size = /^original_tar_file_size:[ \t]*([0-9]+)[ \t]*$/u.exec(line);
    if (size === null || declaredTarBytes !== null)
      fail(
        "Samsung original_tar_file_size metadata is malformed or duplicated.",
      );
    const value = Number(size[1]);
    if (!Number.isSafeInteger(value) || value !== offset)
      fail("Samsung original_tar_file_size does not equal the TAR extent.");
    declaredTarBytes = value;
  }
  return {
    declared_md5: record[1]!.toLowerCase(),
    footer: {
      location: { offset, bytes: bytes.length },
      raw_hex: bytes.toString("hex"),
      text,
      declared_tar_bytes: declaredTarBytes,
      checksum_record_location: {
        offset: offset + finalLineStart,
        bytes: bytes.length - finalLineStart,
      },
      checksum_filename: record[2]!,
    },
  };
};

type ReadExact = (offset: number, length: number) => Promise<Buffer>;

const validatedReader =
  (
    readExact: ReadExact,
    sourceBytes: number,
    signal: AbortSignal | undefined,
  ): ReadExact =>
  async (offset, length) => {
    checkCancelled(signal);
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 0 ||
      offset > sourceBytes ||
      length > sourceBytes - offset
    )
      fail("Samsung TAR physical range exceeds the source extent.");
    let bytes: Buffer;
    try {
      bytes = await readExact(offset, length);
    } catch (cause) {
      checkCancelled(signal);
      throw cause;
    }
    checkCancelled(signal);
    if (!Buffer.isBuffer(bytes) || bytes.length !== length)
      fail("Samsung TAR reader did not return the exact requested byte range.");
    return bytes;
  };

const headerEvidence = (
  header: Buffer,
  offset: number,
): SamsungTarEntry["header"] => {
  const declaredChecksum = octal(header.subarray(148, 156), "header checksum");
  let calculatedChecksum = 0;
  for (let index = 0; index < BLOCK_BYTES; index++)
    calculatedChecksum += index >= 148 && index < 156 ? 32 : header[index]!;
  if (declaredChecksum !== calculatedChecksum)
    fail(`Samsung TAR header at ${String(offset)} has a checksum mismatch.`);
  return {
    location: { offset, bytes: BLOCK_BYTES },
    raw_hex: header.toString("hex"),
    sha256: createHash("sha256").update(header).digest("hex"),
    declared_checksum: declaredChecksum,
    calculated_checksum: calculatedChecksum,
  };
};

const headerProfile = (
  header: Buffer,
): Pick<SamsungTarEntry, "header_format" | "typeflag"> => {
  const magic = header.subarray(257, 265);
  const format = magic.equals(POSIX_MAGIC)
    ? "ustar"
    : magic.equals(GNU_MAGIC)
      ? "gnu"
      : fail("Samsung TAR header has unsupported magic or version.");
  const typeflag = header[156]!;
  if (typeflag !== 0 && typeflag !== 48 && typeflag !== 53)
    fail(
      `Samsung TAR typeflag ${String(typeflag)} is unsupported; links, PAX, GNU long names, sparse files and extensions are outside this profile.`,
    );
  const nonzeroNumericByte = (byte: number): boolean =>
    byte !== 0 && byte !== 32 && byte !== 48;
  if (
    format === "gnu" &&
    (header[482] !== 0 ||
      header.subarray(386, 482).some(nonzeroNumericByte) ||
      header.subarray(483, 495).some(nonzeroNumericByte))
  )
    fail("Samsung GNU TAR sparse maps and extended headers are unsupported.");
  return { header_format: format, typeflag };
};

const decodeEntry = (
  header: Buffer,
  offset: number,
  index: number,
  sourceBytes: number,
): SamsungTarEntry => {
  const evidence = headerEvidence(header, offset);
  const profile = headerProfile(header);
  const payloadBytes = octal(header.subarray(124, 136), "payload size");
  const kind = profile.typeflag === 53 ? "directory" : "file";
  if (kind === "directory" && payloadBytes !== 0)
    fail("Samsung TAR directory has a nonzero payload size.");
  const nameField = header.subarray(0, 100);
  const name = fieldText(nameField);
  if (name.length === 0) fail("Samsung TAR entry has an empty name field.");
  const prefixField =
    profile.header_format === "ustar" ? header.subarray(345, 500) : null;
  const prefix = prefixField === null ? "" : fieldText(prefixField);
  const path = normalizeArtifactPath(
    prefix === "" ? name : `${prefix}/${name}`,
  );
  if (kind === "file" && name.endsWith("/"))
    fail("Samsung TAR regular-file name ends with a directory separator.");

  const payloadOffset = offset + BLOCK_BYTES;
  const paddingBytes =
    (BLOCK_BYTES - (payloadBytes % BLOCK_BYTES)) % BLOCK_BYTES;
  if (
    payloadBytes > sourceBytes - payloadOffset ||
    paddingBytes > sourceBytes - payloadOffset - payloadBytes
  )
    fail("Samsung TAR payload or alignment padding exceeds the source extent.");
  return {
    index,
    path,
    name_raw_hex: nameField.toString("hex"),
    prefix_raw_hex: prefixField?.toString("hex") ?? null,
    ...profile,
    kind,
    header: evidence,
    payload: { location: { offset: payloadOffset, bytes: payloadBytes } },
    padding_location: {
      offset: payloadOffset + payloadBytes,
      bytes: paddingBytes,
    },
  };
};

const readEntries = async (
  read: ReadExact,
  sourceBytes: number,
  maxEntries: number,
  signal: AbortSignal | undefined,
) => {
  const paths = new ArtifactPathRegistry();
  paths.add("manifest.json", "file");
  paths.add("__samsung_footer.bin", "file");
  const entries: SamsungTarEntry[] = [];
  let entryMetadataBytes = 0;
  let offset = 0;
  while (true) {
    if (entries.length % 64 === 0) {
      await setImmediate();
      checkCancelled(signal);
    }
    const header = await read(offset, BLOCK_BYTES);
    if (allZero(header)) {
      const second = await read(offset + BLOCK_BYTES, BLOCK_BYTES);
      if (!allZero(second))
        fail("Samsung TAR requires two consecutive all-zero EOF blocks.");
      break;
    }
    if (entries.length >= maxEntries)
      limit(
        "Samsung TAR header count exceeds max_entries; no partial inventory is returned.",
      );
    const entry = decodeEntry(header, offset, entries.length, sourceBytes);
    const { offset: paddingOffset, bytes: paddingBytes } =
      entry.padding_location;
    if (paddingBytes > 0 && !allZero(await read(paddingOffset, paddingBytes)))
      fail("Samsung TAR payload alignment padding is not all zero.");
    // Include the caller's fixed-size payload hash before retaining this entry.
    entryMetadataBytes +=
      samsungMetadataBytes({
        ...entry,
        payload: { ...entry.payload, sha256: "0".repeat(64) },
      }) + (entries.length === 0 ? 0 : 1);
    if (entryMetadataBytes > METADATA_BYTES)
      limit("Samsung complete directory metadata exceeds the 8 MiB budget.");
    paths.add(entry.path, entry.kind);
    entries.push(entry);
    offset = paddingOffset + paddingBytes;
  }

  return {
    entries,
    entryMetadataBytes,
    zeroTerminator: { offset, bytes: 2 * BLOCK_BYTES },
  };
};

const findFooter = async (
  read: ReadExact,
  paddingOffset: number,
  sourceBytes: number,
  signal: AbortSignal | undefined,
): Promise<number> => {
  let footerOffset = paddingOffset;
  let scannedChunks = 0;
  while (footerOffset < sourceBytes) {
    if (scannedChunks % 16 === 0) {
      await setImmediate();
      checkCancelled(signal);
    }
    const chunk = await read(
      footerOffset,
      Math.min(READ_BYTES, sourceBytes - footerOffset),
    );
    const first = chunk.findIndex((byte) => byte !== 0);
    if (first >= 0) {
      footerOffset += first;
      break;
    }
    footerOffset += chunk.length;
    scannedChunks += 1;
  }
  if (footerOffset % BLOCK_BYTES !== 0)
    fail("Samsung TAR footer does not follow a complete aligned TAR extent.");
  return footerOffset;
};

/**
 * Original bounded reader for plain POSIX/GNU TAR entries and an ASCII Samsung
 * MD5 trailer. Build metadata preceding the checksum record belongs to the hash
 * prefix; it is outside the separately reported physical TAR extent.
 * The caller owns stable-source identity, payload hashes, and MD5 comparison.
 */
export const parseSamsungTarDirectory = async (
  readExact: ReadExact,
  sourceBytes: number,
  maxEntries: number,
  signal?: AbortSignal,
): Promise<SamsungTarDirectory> => {
  checkCancelled(signal);
  if (!Number.isSafeInteger(sourceBytes) || sourceBytes < 2 * BLOCK_BYTES)
    fail("Samsung TAR.MD5 source extent is not a valid exact byte count.");
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 65535)
    limit("Samsung TAR header budget must be an integer from 1 through 65535.");
  const read = validatedReader(readExact, sourceBytes, signal);
  const { entries, entryMetadataBytes, zeroTerminator } = await readEntries(
    read,
    sourceBytes,
    maxEntries,
    signal,
  );
  const paddingOffset = zeroTerminator.offset + zeroTerminator.bytes;
  const footerOffset = await findFooter(
    read,
    paddingOffset,
    sourceBytes,
    signal,
  );
  const footerBytes = sourceBytes - footerOffset;
  if (footerBytes > FOOTER_BYTES)
    limit("Samsung TAR.MD5 footer exceeds the 64 KiB budget.");
  const parsedFooter = parseFooter(
    await read(footerOffset, footerBytes),
    footerOffset,
  );
  const directory = {
    tar_location: { offset: 0, bytes: footerOffset },
    zero_terminator: zeroTerminator,
    padding_location: {
      offset: paddingOffset,
      bytes: footerOffset - paddingOffset,
    },
    ...parsedFooter,
  };
  if (
    entryMetadataBytes + samsungMetadataBytes({ ...directory, entries: [] }) >
    METADATA_BYTES
  )
    limit("Samsung complete directory metadata exceeds the 8 MiB budget.");
  checkCancelled(signal);
  return { ...directory, entries };
};
