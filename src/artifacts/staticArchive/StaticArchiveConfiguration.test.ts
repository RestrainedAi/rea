import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import {
  hashStaticArchiveHandle,
  pinStaticArchiveInstallation,
  type StaticArchiveToolPin,
} from "./StaticArchiveConfiguration.js";

const hash = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");
const required = [
  "python/python.exe",
  "python/python314._pth",
  "python/python314.zip",
  "python/python314.dll",
  "source/rea_bridge/strict_static_archive_bridge.py",
];
const installation = async () => {
  const root = await createTestTempDirectory(
    "rea-static-archive-installation-",
  );
  const files = [];
  for (const path of required) {
    const destination = join(root, ...path.split("/"));
    await mkdir(join(destination, ".."), { recursive: true });
    const bytes = Buffer.from(`Inert test data for ${path}`);
    await writeFile(destination, bytes);
    files.push({ path, bytes: bytes.length, sha256: hash(bytes) });
  }
  const manifest = {
    protocol: "rea.static-archive-installation/1",
    root,
    python: "python/python.exe",
    bridge: "source/rea_bridge/strict_static_archive_bridge.py",
    python_version: "3.14.10",
    backend_version: "0.11.2",
    backend_repository: "https://github.com/RestrainedAi/rea-binary-refinery",
    backend_revision: "1".repeat(40),
    files,
  };
  const path = join(root, "manifest.json");
  await writeFile(path, JSON.stringify(manifest));
  return { root, path, manifest };
};
const closePins = async (pins: readonly StaticArchiveToolPin[]) => {
  await Promise.all(pins.map(({ owner }) => owner.close()));
};

describe.skipIf(process.platform !== "win32")(
  "pinned static archive installation admission",
  () => {
    it("retains the manifest and all admitted tool files, and hashes without consuming their positions", async () => {
      const { path, manifest } = await installation();
      const pins: StaticArchiveToolPin[] = [];
      try {
        const selected = await pinStaticArchiveInstallation(path, pins);
        expect(pins).toHaveLength(required.length + 1);
        expect(selected.executableSha256).toBe(manifest.files[0]!.sha256);
        const pin = pins[1]!;
        expect(await hashStaticArchiveHandle(pin.file!)).toBe(
          manifest.files[0]!.sha256,
        );
        expect(pin.file!.read(0, pin.file!.size)).toEqual(
          await readFile(pin.path),
        );
      } finally {
        await closePins(pins);
      }
    });

    it("refuses analyzer tampering while keeping every acquired owner available to cleanup", async () => {
      const { path, root } = await installation();
      await writeFile(join(root, "python", "python.exe"), "tampered");
      const pins: StaticArchiveToolPin[] = [];
      try {
        await expect(
          pinStaticArchiveInstallation(path, pins),
        ).rejects.toMatchObject({ reason: "integrity" });
        expect(pins).toHaveLength(2);
      } finally {
        await closePins(pins);
      }
    });

    it("denies concurrent writes while admitted analyzer leases are held and releases the lock on close", async () => {
      const { path, root } = await installation();
      const selected = join(root, "python", "python.exe");
      const before = await readFile(selected);
      const pins: StaticArchiveToolPin[] = [];
      try {
        await pinStaticArchiveInstallation(path, pins);
        await expect(
          writeFile(selected, "concurrent replacement"),
        ).rejects.toThrow();
        expect(await readFile(selected)).toEqual(before);
      } finally {
        await closePins(pins);
      }
      await writeFile(selected, "released test file");
      expect(await readFile(selected, "utf8")).toBe("released test file");
    });

    it("refuses an oversized declared analyzer set before admitting any member file", async () => {
      const { path, manifest } = await installation();
      manifest.files = Array.from({ length: 5 }, (_, index) => ({
        path: `unused/${index}.bin`,
        bytes: 64 * 1024 * 1024,
        sha256: hash(""),
      }));
      await writeFile(path, JSON.stringify(manifest));
      const pins: StaticArchiveToolPin[] = [];
      try {
        await expect(
          pinStaticArchiveInstallation(path, pins),
        ).rejects.toMatchObject({
          reason: "limit",
          message: expect.stringContaining("aggregate"),
        });
        expect(pins).toHaveLength(1);
      } finally {
        await closePins(pins);
      }
    });

    it.each([
      "../escape.py",
      "source/../escape.py",
      "source\\escape.py",
      "C:/escape.py",
      "source/file:ads",
      "source//escape.py",
    ])("refuses unsafe analyzer pin %s", async (unsafe) => {
      const { path, manifest } = await installation();
      manifest.files.unshift({ path: unsafe, bytes: 0, sha256: hash("") });
      await writeFile(path, JSON.stringify(manifest));
      const pins: StaticArchiveToolPin[] = [];
      try {
        await expect(
          pinStaticArchiveInstallation(path, pins),
        ).rejects.toMatchObject({ reason: "path" });
        expect(pins).toHaveLength(1);
      } finally {
        await closePins(pins);
      }
    });

    it("refuses case-folded duplicate pins and missing mandatory interpreter files", async () => {
      const { path, manifest } = await installation();
      const pins: StaticArchiveToolPin[] = [];
      try {
        manifest.files.push({
          ...manifest.files[0]!,
          path: "PYTHON/python.exe",
        });
        await writeFile(path, JSON.stringify(manifest));
        await expect(
          pinStaticArchiveInstallation(path, pins),
        ).rejects.toMatchObject({ reason: "path" });
      } finally {
        await closePins(pins);
      }
      const missing = await installation();
      missing.manifest.files = missing.manifest.files.filter(
        ({ path }) => path !== "python/python314.dll",
      );
      await writeFile(missing.path, JSON.stringify(missing.manifest));
      const retained: StaticArchiveToolPin[] = [];
      try {
        await expect(
          pinStaticArchiveInstallation(missing.path, retained),
        ).rejects.toMatchObject({
          reason: "format",
          message: expect.stringContaining("python314.dll"),
        });
      } finally {
        await closePins(retained);
      }
    });

    it("refuses an oversized manifest before JSON parsing and respects pre-admission cancellation", async () => {
      const { path } = await installation();
      await writeFile(path, Buffer.alloc(4 * 1024 * 1024 + 1));
      const pins: StaticArchiveToolPin[] = [];
      try {
        await expect(
          pinStaticArchiveInstallation(path, pins),
        ).rejects.toMatchObject({ reason: "limit" });
      } finally {
        await closePins(pins);
      }
      const cancelled: StaticArchiveToolPin[] = [];
      const controller = new AbortController();
      controller.abort();
      await expect(
        pinStaticArchiveInstallation(path, cancelled, controller.signal),
      ).rejects.toThrow();
      expect(cancelled).toHaveLength(0);
    });
  },
);
