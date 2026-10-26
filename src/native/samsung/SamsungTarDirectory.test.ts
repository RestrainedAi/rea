import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { parseSamsungTarDirectory } from "./SamsungTarDirectory.js";
import {
  samsungTarFixture,
  samsungTarFixtureChecksum,
} from "./SamsungTarDirectory.fixture.js";

const parse = (bytes: Buffer, maxEntries = 8192, signal?: AbortSignal) =>
  parseSamsungTarDirectory(
    async (offset, length) => bytes.subarray(offset, offset + length),
    bytes.length,
    maxEntries,
    signal,
  );

const md5 = (bytes: Buffer): string =>
  createHash("md5").update(bytes).digest("hex");

const editHeader = (
  edit: (header: Buffer) => void,
  repairChecksum = true,
): Buffer => {
  const fixture = samsungTarFixture();
  const header = fixture.bytes.subarray(0, 512);
  edit(header);
  if (repairChecksum) samsungTarFixtureChecksum(header);
  return fixture.bytes;
};

describe("Samsung TAR directory and checksum framing", () => {
  it("retains exact entry evidence and the metadata-inclusive checksum boundary", async () => {
    const fixture = samsungTarFixture();
    const directory = await parse(fixture.bytes);
    expect(directory.tar_location).toEqual({
      offset: 0,
      bytes: fixture.footerOffset,
    });
    expect(directory.zero_terminator).toEqual({
      offset: fixture.zeroTerminatorOffset,
      bytes: 1024,
    });
    expect(directory.padding_location).toEqual({
      offset: fixture.footerOffset,
      bytes: 0,
    });
    expect(directory.declared_md5).toBe(fixture.declaredMd5);
    expect(directory.footer).toMatchObject({
      location: {
        offset: fixture.footerOffset,
        bytes: fixture.bytes.length - fixture.footerOffset,
      },
      raw_hex: fixture.bytes.subarray(fixture.footerOffset).toString("hex"),
      text: fixture.bytes.subarray(fixture.footerOffset).toString("latin1"),
      declared_tar_bytes: fixture.footerOffset,
      checksum_record_location: {
        offset: fixture.checksumRecordOffset,
        bytes: fixture.bytes.length - fixture.checksumRecordOffset,
      },
      checksum_filename: "synthetic_HOME.tar",
    });
    expect(
      md5(
        fixture.bytes.subarray(
          0,
          directory.footer.checksum_record_location.offset,
        ),
      ),
    ).toBe(directory.declared_md5);
    expect(
      md5(fixture.bytes.subarray(0, directory.tar_location.bytes)),
    ).not.toBe(directory.declared_md5);
    expect(directory.entries.map((entry) => entry.path)).toEqual([
      "boot.img",
      "system.img",
    ]);
    for (const entry of directory.entries) {
      const expected = fixture.entries[entry.index]!;
      const raw = fixture.bytes.subarray(
        expected.headerOffset,
        expected.headerOffset + 512,
      );
      expect(entry.header).toEqual({
        location: { offset: expected.headerOffset, bytes: 512 },
        raw_hex: raw.toString("hex"),
        sha256: createHash("sha256").update(raw).digest("hex"),
        declared_checksum: Number.parseInt(
          raw.subarray(148, 154).toString("ascii"),
          8,
        ),
        calculated_checksum: Number.parseInt(
          raw.subarray(148, 154).toString("ascii"),
          8,
        ),
      });
      expect(entry.name_raw_hex).toBe(raw.subarray(0, 100).toString("hex"));
      expect(entry.prefix_raw_hex).toBe(raw.subarray(345, 500).toString("hex"));
      expect(entry.payload).toEqual({
        location: {
          offset: expected.payloadOffset,
          bytes: expected.payloadBytes,
        },
      });
      expect(entry.padding_location).toEqual({
        offset: expected.paddingOffset,
        bytes: expected.paddingBytes,
      });
    }
  });

  it("keeps GNU timestamps out of Latin1 paths and decodes POSIX prefixes once", async () => {
    const fixture = samsungTarFixture([
      { name: "caf\xe9/", payload: Buffer.alloc(0), typeflag: 53 },
      {
        name: "boot\xff.img",
        payload: Buffer.alloc(512, 0xa5),
        format: "gnu",
        typeflag: 0,
      },
      { name: "system.img", prefix: "caf\xe9", payload: Buffer.alloc(0) },
    ]);
    const directory = await parse(fixture.bytes);
    expect(directory.entries).toMatchObject([
      {
        path: "café",
        kind: "directory",
        typeflag: 53,
        payload: { location: { bytes: 0 } },
      },
      {
        path: "bootÿ.img",
        header_format: "gnu",
        prefix_raw_hex: null,
        typeflag: 0,
        payload: { location: { bytes: 512 } },
        padding_location: { bytes: 0 },
      },
      { path: "café/system.img", header_format: "ustar" },
    ]);
    expect(
      Buffer.from(directory.entries[1]!.header.raw_hex, "hex")
        .subarray(345, 357)
        .toString("latin1"),
    ).toBe("14571340240\0");
  });
});

