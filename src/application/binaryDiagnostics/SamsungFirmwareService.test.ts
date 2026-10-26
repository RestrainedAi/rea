import { describe, expect, it, vi } from "vitest";
import { SAMSUNG_FIRMWARE_PROVIDER } from "../InvestigationProviders.js";
import type { SamsungFirmwarePort } from "./SamsungFirmwarePort.js";
import { ok } from "../../domain/result.js";
import type {
  SamsungFirmware,
  SamsungFirmwareExtraction,
} from "../../domain/firmware/samsungFirmware.js";
import { SamsungFirmwareService } from "./SamsungFirmwareService.js";

const reportFixture = (): SamsungFirmware => {
  const footer = `${"a".repeat(32)}  example.tar\n`;
  return {
    artifact: {
      path: "/fixtures/example.tar.md5",
      bytes: 2048 + footer.length,
      sha256: "c".repeat(64),
    },
    format: "samsung-tar-md5",
    tar_location: { offset: 0, bytes: 2048 },
    zero_terminator: { offset: 1024, bytes: 1024 },
    padding_location: { offset: 2048, bytes: 0 },
    footer: {
      location: { offset: 2048, bytes: footer.length },
      raw_hex: Buffer.from(footer).toString("hex"),
      text: footer,
      declared_tar_bytes: 2048,
      checksum_record_location: { offset: 2048, bytes: footer.length },
      checksum_filename: "example.tar",
    },
    integrity: {
      algorithm: "md5",
      checksum_range: { offset: 0, bytes: 2048 },
      declared_md5: "a".repeat(32),
      calculated_md5: "a".repeat(32),
      status: "match",
    },
    entries: [
      {
        index: 0,
        path: "boot.img",
        name_raw_hex: "00".repeat(100),
        prefix_raw_hex: "00".repeat(155),
        header_format: "ustar",
        kind: "file",
        typeflag: 48,
        header: {
          location: { offset: 0, bytes: 512 },
          raw_hex: "00".repeat(512),
          sha256: "d".repeat(64),
          declared_checksum: 1,
          calculated_checksum: 1,
        },
        payload: {
          location: { offset: 512, bytes: 1 },
          sha256: "e".repeat(64),
        },
        padding_location: { offset: 513, bytes: 511 },
      },
    ],
    coverage: {
      status: "complete-within-profile",
      headers: 1,
      files: 1,
      source_bytes_hashed: 2048 + footer.length,
    },
    limitations: ["Synthetic port report; no execution."],
  };
};
const extractionFixture = (
  inventory: SamsungFirmware,
): SamsungFirmwareExtraction => ({
  inventory,
  output_root: "/fixtures/export",
  manifest_relative_path: "manifest.json",
  footer_relative_path: "__samsung_footer.bin",
  files: [
    {
      entry_index: 0,
      relative_path: "boot.img",
      bytes_written: 1,
      sha256: "e".repeat(64),
    },
  ],
});
const recordingService = (
  report = reportFixture(),
  extraction = extractionFixture(report),
) => {
  const provider: SamsungFirmwarePort = {
    identity: SAMSUNG_FIRMWARE_PROVIDER,
    inspect: vi.fn(async () => ok(report)),
    extract: vi.fn(async () => ok(extraction)),
    close: vi.fn(async () => {}),
  };
  return { provider, service: new SamsungFirmwareService(provider) };
};

