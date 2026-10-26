import { afterEach, describe, expect, it, vi } from "vitest";

import * as loader from "./WindowsNativeLoader.js";
import type { WindowsNativeAuthority } from "./WindowsNativeLoader.js";
import {
  WindowsImmutableFile,
  WindowsImmutableFileAdmissionFailure,
} from "./WindowsImmutableFile.js";

afterEach(() => vi.restoreAllMocks());

const path = "D:\\fixtures\\immutable.bin";
const identity = {
  requestedPath: path,
  finalPath: "\\\\?\\D:\\fixtures\\immutable.bin",
  filesystem: "NTFS" as const,
  volumeSerial: "0".repeat(16),
  fileId: "a".repeat(32),
  size: 5,
  directory: false,
};
const nativeFile = (
  options: {
    readonly bytes?: Buffer;
    readonly metadata?: Readonly<Record<string, unknown>>;
    readonly openFailure?: Error;
    readonly read?: (offset: number, length: number) => unknown;
    readonly close?: () => unknown;
  } = {},
) => {
  const bytes = options.bytes ?? Buffer.from([0, 1, 0xff, 0x80, 5]);
  const handle = {};
  const calls: { operation: string; arguments_: readonly unknown[] }[] = [];
  const authority: WindowsNativeAuthority = {
    inspection: {
      abiVersion: 1,
      nodeApiVersion: 8,
      architecture: "x64",
      filesystem: identity,
      privateDacl: true,
      atomicJobAssignment: true,
      killOnOwnerClose: true,
    },
    call: (operation, arguments_) => {
      calls.push({ operation, arguments_ });
      if (operation === "open") {
        expect(arguments_).toEqual([path]);
        if (options.openFailure !== undefined) throw options.openFailure;
        return { ...identity, size: bytes.length, handle, ...options.metadata };
      }
      expect(arguments_[0]).toBe(handle);
      if (operation === "read") {
        const offset = arguments_[1];
        const length = arguments_[2];
        if (typeof offset !== "number" || typeof length !== "number")
          throw new Error("Invalid modeled read coordinates");
        return options.read === undefined
          ? Buffer.from(bytes.subarray(offset, offset + length))
          : options.read(offset, length);
      }
      if (operation === "close")
        return options.close === undefined ? null : options.close();
      throw new Error(`Unmodeled native operation ${operation}`);
    },
  };
  vi.spyOn(loader, "requireWindowsNativeAuthority").mockReturnValue(authority);
  return { bytes, calls, handle, authority };
};

describe("native immutable Windows file leases", () => {
  it("uses only the verified native open/read/close authority and observed file extent", async () => {
    const fixture = nativeFile({ bytes: Buffer.alloc(65537, 0xa5) });
    const file = WindowsImmutableFile.open(path);
    expect(file.path).toBe(path);
    expect(file.size).toBe(fixture.bytes.length);
    expect(file.read(0, 65536)).toEqual(fixture.bytes.subarray(0, 65536));
    expect(file.read(65536, 1)).toEqual(fixture.bytes.subarray(65536));
    expect(file.read(file.size, 0)).toEqual(Buffer.alloc(0));
    await file.close();
    expect(fixture.calls.map((call) => call.operation)).toEqual([
      "open",
      "read",
      "read",
      "read",
      "close",
    ]);
  });

  it.each([
    [-1, 1],
    [0, -1],
    [0, 65537],
    [1.5, 1],
    [0, 1.5],
    [Number.MAX_SAFE_INTEGER + 1, 0],
    [0, Number.NaN],
    [5, 1],
    [6, 0],
  ])(
    "refuses invalid read (%s, %s) before invoking native read",
    async (offset, length) => {
      const fixture = nativeFile();
      const file = WindowsImmutableFile.open(path);
      try {
        expect(() => file.read(offset, length)).toThrow(RangeError);
        expect(fixture.calls).toHaveLength(1);
      } finally {
        await file.close();
      }
    },
  );

  it("shares concurrent close and prohibits reads once closing begins", async () => {
    const fixture = nativeFile();
    const file = WindowsImmutableFile.open(path);
    const first = file.close();
    const second = file.close();
    expect(first).toBe(second);
    expect(() => file.read(0, 1)).toThrow("closed, closing");
    await Promise.all([first, second]);
    await file.close();
    expect(() => file.read(0, 1)).toThrow("closed, closing");
    expect(
      fixture.calls.filter((call) => call.operation === "close"),
    ).toHaveLength(1);
  });

  it("retains an unconfirmed close without invoking native close again", async () => {
    const cause = new Error(
      "Probe: close may have invalidated its native handle",
    );
    const fixture = nativeFile({
      close: () => {
        throw cause;
      },
    });
    const file = WindowsImmutableFile.open(path);
    await expect(file.close()).rejects.toBe(cause);
    await expect(file.close()).rejects.toBe(cause);
    expect(() => file.read(0, 1)).toThrow("unconfirmed cleanup");
    expect(
      fixture.calls.filter((call) => call.operation === "close"),
    ).toHaveLength(1);
  });

  it("treats an invalid close acknowledgement as sticky cleanup uncertainty", async () => {
    const fixture = nativeFile({ close: () => false });
    const file = WindowsImmutableFile.open(path);
    await expect(file.close()).rejects.toThrow("valid confirmation");
    await expect(file.close()).rejects.toThrow("valid confirmation");
    expect(
      fixture.calls.filter((call) => call.operation === "close"),
    ).toHaveLength(1);
  });
});