describe("Samsung supported footer and extent variants", () => {
  it.each(["\n", "\r\n", ""] as const)(
    "accepts a bare uppercase checksum with %j ending and preserves inert filenames",
    async (newline) => {
      const fixture = samsungTarFixture([], {
        metadata: "",
        filename: "../../inert name.tar",
        newline,
        uppercaseMd5: true,
      });
      const directory = await parse(fixture.bytes, 1);
      expect(directory.entries).toEqual([]);
      expect(directory.declared_md5).toBe(fixture.declaredMd5);
      expect(directory.footer.declared_tar_bytes).toBeNull();
      expect(directory.footer.checksum_record_location.offset).toBe(
        fixture.footerOffset,
      );
      expect(directory.footer.checksum_filename).toBe("../../inert name.tar");
      expect(directory.footer.text).toBe(
        `${fixture.declaredMd5.toUpperCase()}  ../../inert name.tar${newline}`,
      );
    },
  );

  it("preserves CRLF build metadata and bounded extra TAR zero padding", async () => {
    const fixture = samsungTarFixture(undefined, {
      extraZeroBlocks: 2051,
      metadata: "Show the build information\r\nRBS BUILD_ID:synthetic\r\n",
      newline: "\r\n",
    });
    const reads: { offset: number; length: number }[] = [];
    const directory = await parseSamsungTarDirectory(
      async (offset, length) => {
        reads.push({ offset, length });
        return fixture.bytes.subarray(offset, offset + length);
      },
      fixture.bytes.length,
      2,
    );
    expect(directory.padding_location).toEqual({
      offset: fixture.zeroTerminatorOffset + 1024,
      bytes: 2051 * 512,
    });
    expect(directory.footer.checksum_record_location.offset).toBe(
      fixture.checksumRecordOffset,
    );
    expect(Math.max(...reads.map((read) => read.length))).toBeLessThanOrEqual(
      64 * 1024,
    );
    expect(directory.footer.text).toContain("\r\nRBS BUILD_ID:synthetic\r\n");
  });

  it("parses a large physical extent without reading or allocating the payload", async () => {
    const header = Buffer.from(samsungTarFixture().bytes.subarray(0, 512));
    const payloadBytes = 4 * 1024 ** 3;
    header.write(
      payloadBytes.toString(8).padStart(11, "0") + "\0",
      124,
      "latin1",
    );
    samsungTarFixtureChecksum(header);
    const terminatorOffset = 512 + payloadBytes;
    const tarEnd = terminatorOffset + 1024;
    const footer = Buffer.from(
      `original_tar_file_size:${String(tarEnd)}\n${"a".repeat(32)}  inert.tar\n`,
    );
    const requests: number[] = [];
    const directory = await parseSamsungTarDirectory(
      async (offset, length) => {
        requests.push(length);
        if (offset === 0 && length === 512) return header;
        if (offset >= terminatorOffset && offset + length <= tarEnd)
          return Buffer.alloc(length);
        if (offset >= tarEnd)
          return footer.subarray(offset - tarEnd, offset - tarEnd + length);
        throw new Error("Parser requested synthetic payload bytes");
      },
      tarEnd + footer.length,
      1,
    );
    expect(directory.entries[0]!.payload.location).toEqual({
      offset: 512,
      bytes: payloadBytes,
    });
    expect(directory.tar_location.bytes).toBe(tarEnd);
    expect(Math.max(...requests)).toBeLessThanOrEqual(64 * 1024);
  });
});

