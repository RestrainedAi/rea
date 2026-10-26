import { z } from "zod";

export const STATIC_ARCHIVE_PROTOCOL = "rea.static-archive/1";
export const STATIC_ARCHIVE_METADATA_BYTES = 8 * 1024 * 1024;
export const STATIC_ARCHIVE_LIMITS = Object.freeze({
  max_entries: 4096,
  max_file_bytes: 128 * 1024 * 1024,
  max_unpacked_bytes: 256 * 1024 * 1024,
});

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const size = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const staticArchiveResponseSchema = z.object({
  protocol: z.literal(STATIC_ARCHIVE_PROTOCOL),
  status: z.literal("complete"),
  mode: z.literal("extract"),
  source: z.object({ sha256: digest, bytes: size }),
  analyzer: z.object({
    package: z.literal("binary-refinery"),
    version: z.literal("0.11.2"),
  }),
  limits: z.strictObject({
    max_entries: z.literal(STATIC_ARCHIVE_LIMITS.max_entries),
    max_file_bytes: z.literal(STATIC_ARCHIVE_LIMITS.max_file_bytes),
    max_unpacked_bytes: z.literal(STATIC_ARCHIVE_LIMITS.max_unpacked_bytes),
  }),
  metadata: z.object({
    profile: z.enum([
      "inno7.0.0.3u-revision2-stored-lzma-v1",
      "7z0.4-copy-lzma-lzma2-bcjx86-v1",
    ]),
    members: z
      .array(
        z.object({
          ordinal: z
            .number()
            .int()
            .min(0)
            .max(STATIC_ARCHIVE_LIMITS.max_entries - 1),
          raw_name: z.string().min(1),
          kind: z.enum(["file", "directory"]),
          declared_bytes: size.max(STATIC_ARCHIVE_LIMITS.max_unpacked_bytes),
          encrypted: z.literal(false),
          observed_sha256: digest.nullable(),
          opaque_payload: z.string().optional(),
          observed_bytes: size.optional(),
        }),
      )
      .max(STATIC_ARCHIVE_LIMITS.max_entries),
  }),
  decoded_budget: z.object({
    used: size.max(STATIC_ARCHIVE_LIMITS.max_unpacked_bytes),
  }),
  target_executed: z.literal(false),
  script_emulated: z.literal(false),
  password_guessing: z.literal(false),
});

export type StaticArchiveResponse = z.infer<typeof staticArchiveResponseSchema>;
