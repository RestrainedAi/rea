import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  writeFile,
  mkdir,
  access,
  rename,
  readdir,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { crc32 } from "node:zlib";
import { palmResourceFixture } from "../../src/native/palm/PalmResources.fixture.ts";
import {
  detectWorkflow,
  summarizeEvidence,
  safeOutputPath,
  WorkbenchEngine,
  withinDirectory,
} from "../engine.mjs";

const appRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const tmp = join(appRoot, "work", "tmp");
const zipFixture = () => {
  const name = Buffer.from("sample.txt");
  const payload = Buffer.from("DATA");
  const crc = crc32(payload);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(payload.length, 18);
  local.writeUInt32LE(payload.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(payload.length, 20);
  central.writeUInt32LE(payload.length, 24);
  central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(local.length + name.length + payload.length, 16);
  return Buffer.concat([local, name, payload, central, name, end]);
};
const fixture = () => {
  const tar = Buffer.alloc(2048);
  tar.write("boot.img");
  tar.write("0000644\0", 100);
  tar.write("0000000\0", 108);
  tar.write("0000000\0", 116);
  tar.write("00000000004\0", 124);
  tar.write("00000000000\0", 136);
  tar.fill(32, 148, 156);
  tar[156] = 48;
  tar.write("ustar\0" + "00", 257);
  let sum = 0;
  for (const n of tar.subarray(0, 512)) sum += n;
  tar.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  tar.write("BOOT", 512);
  return Buffer.concat([
    tar,
    Buffer.from(createHash("md5").update(tar).digest("hex") + " x"),
  ]);
};

test("routes by supported byte signatures and labels extension-only guesses", () => {
  assert.equal(
    detectWorkflow(Buffer.from("377abcaf271c", "hex"), "renamed.bin").kind,
    "artifact",
  );
  assert.equal(
    detectWorkflow(Buffer.from("MZ"), "example.exe").kind,
    "artifact",
  );
  assert.equal(detectWorkflow(fixture(), "renamed.bin").kind, "samsung");
  assert.equal(
    detectWorkflow(Buffer.from("unknown"), "thing.tar.md5").confirmed,
    false,
  );
});
test("an output name cannot escape the selected application output directory", () => {
  assert.equal(
    safeOutputPath("D:/REA/work/outputs", "job"),
    join("D:/REA/work/outputs", "job"),
  );
  for (const bad of [
    "../outside",
    "D:\\elsewhere",
    "..",
    "a/b",
    "a\\b",
    "name:stream",
  ])
    assert.throws(() => safeOutputPath("D:/REA/work/outputs", bad));
  assert.equal(withinDirectory("D:/REA/work", "D:/REA/work/tmp"), true);
  for (const outside of ["C:/outside", "D:/REA/work-other", "D:/REA/setup"])
    assert.equal(withinDirectory("D:/REA/work", outside), false);
});
test("unknown checksums remain unknown rather than verified in a findings summary", () => {
  const s = summarizeEvidence({
    normalized_result: {
      artifact: { bytes: 1, sha256: "a" },
      resources: [
        {
          index: 0,
          type: { value: "code", raw_hex: "636f6465" },
          id: 1,
          payload: { location: { offset: 0, bytes: 1 }, sha256: "b" },
        },
      ],
      limitations: ["Resource bytes only."],
    },
  });
  assert.equal(s.integrity, "recorded");
  assert.equal(s.entries.length, 1);
  assert.ok(s.limitations.length);
});
test("real REA inspection and extraction preserve the source and save durable evidence", async () => {
  const root = await mkdtemp(join(tmp, "rea-gui-test-"));
  const input = join(root, "minimum.bin");
  await writeFile(input, fixture());
  const output = join(root, "outputs");
  await mkdir(output);
  const engine = new WorkbenchEngine({
    appRoot,
    stateRoot: join(root, "state"),
    outputRoot: output,
  });
  try {
    const source = await engine.select(input);
    const inspection = await engine.run(source.id, "inspect");
    assert.equal(inspection.status, "completed");
    assert.equal(inspection.summary.integrity, "match");
    assert.equal(inspection.summary.entries.length, 1);
    const exported = await engine.run(source.id, "extract");
    assert.equal(exported.status, "completed");
    assert.equal(
      (await readFile(join(exported.exportRoot, "boot.img"))).toString(),
      "BOOT",
    );
    assert.ok(exported.evidence.evidence_id);
    await access(exported.reportPath);
    assert.deepEqual(await readFile(input), fixture());
  } finally {
    await engine.close();
  }
});
test("a checksum mismatch blocks extraction and is preserved as a readable failure", async () => {
  const root = await mkdtemp(join(tmp, "rea-gui-refusal-"));
  const input = join(root, "changed.bin");
  const bytes = fixture();
  bytes[512] ^= 1;
  await writeFile(input, bytes);
  const output = join(root, "outputs");
  await mkdir(output);
  const engine = new WorkbenchEngine({
    appRoot,
    stateRoot: join(root, "state"),
    outputRoot: output,
  });
  try {
    const source = await engine.select(input);
    const inspection = await engine.run(source.id, "inspect");
    assert.equal(inspection.summary.integrity, "mismatch");
    const exported = await engine.run(source.id, "extract");
    assert.equal(exported.status, "failed");
    assert.ok(exported.error.message);
    await assert.rejects(access(join(exported.exportRoot, "boot.img")));
  } finally {
    await engine.close();
  }
});

async function context(prefix) {
  const root = await mkdtemp(join(tmp, prefix));
  const input = join(root, "minimum.tar.md5");
  const output = join(root, "outputs");
  await writeFile(input, fixture());
  await mkdir(output);
  const engine = new WorkbenchEngine({
    appRoot,
    stateRoot: join(root, "state"),
    outputRoot: output,
  });
  return { root, input, output, engine };
}

test("a changed selected source is refused before creating an output", async () => {
  const { input, output, engine } = await context("rea-gui-source-change-");
  try {
    const source = await engine.select(input);
    const changed = fixture();
    changed[512] ^= 1;
    await writeFile(input, changed);
    await assert.rejects(engine.run(source.id, "extract"), /source.*changed/i);
    assert.deepEqual(await readdir(output), []);
  } finally {
    await engine.close();
  }
});

test("saved findings remain readable after the original is moved", async () => {
  const { input, root, engine } = await context("rea-gui-history-");
  try {
    const source = await engine.select(input);
    const job = await engine.run(source.id, "inspect");
    await rename(input, join(root, "preserved-original.tar.md5"));
    const restored = await engine.restore(job.id);
    assert.equal(restored.evidence.evidence_id, job.evidence.evidence_id);
    assert.equal(restored.source.available, false);
    await assert.rejects(
      engine.run(restored.source.id, "extract"),
      /choose.*again/i,
    );
  } finally {
    await engine.close();
  }
});

test("a previous unfinished job is labelled interrupted rather than running", async () => {
  const { input, engine } = await context("rea-gui-interrupted-");
  try {
    const source = await engine.select(input);
    await engine.persist({
      version: 1,
      id: randomUUID(),
      source,
      status: "running",
      action: "inspect",
      startedAt: new Date().toISOString(),
    });
    assert.equal((await engine.list())[0].status, "interrupted");
  } finally {
    await engine.close();
  }
});

test("immediate cancellation is retained until the worker acknowledges cleanup", async () => {
  const { input, engine } = await context("rea-gui-cancel-");
  try {
    const source = await engine.select(input);
    engine.once("update", () => engine.cancel());
    const job = await engine.run(source.id, "inspect");
    assert.equal(job.status, "cancelled");
    assert.equal(engine.active, null);
    await access(job.reportPath);
  } finally {
    await engine.close();
  }
});

test("simultaneous requests admit only one owned worker", async () => {
  const { input, engine } = await context("rea-gui-concurrency-");
  try {
    const source = await engine.select(input);
    const results = await Promise.allSettled([
      engine.run(source.id, "inspect"),
      engine.run(source.id, "inspect"),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(results.filter((r) => r.status === "rejected").length, 1);
  } finally {
    await engine.close();
  }
});

test("closing during asynchronous startup still cancels and waits for the owned job", async () => {
  const { input, engine } = await context("rea-gui-startup-close-");
  const source = await engine.select(input);
  const running = engine.run(source.id, "inspect");
  await engine.close();
  const job = await running;
  assert.equal(job.status, "cancelled");
  assert.equal(engine.active, null);
});

test("the Palm bridge retains readable resource types and exports the actual payload", async () => {
  const { input, engine } = await context("rea-gui-palm-");
  const original = palmResourceFixture().bytes;
  await writeFile(input, original);
  try {
    const source = await engine.select(input);
    assert.equal(source.kind, "palm");
    const inspection = await engine.run(source.id, "inspect");
    assert.equal(inspection.status, "completed");
    assert.equal(inspection.summary.entries[3].name, "tAIN / 1000");
    const exported = await engine.run(source.id, "extract");
    assert.equal(exported.status, "completed");
    assert.equal(
      (
        await readFile(
          join(exported.exportRoot, "resources", "00003-7441494e-01000.bin"),
        )
      ).toString(),
      "Fixture\0",
    );
    assert.deepEqual(await readFile(input), original);
  } finally {
    await engine.close();
  }
});

test("the artifact bridge inspects and exports a real ZIP member", async () => {
  const { input, engine } = await context("rea-gui-zip-");
  const original = zipFixture();
  await writeFile(input, original);
  try {
    const source = await engine.select(input);
    const inspection = await engine.run(source.id, "inspect");
    assert.equal(inspection.status, "completed", inspection.error?.message);
    assert.ok(
      inspection.summary.entries.some((entry) => entry.name === "sample.txt"),
    );
    const exported = await engine.run(source.id, "extract");
    assert.equal(exported.status, "completed", exported.error?.message);
    assert.equal(
      (await readFile(join(exported.exportRoot, "sample.txt"))).toString(),
      "DATA",
    );
    assert.deepEqual(await readFile(input), original);
  } finally {
    await engine.close();
  }
});
