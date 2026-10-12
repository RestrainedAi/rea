import { deflateSync } from "node:zlib";
import { INSTYLER_SIGNATURE } from "./InstylerDirectory.js";

/** Original synthetic PE/Instyler fixture: no supplied executable bytes. */
export const instylerArchiveFixture = (
  members: readonly { readonly filename: string; readonly bytes: Buffer }[] = [
    {
      filename: "%appfolder%\\application.exe",
      bytes: Buffer.from("Controlled payload"),
    },
    { filename: "%appfolder%\\empty.bin", bytes: Buffer.alloc(0) },
  ],
  auxiliaryBytes = Buffer.alloc(161),
) => {
  const wrapper = Buffer.alloc(1024);
  wrapper.write("MZ", 0);
  wrapper.writeUInt32LE(0x80, 60);
  wrapper.writeUInt32LE(0x4550, 0x80);
  wrapper.writeUInt16LE(0x14c, 0x84);
  wrapper.writeUInt16LE(1, 0x86);
  wrapper.writeUInt16LE(224, 0x94);
  wrapper.writeUInt16LE(0x102, 0x96);
  const optional = 0x98;
  wrapper.writeUInt16LE(0x10b, optional);
  wrapper.writeUInt32LE(0x1000, optional + 16);
  wrapper.writeUInt32LE(0x400000, optional + 28);
  wrapper.writeUInt32LE(0x1000, optional + 32);
  wrapper.writeUInt32LE(512, optional + 36);
  wrapper.writeUInt32LE(0x2000, optional + 56);
  wrapper.writeUInt32LE(512, optional + 60);
  wrapper.writeUInt16LE(3, optional + 68);
  wrapper.writeUInt32LE(16, optional + 92);
  const section = optional + 224;
  wrapper.write(".stub", section);
  wrapper.writeUInt32LE(512, section + 8);
  wrapper.writeUInt32LE(0x1000, section + 12);
  wrapper.writeUInt32LE(512, section + 16);
  wrapper.writeUInt32LE(512, section + 20);
  wrapper.writeUInt32LE(0x60000020, section + 36);
  wrapper.set([0xb8, 42, 0, 0, 0, 0xc3], 512);
  const config = Buffer.alloc(0x1b9a);
  config.writeUInt16LE(members.length, 0x1a92);
  const directory = Buffer.alloc(members.length * 0x11f);
  const frames: Buffer[] = [];
  let relative = 0;
  for (const [index, member] of members.entries()) {
    const at = index * 0x11f;
    const name = Buffer.from(member.filename, "latin1");
    if (name.length === 0 || name.length > 255)
      throw new Error("Fixture filename exceeds shortstring bounds");
    const encoded = deflateSync(member.bytes);
    directory[at] = 1;
    directory[at + 1] = 1;
    directory.writeUInt32LE(relative, at + 2);
    directory[at + 6] = name.length;
    name.copy(directory, at + 7);
    directory.writeUInt32LE(member.bytes.length, at + 278);
    directory.writeUInt32LE(encoded.length, at + 282);
    const frame = Buffer.concat([
      Buffer.from([0x7a, 0x6c, 0x62, 0x1a]),
      encoded,
    ]);
    frames.push(frame);
    relative += frame.length;
  }
  const overlayOffset = wrapper.length;
  const directoryOffset =
    overlayOffset + INSTYLER_SIGNATURE.length + config.length;
  const dataOffset = directoryOffset + directory.length + auxiliaryBytes.length;
  return {
    bytes: Buffer.concat([
      wrapper,
      INSTYLER_SIGNATURE,
      config,
      directory,
      auxiliaryBytes,
      ...frames,
    ]),
    overlayOffset,
    directoryOffset,
    dataOffset,
    recordOffsets: members.map(
      (_member, index) => directoryOffset + index * 0x11f,
    ),
  };
};
