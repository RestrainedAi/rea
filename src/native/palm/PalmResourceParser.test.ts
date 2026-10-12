import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  inspectPalmResourcesInputSchema,
  palmResourcesSchema,
} from "../../domain/native/palmResources.js";
import { parsePalmResources } from "./PalmResourceParser.js";
import { palmResourceFixture } from "./PalmResources.fixture.js";

const parse = (bytes: Buffer, maxEntries = 16384, signal?: AbortSignal) =>
  parsePalmResources(
    bytes,
    {
      path: "/fixtures/test.prc",
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
    inspectPalmResourcesInputSchema.parse({
      path: "/fixtures/test.prc",
      max_entries: maxEntries,
    }),
    signal,
  );
describe("Palm serialized resource inventory", () => {
  it.each([0, 2, 19])(
    "accepts directory gap %i and retains the last resource through EOF",
    async (gap) => {
      const fixture = palmResourceFixture(
        undefined,
        gap,
        Buffer.from("APP"),
        Buffer.from("SORT"),
      );
      const report = palmResourcesSchema.parse(await parse(fixture.bytes));
      expect(report.header).toMatchObject({
        name: { value: "Fixture" },
        database_version: 7,
        created_raw: 0x12345678,
        database_type: { value: "appl" },
        creator: { value: "Test" },
        resource_count: 4,
      });
      expect(report.directory_gap.location).toEqual({
        offset: fixture.directoryEnd,
        bytes: gap,
      });
      expect(report.app_info?.location.bytes).toBe(3);
      expect(report.sort_info?.location.bytes).toBe(4);
      expect(report.resources.at(-1)).toMatchObject({
        type: { value: "tAIN" },
        text: { value: "Fixture", nul_terminated: true },
      });
      const last = report.resources.at(-1)!;
      expect(last.payload.location.offset + last.payload.location.bytes).toBe(
        fixture.bytes.length,
      );
      for (const item of report.resources) {
        const { offset, bytes: size } = item.payload.location;
        expect(item.payload.sha256).toBe(
          createHash("sha256")
            .update(fixture.bytes.subarray(offset, offset + size))
            .digest("hex"),
        );
      }
      expect(report.resources[0]?.classification).toBe("code-tagged");
    },
  );
  it("preserves empty databases and a zero-byte final resource", async () => {
    expect(await parse(palmResourceFixture([]).bytes)).toMatchObject({
      resources: [],
      coverage: { status: "complete", resources: 0 },
    });
    expect(
      await parse(
        palmResourceFixture([{ type: "data", id: 0, bytes: Buffer.alloc(0) }])
          .bytes,
      ),
    ).toMatchObject({ resources: [{ payload: { location: { bytes: 0 } } }] });
  });
  it("preserves non-ASCII type/name bytes and a non-terminated metadata string", async () => {
    const fixture = palmResourceFixture([
      { type: "tver", id: 1, bytes: Buffer.from([0xe9, 0xff]) },
    ]);
    fixture.bytes[0] = 0xe9;
    fixture.bytes[64] = 0xff;
    expect(await parse(fixture.bytes)).toMatchObject({
      header: { name: { value: "éixture" }, creator: { raw_hex: "ff657374" } },
      resources: [
        {
          text: {
            value: "éÿ",
            encoding: "byte-preserving-latin1",
            nul_terminated: false,
          },
        },
      ],
    });
  });
});

describe("Palm resource validation and limits", () => {
  it.each([
    ["short header", () => Buffer.alloc(77)],
    [
      "ebook/record database",
      () => {
        const f = palmResourceFixture();
        f.bytes.writeUInt16BE(0, 32);
        f.bytes.write("BOOK", 60);
        f.bytes.write("MOBI", 64);
        return f.bytes;
      },
    ],
    [
      "chained lists",
      () => {
        const f = palmResourceFixture();
        f.bytes.writeUInt32BE(128, 72);
        return f.bytes;
      },
    ],
    [
      "unterminated name",
      () => {
        const f = palmResourceFixture();
        f.bytes.fill(65, 0, 32);
        return f.bytes;
      },
    ],
    [
      "truncated entries",
      () => {
        const f = palmResourceFixture();
        f.bytes.writeUInt16BE(100, 76);
        return f.bytes;
      },
    ],
    [
      "payload in directory",
      () => {
        const f = palmResourceFixture();
        f.bytes.writeUInt32BE(78, 84);
        return f.bytes;
      },
    ],
    [
      "payload beyond EOF",
      () => {
        const f = palmResourceFixture();
        f.bytes.writeUInt32BE(f.bytes.length + 1, 84);
        return f.bytes;
      },
    ],
    [
      "duplicate offsets",
      () => {
        const f = palmResourceFixture();
        f.bytes.writeUInt32BE(f.offsets[0]!, 94);
        return f.bytes;
      },
    ],
    [
      "descending offsets",
      () => {
        const f = palmResourceFixture();
        f.bytes.writeUInt32BE(f.offsets[0]! - 1, 94);
        return f.bytes;
      },
    ],
    [
      "duplicate type/ID",
      () => {
        const f = palmResourceFixture();
        f.bytes.writeUInt16BE(0, 92);
        return f.bytes;
      },
    ],
    [
      "overlapping appInfo",
      () => {
        const f = palmResourceFixture();
        f.bytes.writeUInt32BE(79, 52);
        return f.bytes;
      },
    ],
    [
      "appInfo follows sortInfo",
      () => {
        const f = palmResourceFixture(
          undefined,
          2,
          Buffer.from("A"),
          Buffer.from("S"),
        );
        f.bytes.writeUInt32BE(f.bytes.readUInt32BE(56) + 1, 52);
        return f.bytes;
      },
    ],
  ] as const)("rejects %s without partial success", async (_name, mutate) => {
    await expect(parse(mutate())).rejects.toMatchObject({ reason: "format" });
  });
  it("enforces resource and metadata budgets before returning a record", async () => {
    await expect(parse(palmResourceFixture().bytes, 1)).rejects.toMatchObject({
      reason: "limit",
    });
    await expect(
      parse(
        palmResourceFixture([
          { type: "tver", id: 1, bytes: Buffer.alloc(2 * 1024 * 1024, 1) },
        ]).bytes,
      ),
    ).rejects.toMatchObject({ reason: "limit" });
  });
  it("responds to cancellation during directory traversal", async () => {
    const controller = new AbortController();
    const result = parse(palmResourceFixture().bytes, 16384, controller.signal);
    controller.abort();
    await expect(result).rejects.toThrow();
  });
});
