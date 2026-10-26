import { createHash } from "node:crypto";
import type {
  InspectSamsungFirmwareInput,
  SamsungFirmware,
} from "../../domain/firmware/samsungFirmware.js";
import { parseSamsungTarDirectory } from "./SamsungTarDirectory.js";
import type { SamsungFirmwareSource } from "./SamsungFirmwareSource.js";
import { samsungMetadataBytes } from "./SamsungFirmwareBudget.js";

/** One complete byte pass binds the source, prefix checksum and every member digest. */
export const inspectSamsungFirmwareSource = async (
  source: SamsungFirmwareSource,
  input: InspectSamsungFirmwareInput,
  signal?: AbortSignal,
): Promise<SamsungFirmware> => {
  const directory = await parseSamsungTarDirectory(
    (offset, bytes) => source.readExact(offset, bytes, signal),
    source.bytes,
    input.max_entries,
    signal,
  );
  const checksumBytes = directory.footer.checksum_record_location.offset;
  const report: SamsungFirmware = {
    artifact: { path: input.path, bytes: source.bytes, sha256: "0".repeat(64) },
    format: "samsung-tar-md5",
    tar_location: directory.tar_location,
    zero_terminator: directory.zero_terminator,
    padding_location: directory.padding_location,
    footer: directory.footer,
    integrity: {
      algorithm: "md5",
      checksum_range: { offset: 0, bytes: checksumBytes },
      declared_md5: directory.declared_md5,
      calculated_md5: "0".repeat(32),
      status: "mismatch",
    },
    entries: directory.entries.map((entry) => ({
      ...entry,
      payload: { ...entry.payload, sha256: "0".repeat(64) },
    })),
    coverage: {
      status: "complete-within-profile",
      headers: directory.entries.length,
      files: directory.entries.filter((entry) => entry.kind === "file").length,
      source_bytes_hashed: source.bytes,
    },
    limitations: [
      "Static regular-file GNU/POSIX TAR.MD5 profile; payloads and build metadata remain opaque, and unsupported extensions are refused.",
      "The stored MD5 covers the prefix before its checksum record, including preceding build metadata. It is an integrity comparison, not authentication of publisher or firmware compatibility.",
      "All offsets are original file bytes; no image is mounted, code executed, device contacted, account changed or firmware flashed.",
    ],
  };
  // The longer mismatch spelling accounts for both outcomes before any full-byte pass.
  samsungMetadataBytes(report);
  const root = createHash("sha256");
  const md5 = createHash("md5");
  const members = directory.entries.map((entry) => ({
    entry,
    hash: createHash("sha256"),
  }));
  let currentMember = 0;
  for (let offset = 0; offset < source.bytes;) {
    signal?.throwIfAborted();
    const chunk = await source.readExact(
      offset,
      Math.min(1024 * 1024, source.bytes - offset),
      signal,
    );
    root.update(chunk);
    if (offset < checksumBytes)
      md5.update(
        chunk.subarray(0, Math.min(chunk.length, checksumBytes - offset)),
      );
    const end = offset + chunk.length;
    while (currentMember < members.length) {
      const member = members[currentMember]!;
      const range = member.entry.payload.location;
      const memberEnd = range.offset + range.bytes;
      if (range.offset >= end) break;
      const start = Math.max(offset, range.offset);
      const last = Math.min(end, memberEnd);
      if (last > start)
        member.hash.update(chunk.subarray(start - offset, last - offset));
      if (memberEnd > end) break;
      currentMember++;
    }
    offset = end;
  }
  await source.verifyStable(signal);
  const calculatedMd5 = md5.digest("hex");
  report.artifact.sha256 = root.digest("hex");
  report.integrity.calculated_md5 = calculatedMd5;
  report.integrity.status =
    calculatedMd5 === directory.declared_md5 ? "match" : "mismatch";
  for (const [index, member] of members.entries())
    report.entries[index]!.payload.sha256 = member.hash.digest("hex");
  return report;
};