describe("Samsung TAR malformed headers and physical ranges", () => {
  it.each([
    [
      "checksum corruption",
      () =>
        editHeader((header) => {
          header[0] = 0x58;
        }, false),
    ],
    [
      "unsupported magic",
      () =>
        editHeader((header) => {
          header.write("ustar!00", 257, "latin1");
        }),
    ],
    [
      "base-256 size",
      () =>
        editHeader((header) => {
          header[124] = 0x80;
        }),
    ],
    [
      "nonoctal size",
      () =>
        editHeader((header) => {
          header.write("00000000008\0", 124, "latin1");
        }),
    ],
    [
      "empty size",
      () =>
        editHeader((header) => {
          header.fill(0, 124, 136);
        }),
    ],
    [
      "negative size",
      () =>
        editHeader((header) => {
          header.write("-0000000001\0", 124, "latin1");
        }),
    ],
    [
      "base-256 checksum",
      () =>
        editHeader((header) => {
          header[148] = 0x80;
        }, false),
    ],
    [
      "nonoctal checksum",
      () =>
        editHeader((header) => {
          header.write("000008\0 ", 148, "latin1");
        }, false),
    ],
    [
      "payload beyond source",
      () =>
        editHeader((header) => {
          header.write("77777777777\0", 124, "latin1");
        }),
    ],
    [
      "directory with payload",
      () =>
        editHeader((header) => {
          header[156] = 53;
        }),
    ],
    [
      "file with directory suffix",
      () =>
        editHeader((header) => {
          header.fill(0, 0, 100);
          header.write("boot/", 0);
        }),
    ],
    [
      "empty name with prefix",
      () =>
        editHeader((header) => {
          header.fill(0, 0, 100);
          header.write("prefix", 345);
        }),
    ],
    [
      "nonzero member padding",
      () => {
        const fixture = samsungTarFixture();
        fixture.bytes[fixture.entries[0]!.paddingOffset] = 1;
        return fixture.bytes;
      },
    ],
    [
      "one EOF block",
      () => {
        const fixture = samsungTarFixture();
        fixture.bytes[fixture.zeroTerminatorOffset + 512] = 1;
        return fixture.bytes;
      },
    ],
    [
      "missing footer",
      () => {
        const fixture = samsungTarFixture();
        return fixture.bytes.subarray(0, fixture.footerOffset);
      },
    ],
    [
      "unaligned TAR extent",
      () => {
        const fixture = samsungTarFixture();
        return Buffer.concat([
          fixture.bytes.subarray(0, fixture.footerOffset),
          Buffer.alloc(1),
          fixture.bytes.subarray(fixture.footerOffset),
        ]);
      },
    ],
    [
      "truncated EOF blocks",
      () => {
        const fixture = samsungTarFixture();
        return fixture.bytes.subarray(0, fixture.zeroTerminatorOffset + 1023);
      },
    ],
  ] as const)("refuses %s", async (_label, makeBytes) => {
    await expect(parse(makeBytes())).rejects.toMatchObject({
      name: "ArtifactReaderFailure",
      reason: "format",
    });
  });
});