describe("Samsung firmware Evidence boundary", () => {
  it("accepts the parser floor of one space, one filename byte, and no newline", async () => {
    const footer = `${"a".repeat(32)} x`;
    const report = reportFixture();
    report.artifact.bytes = 2048 + footer.length;
    report.coverage.source_bytes_hashed = report.artifact.bytes;
    report.footer = {
      location: { offset: 2048, bytes: footer.length },
      raw_hex: Buffer.from(footer).toString("hex"),
      text: footer,
      declared_tar_bytes: 2048,
      checksum_record_location: { offset: 2048, bytes: footer.length },
      checksum_filename: "x",
    };
    const result = await recordingService(report).service.inspect({
      path: report.artifact.path,
    });
    expect(result).toMatchObject({ ok: true });
  });
  it("preserves source identity and MD5 mismatch as observed evidence", async () => {
    const report = reportFixture();
    report.integrity.status = "mismatch";
    report.integrity.calculated_md5 = "b".repeat(32);
    const { service } = recordingService(report);
    const result = await service.inspect({ path: report.artifact.path });
    if (!result.ok) throw result.error;
    expect(result.value).toMatchObject({
      operation: "inspect_samsung_firmware",
      confidence: "observed",
      subject: {
        format: "samsung-tar-md5",
        digest: { sha256: report.artifact.sha256 },
      },
      normalized_result: report,
    });
  });
  it.each([
    [
      "source path",
      (r: SamsungFirmware) => {
        r.artifact.path = "/another.tar.md5";
      },
    ],
    [
      "source count",
      (r: SamsungFirmware) => {
        r.coverage.source_bytes_hashed--;
      },
    ],
    [
      "header count",
      (r: SamsungFirmware) => {
        r.coverage.headers++;
      },
    ],
    [
      "payload overlap",
      (r: SamsungFirmware) => {
        r.entries[0]!.payload.location.offset--;
      },
    ],
    [
      "padding gap",
      (r: SamsungFirmware) => {
        r.entries[0]!.padding_location.bytes--;
      },
    ],
    [
      "terminator gap",
      (r: SamsungFirmware) => {
        r.zero_terminator.offset++;
      },
    ],
    [
      "footer extent",
      (r: SamsungFirmware) => {
        r.footer.location.bytes++;
      },
    ],
    [
      "hash extent",
      (r: SamsungFirmware) => {
        r.integrity.checksum_range.bytes--;
      },
    ],
    [
      "MD5 status",
      (r: SamsungFirmware) => {
        r.integrity.status = "mismatch";
      },
    ],
    [
      "directory data",
      (r: SamsungFirmware) => {
        r.entries[0]!.kind = "directory";
        r.entries[0]!.typeflag = 53;
        r.coverage.files = 0;
      },
    ],
  ] as const)(
    "rejects a malformed provider report: %s",
    async (_name, mutate) => {
      const report = reportFixture();
      mutate(report);
      expect(
        await recordingService(report).service.inspect({
          path: "/fixtures/example.tar.md5",
        }),
      ).toMatchObject({ ok: false, error: { _tag: "AnalysisOutputError" } });
    },
  );
});

describe("Samsung firmware extraction Evidence and caller validation", () => {
  it("validates file-to-inventory correspondence before extraction Evidence", async () => {
    const report = reportFixture();
    const extraction = extractionFixture(report);
    const valid = await recordingService(report, extraction).service.extract({
      path: report.artifact.path,
      output_root: extraction.output_root,
    });
    if (!valid.ok) throw valid.error;
    expect(valid.value).toMatchObject({
      operation: "extract_samsung_firmware",
      normalized_result: extraction,
    });
    extraction.files[0]!.sha256 = "f".repeat(64);
    expect(
      await recordingService(report, extraction).service.extract({
        path: report.artifact.path,
        output_root: extraction.output_root,
      }),
    ).toMatchObject({ ok: false, error: { _tag: "AnalysisOutputError" } });
  });
  it("refuses extraction success claims for a mismatched inventory", async () => {
    const report = reportFixture();
    report.integrity.status = "mismatch";
    report.integrity.calculated_md5 = "b".repeat(32);
    expect(
      await recordingService(report).service.extract({
        path: report.artifact.path,
        output_root: "/fixtures/export",
      }),
    ).toMatchObject({ ok: false, error: { _tag: "AnalysisOutputError" } });
  });
  it("rejects relative paths, unknown fields and cancellation before provider access", async () => {
    const { service, provider } = recordingService();
    expect(await service.inspect({ path: "relative.tar.md5" })).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisInputError" },
    });
    expect(
      await service.inspect({ path: "/file.tar.md5", execute: true }),
    ).toMatchObject({ ok: false, error: { _tag: "AnalysisInputError" } });
    expect(
      await service.extract({ path: "/file.tar.md5", output_root: "relative" }),
    ).toMatchObject({ ok: false, error: { _tag: "AnalysisInputError" } });
    expect(
      await service.inspect(
        { path: "/file.tar.md5" },
        { signal: AbortSignal.abort() },
      ),
    ).toMatchObject({ ok: false, error: { _tag: "AnalysisCancelledError" } });
    expect(provider.inspect).not.toHaveBeenCalled();
    expect(provider.extract).not.toHaveBeenCalled();
  });
  it("rejects oversized complete metadata before creating Evidence", async () => {
    const report = reportFixture();
    report.limitations = ["x".repeat(8 * 1024 * 1024)];
    expect(
      await recordingService(report).service.inspect({
        path: report.artifact.path,
      }),
    ).toMatchObject({ ok: false, error: { _tag: "AnalysisOutputError" } });
  });
});
