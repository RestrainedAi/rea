import { z } from "zod";
import { nulFreeStringSchema } from "../localPath.js";

const uint = z.number().int().min(0).max(0xffffffff);
const word = uint.max(65535);
const range = z.strictObject({ offset: uint, bytes: uint });
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const fourcc = z.strictObject({
  value: z.string().length(4),
  raw_hex: z.string().regex(/^[a-f0-9]{8}$/),
});
const block = z.strictObject({ location: range, sha256: digest });

export const inspectPalmResourcesInputSchema = z.strictObject({
  path: nulFreeStringSchema
    .min(1)
    .describe(
      "Absolute local path to a Palm application/resource database; the filename extension is not used for classification",
    ),
  max_file_bytes: z
    .number()
    .int()
    .min(78)
    .max(512 * 1024 * 1024)
    .default(64 * 1024 * 1024)
    .describe("Maximum stable file bytes to read"),
  max_entries: z
    .number()
    .int()
    .min(1)
    .max(65535)
    .default(16384)
    .describe(
      "Maximum resource directory entries; exceeding the budget returns no partial inventory",
    ),
});

/** Serialized file bytes, not live Palm memory addresses or recovered source. */
export const palmResourcesSchema = z.strictObject({
  artifact: z.strictObject({
    path: z.string().min(1),
    bytes: uint,
    sha256: digest,
  }),
  format: z.literal("palm-resource-database"),
  header: z.strictObject({
    location: range,
    name: z.strictObject({
      value: z.string(),
      raw_hex: z.string().regex(/^[a-f0-9]{64}$/),
    }),
    attributes: word,
    database_version: word,
    created_raw: uint,
    modified_raw: uint,
    backup_raw: uint,
    modification_number: uint,
    app_info_offset: uint,
    sort_info_offset: uint,
    database_type: fourcc,
    creator: fourcc,
    unique_id_seed: uint,
    next_record_list_offset: uint,
    resource_count: word,
  }),
  directory_location: range,
  directory_gap: block,
  app_info: block.nullable(),
  sort_info: block.nullable(),
  resources: z.array(
    z.strictObject({
      index: uint,
      type: fourcc,
      id: word,
      entry_location: range,
      payload: block,
      classification: z.enum(["code-tagged", "data-tagged", "other"]),
      text: z
        .strictObject({
          value: z.string(),
          encoding: z.literal("byte-preserving-latin1"),
          nul_terminated: z.boolean(),
        })
        .nullable(),
    }),
  ),
  coverage: z.strictObject({
    status: z.literal("complete"),
    examined_entries: uint,
    resources: uint,
  }),
  limitations: z.array(z.string()),
});

export type InspectPalmResourcesInput = z.infer<
  typeof inspectPalmResourcesInputSchema
>;
export type PalmResources = z.infer<typeof palmResourcesSchema>;

export const extractPalmResourcesInputSchema =
  inspectPalmResourcesInputSchema.extend({
    output_root: nulFreeStringSchema
      .min(1)
      .describe(
        "Absolute absent output directory with an existing parent; existing destinations are never replaced",
      ),
  });

export const palmExtractionSchema = z.strictObject({
  inventory: palmResourcesSchema,
  output_root: z.string().min(1),
  manifest_relative_path: z.literal("manifest.json"),
  files: z.array(
    z.strictObject({
      resource_index: uint,
      relative_path: z
        .string()
        .regex(/^resources\/[0-9]{5}-[a-f0-9]{8}-[0-9]{5}\.bin$/),
      sha256: digest,
      bytes_written: uint,
    }),
  ),
});

export type ExtractPalmResourcesInput = z.infer<
  typeof extractPalmResourcesInputSchema
>;
export type PalmExtraction = z.infer<typeof palmExtractionSchema>;

/** Portable names never embed an untrusted database name or raw FourCC. */
export const palmResourceExportPath = (
  resource: Pick<PalmResources["resources"][number], "index" | "type" | "id">,
): string =>
  `resources/${String(resource.index).padStart(5, "0")}-${resource.type.raw_hex}-${String(resource.id).padStart(5, "0")}.bin`;