describe("Samsung unsupported TAR extensions and read contract", () => {
  it.each([49, 50, 75, 76, 83, 103, 120, 77])(
    "refuses unsupported TAR typeflag %i",
    async (typeflag) => {
      await expect(
        parse(
          editHeader((header) => {
            header[156] = typeflag;
          }),
        ),
      ).rejects.toMatchObject({ reason: "format" });
    },
  );

  it.each([386, 482, 483])(
    "refuses GNU sparse/extension byte at %i",
    async (at) => {
      const fixture = samsungTarFixture([
        { name: "boot.img", payload: Buffer.alloc(0), format: "gnu" },
      ]);
      const header = fixture.bytes.subarray(0, 512);
      header[at] = 49;
      samsungTarFixtureChecksum(header);
      await expect(parse(fixture.bytes)).rejects.toMatchObject({
        reason: "format",
      });
    },
  );

  it("refuses a reader that returns a shorter range than requested", async () => {
    const fixture = samsungTarFixture();
    await expect(
      parseSamsungTarDirectory(
        async (offset, length) =>
          fixture.bytes.subarray(offset, offset + length - 1),
        fixture.bytes.length,
        2,
      ),
    ).rejects.toMatchObject({ reason: "format" });
  });
});

describe("Samsung path safety and metadata destinations", () => {
  it.each([
    "../escape.img",
    "/absolute.img",
    "C:drive.img",
    "nested\\escape.img",
    "nested//image",
    "./image",
    "manifest.json",
    "__samsung_footer.bin",
    "manifest.json/child",
    "__samsung_footer.bin/child",
  ])("refuses unsafe or reserved path %j", async (name) => {
    const fixture = samsungTarFixture([{ name, payload: Buffer.alloc(0) }]);
    await expect(parse(fixture.bytes)).rejects.toMatchObject({
      reason: "path",
    });
  });

  it("rejects traversal in a POSIX prefix and duplicate or conflicting normalized paths", async () => {
    const cases = [
      [{ name: "boot.img", prefix: "../escape", payload: Buffer.alloc(0) }],
      [
        { name: "image", payload: Buffer.alloc(0) },
        { name: "image", payload: Buffer.alloc(0) },
      ],
      [
        { name: "dir/", payload: Buffer.alloc(0), typeflag: 53 },
        { name: "dir", payload: Buffer.alloc(0), typeflag: 53 },
      ],
      [
        { name: "dir/image", payload: Buffer.alloc(0) },
        { name: "dir", payload: Buffer.alloc(0) },
      ],
      [
        { name: "dir", payload: Buffer.alloc(0) },
        { name: "dir/image", payload: Buffer.alloc(0) },
      ],
    ];
    for (const members of cases)
      await expect(
        parse(samsungTarFixture(members).bytes),
      ).rejects.toMatchObject({ reason: "path" });
  });
});

describe("Samsung footer validation", () => {
  const digest = "0123456789abcdef0123456789abcdef";
  it.each([
    ["missing filename", `${digest}\n`],
    ["whitespace-only filename", `${digest}   \n`],
    ["short digest", `${digest.slice(1)}  image.tar\n`],
    ["long digest", `${digest}0  image.tar\n`],
    ["invalid digest", `${digest.slice(1)}g  image.tar\n`],
    ["extra checksum", `${digest}  first.tar\n${digest}  second.tar\n`],
    ["trailing record", `${digest}  image.tar\ntrailing\n`],
    ["trailing blank line", `${digest}  image.tar\n\n`],
    ["bare CR in record", `${digest}  image.tar\r`],
    ["bare CR in metadata", `build\rmetadata\n${digest}  image.tar\n`],
    ["NUL byte", `build\0metadata\n${digest}  image.tar\n`],
    ["non-ASCII byte", `build\xff\n${digest}  image.tar\n`],
    ["control byte", `build\x1b\n${digest}  image.tar\n`],
    ["mismatched size", `original_tar_file_size:1\n${digest}  image.tar\n`],
    [
      "fractional size",
      `original_tar_file_size:1024.0\n${digest}  image.tar\n`,
    ],
    [
      "unsafe integer size",
      `original_tar_file_size:9007199254740993\n${digest}  image.tar\n`,
    ],
    ["negative size", `original_tar_file_size:-1024\n${digest}  image.tar\n`],
    [
      "duplicate size",
      `original_tar_file_size:1024\noriginal_tar_file_size:1024\n${digest}  image.tar\n`,
    ],
  ] as const)("refuses %s", async (_label, footer) => {
    const bytes = Buffer.concat([
      Buffer.alloc(1024),
      Buffer.from(footer, "latin1"),
    ]);
    await expect(parse(bytes)).rejects.toMatchObject({ reason: "format" });
  });

  it("refuses a footer above its serialized byte budget", async () => {
    const fixture = samsungTarFixture([], {
      metadata: "x".repeat(64 * 1024) + "\n",
    });
    await expect(parse(fixture.bytes)).rejects.toMatchObject({
      reason: "limit",
    });
  });
});

