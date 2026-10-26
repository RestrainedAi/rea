import { createHash } from "node:crypto";

export interface SamsungTarFixtureEntry {
  readonly name: string;
  readonly payload: Buffer;
  readonly prefix?: string;
  readonly format?: "ustar" | "gnu";
  readonly typeflag?: number;
}

export interface SamsungTarFixtureOptions {
  readonly extraZeroBlocks?: number;
  /** Complete metadata before the final digest; default includes the TAR size. */
  readonly metadata?: string;
  readonly filename?: string;
  readonly separator?: " " | "  " | "\t";
  readonly newline?: "\n" | "\r\n" | "";
  readonly uppercaseMd5?: boolean;
  readonly declaredMd5?: string;
}

/** Hand-authored synthetic TAR bytes; this builder does not import the parser. */
export const samsungTarFixture = (
  members: readonly SamsungTarFixtureEntry[] = [
    { name: "boot.img", payload: Buffer.from([0x42, 0x4f, 0x4f, 0x54, 0]) },
    {
      name: "system.img",
      payload: Buffer.from("synthetic firmware payload\n"),
    },
  ],
  options: SamsungTarFixtureOptions = {},
) => {
  const chunks: Buffer[] = [];
  const entries: {
    readonly headerOffset: number;
    readonly payloadOffset: number;
    readonly payloadBytes: number;
    readonly paddingOffset: number;
    readonly paddingBytes: number;
  }[] = [];
  let offset = 0;
  for (const member of members) {
    const header = Buffer.alloc(512);
    header.write(member.name, 0, 100, "latin1");
    header.write("0000644\0", 100, "latin1");
    header.write("0000000\0", 108, "latin1");
    header.write("0000000\0", 116, "latin1");
    header.write(
      member.payload.length.toString(8).padStart(11, "0") + "\0",
      124,
      "latin1",
    );
    header.write("00000000000\0", 136, "latin1");
    header[156] = member.typeflag ?? 48;
    header.write(
      member.format === "gnu" ? "ustar  \0" : "ustar\0" + "00",
      257,
      "latin1",
    );
    if (member.format === "gnu") {
      // Old GNU offset 345 is atime, never a POSIX path prefix.
      header.write("14571340240\0", 345, "latin1");
      header.write("14571340241\0", 357, "latin1");
    } else if (member.prefix !== undefined)
      header.write(member.prefix, 345, 155, "latin1");
    samsungTarFixtureChecksum(header);
    const paddingBytes = (512 - (member.payload.length % 512)) % 512;
    entries.push({
      headerOffset: offset,
      payloadOffset: offset + 512,
      payloadBytes: member.payload.length,
      paddingOffset: offset + 512 + member.payload.length,
      paddingBytes,
    });
    chunks.push(header, member.payload, Buffer.alloc(paddingBytes));
    offset += 512 + member.payload.length + paddingBytes;
  }
  const zeroTerminatorOffset = offset;
  chunks.push(Buffer.alloc(1024 + (options.extraZeroBlocks ?? 0) * 512));
  const tar = Buffer.concat(chunks);
  const footerOffset = tar.length;
  const newline = options.newline ?? "\n";
  const metadata =
    options.metadata ??
    `Show the build information\nRBS BUILD_ID:synthetic\noriginal_tar_file_size:${String(footerOffset)}\n`;
  const prefix = Buffer.concat([tar, Buffer.from(metadata, "latin1")]);
  const calculatedMd5 = createHash("md5").update(prefix).digest("hex");
  const declared = options.declaredMd5 ?? calculatedMd5;
  const md5 = options.uppercaseMd5 === true ? declared.toUpperCase() : declared;
  const checksum = Buffer.from(
    `${md5}${options.separator ?? "  "}${options.filename ?? "synthetic_HOME.tar"}${newline}`,
    "latin1",
  );
  return {
    bytes: Buffer.concat([prefix, checksum]),
    entries,
    zeroTerminatorOffset,
    footerOffset,
    checksumRecordOffset: prefix.length,
    declaredMd5: declared.toLowerCase(),
  };
};

/** Recompute one synthetic header after a test deliberately edits its fields. */
export const samsungTarFixtureChecksum = (header: Buffer): void => {
  header.fill(32, 148, 156);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, "latin1");
};
