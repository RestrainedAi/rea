/** Recognize a 7z start signature only; directory and payload validity belong to its reader. */
export const hasSevenZipSignature = (bytes: Uint8Array): boolean =>
  bytes.length >= 6 &&
  bytes[0] === 0x37 &&
  bytes[1] === 0x7a &&
  bytes[2] === 0xbc &&
  bytes[3] === 0xaf &&
  bytes[4] === 0x27 &&
  bytes[5] === 0x1c;