describe("Samsung directory limits and cancellation", () => {
  it("enforces the complete header budget without returning a partial directory", async () => {
    const fixture = samsungTarFixture();
    await expect(parse(fixture.bytes, 1)).rejects.toMatchObject({
      reason: "limit",
    });
    expect((await parse(fixture.bytes, 2)).entries).toHaveLength(2);
  });

  it.each([0, 1.5, 65536, Number.NaN])(
    "refuses invalid max_entries %s",
    async (maxEntries) => {
      await expect(
        parse(samsungTarFixture().bytes, maxEntries),
      ).rejects.toMatchObject({ reason: "limit" });
    },
  );

  it.each([
    1023,
    -1,
    1024.5,
    Number.MAX_SAFE_INTEGER + 1,
    Number.POSITIVE_INFINITY,
    Number.NaN,
  ])("refuses inexact or invalid source extent %s", async (sourceBytes) => {
    await expect(
      parseSamsungTarDirectory(async () => Buffer.alloc(0), sourceBytes, 1),
    ).rejects.toMatchObject({ reason: "format" });
  });

  it("enforces metadata expansion before retaining an oversized directory", async () => {
    const fixture = samsungTarFixture(
      Array.from({ length: 5000 }, (_unused, index) => ({
        name: `file-${String(index)}.img`,
        payload: Buffer.alloc(0),
      })),
    );
    await expect(parse(fixture.bytes, 65535)).rejects.toMatchObject({
      reason: "limit",
    });
  });

  it("returns tagged cancellation before a read and immediately after an awaited read", async () => {
    const fixture = samsungTarFixture();
    const before = new AbortController();
    before.abort();
    await expect(parse(fixture.bytes, 2, before.signal)).rejects.toMatchObject({
      reason: "cancelled",
    });
    const during = new AbortController();
    await expect(
      parseSamsungTarDirectory(
        async (offset, length) => {
          during.abort("Synthetic cancellation during read");
          return fixture.bytes.subarray(offset, offset + length);
        },
        fixture.bytes.length,
        2,
        during.signal,
      ),
    ).rejects.toMatchObject({ reason: "cancelled" });
  });

  it("preserves cancellation when the reader rejects and yields during directory loops", async () => {
    const controller = new AbortController();
    await expect(
      parseSamsungTarDirectory(
        async () => {
          controller.abort();
          throw new Error("read aborted");
        },
        4096,
        1,
        controller.signal,
      ),
    ).rejects.toMatchObject({ reason: "cancelled" });
    const fixture = samsungTarFixture(
      Array.from({ length: 512 }, (_unused, index) => ({
        name: `entry-${String(index)}`,
        payload: Buffer.alloc(0),
      })),
    );
    const loop = new AbortController();
    const pending = parse(fixture.bytes, 512, loop.signal);
    setImmediate(() => loop.abort());
    await expect(pending).rejects.toMatchObject({ reason: "cancelled" });
  });
});
