import { describe, expect, it } from "vitest";
import { parseInstylerDirectory } from "./InstylerDirectory.js";
import { instylerArchiveFixture } from "./InstylerDirectory.fixture.js";
import { readPeFileLayout } from "../pe/PeFileLayout.js";

describe("Instyler directory and encoded coverage", () => {
  it.each([0, 161, 803])(
    "retains opaque auxiliary bytes=%i while covering every declared frame through EOF",
    async (auxiliaryBytes) => {
      const fixture = instylerArchiveFixture(
        undefined,
        Buffer.alloc(auxiliaryBytes, 65),
      );
      const parsed = await parseInstylerDirectory(fixture.bytes);
      expect(parsed).toMatchObject({
        overlay_offset: fixture.overlayOffset,
        data_offset: fixture.dataOffset,
        metadata_bytes: fixture.dataOffset - fixture.overlayOffset,
      });
      expect(parsed?.members).toHaveLength(2);
      expect(parsed?.members[0]).toMatchObject({
        index: 0,
        filename: "%appfolder%\\application.exe",
        record_offset: fixture.recordOffsets[0],
      });
      expect(parsed?.members[1]?.decoded_bytes).toBe(0);
      const last = parsed!.members.at(-1)!;
      expect(last.compressed_offset + last.compressed_bytes).toBe(
        fixture.bytes.length,
      );
    },
  );
  it("preserves original shortstring bytes rather than guessing a Windows code page", async () => {
    const fixture = instylerArchiveFixture([
      { filename: "caf\u00e9.bin", bytes: Buffer.from([1]) },
    ]);
    expect(await parseInstylerDirectory(fixture.bytes)).toMatchObject({
      members: [
        { filename: "caf\u00e9.bin", filename_hex: "636166e92e62696e" },
      ],
    });
  });
  it("recognizes no Instyler profile in an ordinary PE and retains a zero-member archive", async () => {
    const fixture = instylerArchiveFixture([]);
    expect(
      await parseInstylerDirectory(
        fixture.bytes.subarray(0, fixture.overlayOffset),
      ),
    ).toBeUndefined();
    expect(await parseInstylerDirectory(fixture.bytes)).toMatchObject({
      members: [],
      data_offset: fixture.bytes.length,
    });
  });
  it("maps raw PE extent from bounded headers and authoritative source length", () => {
    const fixture = instylerArchiveFixture();
    expect(
      readPeFileLayout(fixture.bytes.subarray(0, 512), fixture.bytes.length)
        .file_body_end,
    ).toBe(fixture.overlayOffset);
    const header = Buffer.from(fixture.bytes.subarray(0, 512));
    header.writeUInt32LE(128 * 1024 * 1024, 0x178 + 16);
    expect(
      readPeFileLayout(header, 512 + 128 * 1024 * 1024).file_body_end,
    ).toBe(512 + 128 * 1024 * 1024);
    expect(() => readPeFileLayout(header, 1024)).toThrow();
  });
});

describe("Instyler malformed directory and budgets", () => {
  it.each([
    [
      "truncated config",
      (f: ReturnType<typeof instylerArchiveFixture>) =>
        f.bytes.subarray(0, f.overlayOffset + 100),
    ],
    [
      "truncated directory",
      (f: ReturnType<typeof instylerArchiveFixture>) =>
        f.bytes.subarray(0, f.directoryOffset + 200),
    ],
    [
      "unavailable attribute rows",
      (f: ReturnType<typeof instylerArchiveFixture>) => {
        f.bytes.writeUInt16LE(65535, f.overlayOffset + 6 + 0x1a90);
        return f.bytes;
      },
    ],
    [
      "unsupported file flags",
      (f: ReturnType<typeof instylerArchiveFixture>) => {
        f.bytes[f.directoryOffset] = 2;
        return f.bytes;
      },
    ],
    [
      "empty filename",
      (f: ReturnType<typeof instylerArchiveFixture>) => {
        f.bytes[f.directoryOffset + 6] = 0;
        return f.bytes;
      },
    ],
    [
      "NUL name",
      (f: ReturnType<typeof instylerArchiveFixture>) => {
        f.bytes[f.directoryOffset + 7] = 0;
        return f.bytes;
      },
    ],
    [
      "overlapping data",
      (f: ReturnType<typeof instylerArchiveFixture>) => {
        f.bytes.writeUInt32LE(0, f.recordOffsets[1]! + 2);
        return f.bytes;
      },
    ],
    [
      "missing frame",
      (f: ReturnType<typeof instylerArchiveFixture>) => {
        f.bytes[f.dataOffset] = 0;
        return f.bytes;
      },
    ],
    [
      "added unknown tail",
      (f: ReturnType<typeof instylerArchiveFixture>) =>
        Buffer.concat([f.bytes, Buffer.from([1])]),
    ],
  ] as const)(
    "rejects %s without a partial directory",
    async (_name, mutate) => {
      await expect(
        parseInstylerDirectory(mutate(instylerArchiveFixture())),
      ).rejects.toMatchObject({ reason: "format" });
    },
  );
  it("refuses duplicate filenames and expansion before inflation", async () => {
    const duplicate = instylerArchiveFixture([
      { filename: "same.bin", bytes: Buffer.from([1]) },
      { filename: "same.bin", bytes: Buffer.from([2]) },
    ]);
    await expect(parseInstylerDirectory(duplicate.bytes)).rejects.toMatchObject(
      { reason: "format" },
    );
    const oversized = instylerArchiveFixture();
    oversized.bytes.writeUInt32LE(
      64 * 1024 * 1024 + 1,
      oversized.directoryOffset + 278,
    );
    await expect(parseInstylerDirectory(oversized.bytes)).rejects.toMatchObject(
      { reason: "limit" },
    );
  });
  it("accepts a valid declared attribute block without interpreting it", async () => {
    const fixture = instylerArchiveFixture();
    const bytes = Buffer.concat([
      fixture.bytes.subarray(0, fixture.directoryOffset),
      Buffer.alloc(48),
      fixture.bytes.subarray(fixture.directoryOffset),
    ]);
    bytes.writeUInt16LE(1, fixture.overlayOffset + 6 + 0x1a90);
    expect(await parseInstylerDirectory(bytes)).toMatchObject({
      data_offset: fixture.dataOffset + 48,
      members: [
        { record_offset: fixture.directoryOffset + 48 },
        { record_offset: fixture.recordOffsets[1]! + 48 },
      ],
    });
  });
  it("yields cancellation during directory traversal", async () => {
    const controller = new AbortController();
    const result = parseInstylerDirectory(
      instylerArchiveFixture().bytes,
      controller.signal,
    );
    controller.abort();
    await expect(result).rejects.toThrow();
  });
});
