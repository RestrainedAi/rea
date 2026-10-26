import { win32 } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import * as loader from "./WindowsNativeLoader.js";
import type { WindowsNativeAuthority } from "./WindowsNativeLoader.js";
import { WindowsImmutableFileAdmissionFailure } from "./WindowsImmutableFile.js";
import { WindowsPrivateRuntime } from "./WindowsPrivateRuntime.js";

afterEach(() => vi.restoreAllMocks());

const runtimePath = "D:\\fixtures\\private-runtime";
const coordinate = "payloads/00000001.bin";
const identity = {
  requestedPath: runtimePath,
  finalPath: `\\\\?\\${runtimePath}`,
  filesystem: "NTFS" as const,
  volumeSerial: "0".repeat(16),
  fileId: "a".repeat(32),
  size: 0,
  directory: true,
};
const nativeRuntime = (
  options: {
    readonly metadata?: Readonly<Record<string, unknown>>;
    readonly failure?: Error;
  } = {},
) => {
  const rootHandle = {};
  const fileHandle = {};
  const bytes = Buffer.from("private Python output\n");
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
      if (operation === "runtime_create")
        return {
          ...identity,
          path: runtimePath,
          handle: rootHandle,
          privateDacl: true,
        };
      if (
        operation === "runtime_open_immutable" ||
        operation === "runtime_open"
      ) {
        expect(arguments_[0]).toBe(rootHandle);
        if (options.failure !== undefined) throw options.failure;
        const path = win32.join(runtimePath, String(arguments_[1]));
        return {
          ...identity,
          requestedPath: path,
          finalPath: `\\\\?\\${path}`,
          directory: false,
          size: bytes.length,
          handle: fileHandle,
          ...options.metadata,
        };
      }
      if (operation === "read") {
        expect(arguments_[0]).toBe(fileHandle);
        if (
          typeof arguments_[1] !== "number" ||
          typeof arguments_[2] !== "number"
        )
          throw new Error("Unmodeled native read coordinates");
        return Buffer.from(
          bytes.subarray(arguments_[1], arguments_[1] + arguments_[2]),
        );
      }
      if (operation === "close") {
        expect(arguments_).toEqual([fileHandle]);
        return null;
      }
      if (operation === "runtime_close") {
        expect(arguments_).toEqual([rootHandle]);
        return null;
      }
      throw new Error(`Unmodeled native operation ${operation}`);
    },
  };
  vi.spyOn(loader, "requireWindowsNativeAuthority").mockReturnValue(authority);
  return { bytes, calls, rootHandle, fileHandle };
};

describe("private runtime immutable output admission", () => {
  it("uses its retained native runtime authority without a generic parent-path reopen", async () => {
    const fixture = nativeRuntime();
    const runtime = WindowsPrivateRuntime.create("D:\\fixtures", "fixture-");
    try {
      const file = runtime.openImmutableFile(coordinate);
      try {
        expect(file.path).toBe(win32.join(runtimePath, coordinate));
        expect(file.read(0, file.size)).toEqual(fixture.bytes);
        expect(fixture.calls[1]).toEqual({
          operation: "runtime_open_immutable",
          arguments_: [fixture.rootHandle, coordinate],
        });
        expect(loader.requireWindowsNativeAuthority).toHaveBeenCalledTimes(1);
      } finally {
        await file.close();
      }
    } finally {
      await runtime.close();
    }
    expect(fixture.calls.map((call) => call.operation)).toEqual([
      "runtime_create",
      "runtime_open_immutable",
      "read",
      "close",
      "runtime_close",
    ]);
  });

  it("retains cleanup-only ownership when runtime-opened metadata fails validation", async () => {
    const fixture = nativeRuntime({ metadata: { size: -1 } });
    const runtime = WindowsPrivateRuntime.create("D:\\fixtures", "fixture-");
    try {
      let failure: WindowsImmutableFileAdmissionFailure;
      try {
        runtime.openImmutableFile(coordinate);
        throw new Error("Expected immutable output admission failure");
      } catch (cause) {
        if (!(cause instanceof WindowsImmutableFileAdmissionFailure))
          throw cause;
        failure = cause;
      }
      expect(failure.path).toBe(win32.join(runtimePath, coordinate));
      expect(fixture.calls.map((call) => call.operation)).toEqual([
        "runtime_create",
        "runtime_open_immutable",
      ]);
      await failure.owner.close();
      expect(fixture.calls.at(-1)).toEqual({
        operation: "close",
        arguments_: [fixture.fileHandle],
      });
    } finally {
      await runtime.close();
    }
  });

  it("keeps native runtime refusal separate from post-acquisition metadata failure", async () => {
    const failure = new Error(
      "Probe: native runtime refused a non-private or reparse output",
    );
    const fixture = nativeRuntime({ failure });
    const runtime = WindowsPrivateRuntime.create("D:\\fixtures", "fixture-");
    try {
      expect(() => runtime.openImmutableFile(coordinate)).toThrow(failure);
      expect(fixture.calls.map((call) => call.operation)).toEqual([
        "runtime_create",
        "runtime_open_immutable",
      ]);
    } finally {
      await runtime.close();
    }
  });

  it("preserves runtime_open for native-written endpoints and rejects invalid or closed immutable opens", async () => {
    const fixture = nativeRuntime();
    const runtime = WindowsPrivateRuntime.create("D:\\fixtures", "fixture-");
    try {
      expect(runtime.readFile("endpoint.json")).toBe(
        fixture.bytes.toString("utf8"),
      );
      expect(fixture.calls[1]?.operation).toBe("runtime_open");
      const count = fixture.calls.length;
      for (const path of ["", "payload\0suffix"])
        expect(() => runtime.openImmutableFile(path)).toThrow("NUL-free");
      expect(fixture.calls).toHaveLength(count);
    } finally {
      await runtime.close();
    }
    expect(() => runtime.openImmutableFile(coordinate)).toThrow(
      "closed or closing",
    );
    expect(fixture.calls.at(-1)?.operation).toBe("runtime_close");
  });
});