describe("adopting already-open native immutable file observations", () => {
  it("uses the supplied verified authority and handle without another generic path open", async () => {
    const fixture = nativeFile();
    const file = WindowsImmutableFile.fromNativeObservation(
      path,
      fixture.authority,
      {
        ...identity,
        handle: fixture.handle,
      },
    );
    expect(file.read(1, 3)).toEqual(fixture.bytes.subarray(1, 4));
    await file.close();
    expect(fixture.calls.map((call) => call.operation)).toEqual([
      "read",
      "close",
    ]);
    expect(loader.requireWindowsNativeAuthority).not.toHaveBeenCalled();
  });

  it("retains the acquired handle when the expected path is invalid after acquisition", async () => {
    const fixture = nativeFile();
    let failure: WindowsImmutableFileAdmissionFailure;
    try {
      WindowsImmutableFile.fromNativeObservation(
        "D:\\file\0suffix",
        fixture.authority,
        {
          ...identity,
          handle: fixture.handle,
        },
      );
      throw new Error("Expected post-acquisition admission failure");
    } catch (cause) {
      if (!(cause instanceof WindowsImmutableFileAdmissionFailure)) throw cause;
      failure = cause;
    }
    expect(failure.cause).toBeInstanceOf(TypeError);
    expect(fixture.calls).toEqual([]);
    await failure.owner.close();
    expect(fixture.calls.map((call) => call.operation)).toEqual(["close"]);
  });
});

describe("native immutable file admission and read failures", () => {
  it.each([
    { filesystem: "exFAT" },
    { directory: true },
    { size: Number.MAX_SAFE_INTEGER + 1 },
    { fileId: "invalid" },
    { requestedPath: "D:\\another.bin" },
    { finalPath: "" },
  ])(
    "retains acquired handles when identity validation fails: %j",
    async (metadata) => {
      const fixture = nativeFile({ metadata });
      let failure: WindowsImmutableFileAdmissionFailure;
      try {
        WindowsImmutableFile.open(path);
        throw new Error("Expected admission failure");
      } catch (cause) {
        if (!(cause instanceof WindowsImmutableFileAdmissionFailure))
          throw cause;
        failure = cause;
      }
      expect(failure.path).toBe(path);
      expect(failure.cause).toBeInstanceOf(Error);
      expect(fixture.calls.map((call) => call.operation)).toEqual(["open"]);
      await failure.owner.close();
      expect(fixture.calls.at(-1)).toEqual({
        operation: "close",
        arguments_: [fixture.handle],
      });
    },
  );

  it("keeps invalid-metadata admission owners reachable after their close fails", async () => {
    const closeFailure = new Error("Probe: unconfirmed admission lease close");
    const fixture = nativeFile({
      metadata: { size: -1 },
      close: () => {
        throw closeFailure;
      },
    });
    let failure: WindowsImmutableFileAdmissionFailure;
    try {
      WindowsImmutableFile.open(path);
      throw new Error("Expected admission failure");
    } catch (cause) {
      if (!(cause instanceof WindowsImmutableFileAdmissionFailure)) throw cause;
      failure = cause;
    }
    await expect(failure.owner.close()).rejects.toBe(closeFailure);
    await expect(failure.owner.close()).rejects.toBe(closeFailure);
    expect(
      fixture.calls.filter((call) => call.operation === "close"),
    ).toHaveLength(1);
  });

  it("does not invent an owner when native open fails before returning a handle", () => {
    const openFailure = new Error(
      "Probe: reparse component was refused by native open",
    );
    const fixture = nativeFile({ openFailure });
    expect(() => WindowsImmutableFile.open(path)).toThrow(openFailure);
    expect(fixture.calls.map((call) => call.operation)).toEqual(["open"]);
  });

  it("rejects invalid path text before loading native authority", () => {
    const authority = vi.spyOn(loader, "requireWindowsNativeAuthority");
    for (const value of ["", "D:\\file\0suffix"])
      expect(() => WindowsImmutableFile.open(value)).toThrow("NUL-free");
    expect(authority).not.toHaveBeenCalled();
  });

  it.each([Buffer.alloc(0), Buffer.alloc(2), new Uint8Array([1]), null])(
    "refuses malformed or short native read results while retaining cleanup ownership: %j",
    async (value) => {
      const fixture = nativeFile({ read: () => value });
      const file = WindowsImmutableFile.open(path);
      try {
        expect(() => file.read(0, 1)).toThrow("exact requested bytes");
      } finally {
        await file.close();
      }
      expect(fixture.calls.at(-1)?.operation).toBe("close");
    },
  );
});
