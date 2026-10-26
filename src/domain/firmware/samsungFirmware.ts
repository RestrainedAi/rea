import { z } from "zod";
import { nulFreeStringSchema } from "../localPath.js";

const bytes = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const range = z.strictObject({ offset: bytes, bytes });
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const md5 = z.string().regex(/^[a-f0-9]{32}$/u);

export const inspectSamsungFirmwareInputSchema = z.strictObject({
  path: nulFreeStringSchema
    .min(1)
    .describe(
      "Absolute local Samsung TAR.MD5 package; never executed or flashed",
    ),
  max_file_bytes: bytes
    .min(1024)
    .max(64 * 1024 ** 3)
    .default(8 * 1024 ** 3)
    .describe(
      "Stable source I/O budget; payloads are hashed in bounded chunks",
    ),
  max_entries: bytes
    .min(1)
    .max(65535)
    .default(8192)
    .describe(
      "Complete TAR header budget; a limit refusal is not a partial inventory",
    ),
});

export const samsungFirmwareEntrySchema = z.strictObject({
  index: bytes,
  path: z.string().min(1),
  name_raw_hex: z.string().regex(/^[a-f0-9]{200}$/u),
  prefix_raw_hex: z
    .string()
    .regex(/^[a-f0-9]{310}$/u)
    .nullable(),
  header_format: z.enum(["ustar", "gnu"]),
  kind: z.enum(["file", "directory"]),
  typeflag: z.union([z.literal(0), z.literal(48), z.literal(53)]),
  header: z.strictObject({
    location: range,
    raw_hex: z.string().regex(/^[a-f0-9]{1024}$/u),
    sha256,
    declared_checksum: bytes,
    calculated_checksum: bytes,
  }),
  payload: z.strictObject({ location: range, sha256 }),
  padding_location: range,
});

/** File ranges are serialized bytes, with no device address or compatibility inference. */
export const samsungFirmwareSchema = z.strictObject({
  artifact: z.strictObject({ path: z.string().min(1), bytes, sha256 }),
  format: z.literal("samsung-tar-md5"),
  tar_location: range,
  zero_terminator: range,
  padding_location: range,
  footer: z.strictObject({
    location: range,
    raw_hex: z.string().regex(/^(?:[a-f0-9]{2})+$/u),
    text: z.string(),
    declared_tar_bytes: bytes.nullable(),
    checksum_record_location: range,
    checksum_filename: z.string(),
  }),
  integrity: z.strictObject({
    algorithm: z.literal("md5"),
    checksum_range: range,
    declared_md5: md5,
    calculated_md5: md5,
    status: z.enum(["match", "mismatch"]),
  }),
  entries: z.array(samsungFirmwareEntrySchema),
  coverage: z.strictObject({
    status: z.literal("complete-within-profile"),
    headers: bytes,
    files: bytes,
    source_bytes_hashed: bytes,
  }),
  limitations: z.array(z.string()),
});

export const extractSamsungFirmwareInputSchema =
  inspectSamsungFirmwareInputSchema.extend({
    output_root: nulFreeStringSchema
      .min(1)
      .describe(
        "Absolute absent output directory whose parent exists; never replaces files",
      ),
  });

export const samsungFirmwareExtractionSchema = z.strictObject({
  inventory: samsungFirmwareSchema,
  output_root: z.string().min(1),
  manifest_relative_path: z.literal("manifest.json"),
  footer_relative_path: z.literal("__samsung_footer.bin"),
  files: z.array(
    z.strictObject({
      entry_index: bytes,
      relative_path: z.string().min(1),
      bytes_written: bytes,
      sha256,
    }),
  ),
});

export type InspectSamsungFirmwareInput = z.infer<
  typeof inspectSamsungFirmwareInputSchema
>;
export type ExtractSamsungFirmwareInput = z.infer<
  typeof extractSamsungFirmwareInputSchema
>;
export type SamsungFirmware = z.infer<typeof samsungFirmwareSchema>;
export type SamsungFirmwareEntry = z.infer<typeof samsungFirmwareEntrySchema>;
export type SamsungFirmwareExtraction = z.infer<
  typeof samsungFirmwareExtractionSchema
>;
