interface Resource {
  readonly type: string;
  readonly id: number;
  readonly bytes: Buffer;
}

/** Hand-authored serialized Palm bytes, independent of the production parser. */
export const palmResourceFixture = (
  resources: readonly Resource[] = [
    { type: "code", id: 0, bytes: Buffer.from([0, 1, 2, 3]) },
    { type: "code", id: 1, bytes: Buffer.from([0x70, 0x2a, 0x4e, 0x75]) },
    { type: "tver", id: 1, bytes: Buffer.from("1.0\0") },
    { type: "tAIN", id: 1000, bytes: Buffer.from("Fixture\0") },
  ],
  gap = 2,
  appInfo = Buffer.alloc(0),
  sortInfo = Buffer.alloc(0),
) => {
  const directoryEnd = 78 + resources.length * 10;
  const firstBlock = directoryEnd + gap;
  const firstResource = firstBlock + appInfo.length + sortInfo.length;
  const bytes = Buffer.alloc(
    firstResource + resources.reduce((sum, item) => sum + item.bytes.length, 0),
  );
  bytes.write("Fixture", 0, "latin1");
  bytes.writeUInt16BE(1, 32);
  bytes.writeUInt16BE(7, 34);
  bytes.writeUInt32BE(0x12345678, 36);
  bytes.write("appl", 60, "latin1");
  bytes.write("Test", 64, "latin1");
  if (appInfo.length > 0) bytes.writeUInt32BE(firstBlock, 52);
  if (sortInfo.length > 0) bytes.writeUInt32BE(firstBlock + appInfo.length, 56);
  bytes.writeUInt16BE(resources.length, 76);
  appInfo.copy(bytes, firstBlock);
  sortInfo.copy(bytes, firstBlock + appInfo.length);
  let payloadOffset = firstResource;
  const offsets: number[] = [];
  resources.forEach((resource, index) => {
    const at = 78 + index * 10;
    bytes.write(resource.type, at, 4, "latin1");
    bytes.writeUInt16BE(resource.id, at + 4);
    bytes.writeUInt32BE(payloadOffset, at + 6);
    offsets.push(payloadOffset);
    resource.bytes.copy(bytes, payloadOffset);
    payloadOffset += resource.bytes.length;
  });
  return { bytes, directoryEnd, offsets };
};
