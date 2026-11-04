import { EventEmitter } from "node:events";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

export function detectWorkflow(bytes, name = "") {
  if (bytes.subarray(257, 262).toString() === "ustar")
    return {
      kind: "samsung",
      format: "Samsung TAR.MD5 package",
      confirmed: true,
    };
  if (bytes.subarray(0, 6).equals(Buffer.from("377abcaf271c", "hex")))
    return { kind: "artifact", format: "7z archive", confirmed: true };
  if (bytes.subarray(0, 2).toString() === "MZ")
    return {
      kind: "artifact",
      format: "Windows executable / installer",
      confirmed: true,
    };
  if (bytes.subarray(0, 2).toString() === "PK")
    return {
      kind: "artifact",
      format: "ZIP / application package",
      confirmed: true,
    };
  if (
    bytes.length >= 78 &&
    bytes.readUInt16BE(32) & 1 &&
    bytes.subarray(60, 64).toString() === "appl"
  )
    return {
      kind: "palm",
      format: "Palm OS resource database",
      confirmed: true,
    };
  if (/\.tar\.md5$/i.test(name))
    return {
      kind: "samsung",
      format: "Samsung package (validate on inspection)",
      confirmed: false,
    };
  if (/\.prc$/i.test(name))
    return {
      kind: "palm",
      format: "Palm resource database (validate on inspection)",
      confirmed: false,
    };
  return {
    kind: "artifact",
    format: "File / container (validate on inspection)",
    confirmed: false,
  };
}

export function safeOutputPath(parent, name) {
  if (
    typeof name !== "string" ||
    !name ||
    name === "." ||
    name === ".." ||
    /[<>:"/\\|?*\x00-\x1f]/u.test(name) ||
    /[. ]$/u.test(name)
  )
    throw new Error(
      "Use a folder name without slashes, dots at the end, or reserved characters.",
    );
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name))
    throw new Error("That folder name is reserved by Windows.");
  const full = resolve(parent, name);
  if (dirname(full) !== resolve(parent))
    throw new Error("The destination must stay inside the output folder.");
  return full;
}

export async function checkedDirectory(path) {
  const full = resolve(path);
  let current = full;
  while (true) {
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error(
        "Output folders must be real directories, without symbolic links or junctions.",
      );
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return full;
}

export function withinDirectory(root, path) {
  const part = relative(resolve(root), resolve(path));
  return part !== ".." && !part.startsWith(".." + sep) && !isAbsolute(part);
}

const identityOf = (info) =>
  Object.fromEntries(
    ["dev", "ino", "size", "mtimeNs", "ctimeNs"].map((key) => [
      key,
      info[key].toString(),
    ]),
  );
const sameIdentity = (a, b) =>
  a &&
  b &&
  ["dev", "ino", "size", "mtimeNs", "ctimeNs"].every(
    (key) => a[key] === b[key],
  );

export function summarizeEvidence(evidence) {
  const n = evidence?.normalized_result ?? {};
  const inventory =
    n.inventory ??
    n.substeps?.find((s) => s.operation === "inventory_artifact")?.evidence
      ?.normalized_result ??
    n;
  let entries = [];
  if (Array.isArray(inventory.entries))
    entries = inventory.entries
      .filter((e) => e.kind === "file")
      .map((e) => ({
        name: e.path,
        bytes: e.payload.location.bytes,
        sha256: e.payload.sha256,
        offset: e.payload.location.offset,
        kind: "Raw image",
      }));
  else if (Array.isArray(inventory.resources))
    entries = inventory.resources.map((e) => ({
      name: `${e.type.value ?? e.type.raw_hex} / ${e.id}`,
      bytes: e.payload.location.bytes,
      sha256: e.payload.sha256,
      offset: e.payload.location.offset,
      text: e.text?.value ?? null,
      kind: e.classification ?? "Resource",
    }));
  else if (Array.isArray(inventory.occurrences)) {
    const nodes = new Map(
      (inventory.nodes ?? []).map((n) => [n.artifact_id, n]),
    );
    entries = inventory.occurrences
      .filter((e) => e.entry_kind === "file" && e.logical_path !== ".")
      .map((e) => ({
        name: e.logical_path,
        bytes: nodes.get(e.artifact_id)?.size ?? e.declared_size,
        sha256: nodes.get(e.artifact_id)?.sha256 ?? null,
        offset: e.source_location?.offset ?? null,
        kind: e.artifact_kind,
      }));
  }
  return {
    format:
      inventory.format ??
      inventory.manifest?.root_format ??
      n.subject?.root_format ??
      "REA analysis",
    integrity:
      inventory.integrity?.status ??
      ((inventory.integrity_contradictions?.length ?? 0) > 0
        ? "mismatch"
        : "recorded"),
    sha256:
      inventory.artifact?.sha256 ?? inventory.manifest?.root_sha256 ?? null,
    bytes: inventory.artifact?.bytes ?? null,
    entries,
    limitations: [
      ...new Set([
        ...(evidence?.limitations ?? []),
        ...(n.limitations ?? []),
        ...(inventory.limitations ?? []),
      ]),
    ],
    evidenceId: evidence?.evidence_id ?? null,
  };
}

export class WorkbenchEngine extends EventEmitter {
  constructor({
    appRoot = resolve(fileURLToPath(new URL("../..", import.meta.url))),
    stateRoot,
    outputRoot,
  } = {}) {
    super();
    this.appRoot = resolve(appRoot);
    this.outputRoot = resolve(
      outputRoot ?? join(this.appRoot, "work", "outputs"),
    );
    this.stateRoot = resolve(
      stateRoot ?? join(this.appRoot, "work", "desktop"),
    );
    this.sources = new Map();
    this.jobs = new Map();
    this.active = null;
    this.lastError = null;
  }
  async ready() {
    await mkdir(join(this.stateRoot, "jobs"), { recursive: true });
    await mkdir(this.outputRoot, { recursive: true });
    await checkedDirectory(this.outputRoot);
  }
  async select(input) {
    if (typeof input !== "string" || !isAbsolute(input) || input.includes("\0"))
      throw new Error("Choose an absolute file or folder path.");
    const path = await realpath(input);
    const info = await stat(path, { bigint: true });
    let workflow;
    if (info.isDirectory())
      workflow = {
        kind: "artifact",
        format: "Application folder",
        confirmed: true,
      };
    else {
      if (!info.isFile())
        throw new Error("Choose a regular file or application folder.");
      const h = await open(path, "r");
      try {
        const b = Buffer.alloc(512);
        const { bytesRead } = await h.read(b, 0, 512, 0);
        workflow = detectWorkflow(b.subarray(0, bytesRead), path);
      } finally {
        await h.close();
      }
    }
    const source = {
      id: randomUUID(),
      path,
      name: basename(path),
      bytes: info.isDirectory() ? null : Number(info.size),
      isDirectory: info.isDirectory(),
      modifiedMs: Number(info.mtimeMs),
      identity: identityOf(info),
      available: true,
      ...workflow,
    };
    this.sources.set(source.id, source);
    return source;
  }
  async persist(job) {
    await this.ready();
    const file = join(this.stateRoot, "jobs", job.id + ".json");
    const tmp = file + "." + randomUUID() + ".tmp";
    await writeFile(tmp, JSON.stringify(job, null, 2) + "\n", { flag: "wx" });
    await rename(tmp, file);
  }
  async list() {
    await this.ready();
    const all = [];
    for (const name of await readdir(join(this.stateRoot, "jobs"))) {
      if (!/^[a-f0-9-]+\.json$/u.test(name)) continue;
      try {
        const j = JSON.parse(
          await readFile(join(this.stateRoot, "jobs", name), "utf8"),
        );
        if (j.version === 1 && typeof j.id === "string") {
          if (
            ["running", "cancelling"].includes(j.status) &&
            j.id !== this.active?.id
          ) {
            j.status = "interrupted";
            j.error = {
              code: "interrupted_session",
              message:
                "The earlier session ended before a verified completion was recorded. Saved observations and outputs are retained.",
            };
          }
          all.push(j);
        }
      } catch {
        /* A damaged record does not replace successfully loaded jobs. */
      }
    }
    return all.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }
  async restore(id) {
    const job = (await this.list()).find((j) => j.id === id);
    if (!job) throw new Error("That project record is unavailable.");
    try {
      const current = await this.select(job.source.path);
      if (sameIdentity(current.identity, job.source.identity))
        return {
          ...job,
          source: { ...job.source, id: current.id, available: true },
        };
      this.sources.delete(current.id);
    } catch {
      /* Historical evidence remains useful without the original source. */
    }
    return {
      ...job,
      source: {
        ...job.source,
        id: randomUUID(),
        available: false,
        availabilityIssue:
          "The original is unavailable, changed, or has no saved identity. These are historical findings. Choose the source again for a new analysis.",
      },
    };
  }
  async run(sourceId, action, { folderName } = {}) {
    if (this.active)
      throw new Error(
        "One analysis is already running. Wait for it or cancel it first.",
      );
    const source = this.sources.get(sourceId);
    if (!source) throw new Error("Choose the source file again.");
    if (!["inspect", "extract", "native"].includes(action))
      throw new Error("Unsupported analysis action.");
    if (
      action === "native" &&
      (!source.name.match(/\.(exe|dll)$/i) || source.isDirectory)
    )
      throw new Error("Native analysis requires a Windows EXE or DLL.");
    let resolveDone;
    const done = new Promise((resolve) => {
      resolveDone = resolve;
    });
    const active = {
      id: randomUUID(),
      child: null,
      job: null,
      done,
      cancelRequested: false,
    };
    this.active = active;
    try {
      let current;
      try {
        current = identityOf(await stat(source.path, { bigint: true }));
      } catch {
        current = null;
      }
      if (!sameIdentity(source.identity, current))
        throw new Error(
          "The selected source changed or moved. Choose it again and inspect the current contents.",
        );
      await this.ready();
      const id = active.id;
      const safeName =
        source.name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48) || "analysis";
      const name =
        folderName ??
        `${safeName}-${new Date().toISOString().slice(0, 10)}-${id.slice(0, 8)}`;
      const outputRoot = safeOutputPath(this.outputRoot, name);
      await checkedDirectory(this.outputRoot);
      await mkdir(outputRoot);
      const job = {
        version: 1,
        id,
        source,
        action,
        status: "running",
        startedAt: new Date().toISOString(),
        outputRoot,
        exportRoot: join(outputRoot, "files"),
        reportPath: join(outputRoot, "report.json"),
        phase: "Starting REA",
        evidence: null,
        summary: null,
        error: null,
      };
      active.job = job;
      await this.persist(job);
      const worker = join(
        dirname(fileURLToPath(import.meta.url)),
        "worker.mjs",
      );
      const env = {
        SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
        WINDIR: process.env.WINDIR ?? "C:\\Windows",
        PATH:
          join(this.appRoot, "tools", "node-v24.18.0-win-x64") +
          ";" +
          (process.env.PATH ?? ""),
        TEMP: join(this.appRoot, "work", "tmp"),
        TMP: join(this.appRoot, "work", "tmp"),
        GHIDRA_INSTALL_DIR: join(this.appRoot, "tools", "ghidra_12.1.4_PUBLIC"),
        JAVA_HOME: join(this.appRoot, "tools", "java"),
        REA_STATIC_ARCHIVE_MANIFEST: join(
          this.appRoot,
          "tools",
          "static-archives",
          "manifest.json",
        ),
        REA_ANALYSIS_PROVIDER: "ghidra",
        REA_LOG_LEVEL: "silent",
        REA_GHIDRA_STARTUP_TIMEOUT_MS: "330000",
      };
      // Evidence is JSON. V8's binary clone wire version differs between Electron and portable Node.
      const child = fork(worker, [], {
        execPath: join(
          this.appRoot,
          "tools",
          "node-v24.18.0-win-x64",
          "node.exe",
        ),
        cwd: join(this.appRoot, "source"),
        env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        serialization: "json",
      });
      let stderr = "";
      child.stderr.on("data", (b) => {
        stderr = (stderr + b.toString()).slice(-16000);
      });
      child.stdout.on("data", () => {});
      active.child = child;
      this.emit("update", job);
      return new Promise((resolveJob) => {
        let settled = false;
        let outcome;
        let startError;
        const finish = async (outcome) => {
          if (settled) return;
          settled = true;
          try {
            Object.assign(job, outcome, {
              finishedAt: new Date().toISOString(),
            });
            if (job.evidence) {
              job.summary = summarizeEvidence(job.evidence);
              await writeFile(
                job.reportPath,
                JSON.stringify(job.evidence, null, 2) + "\n",
                { flag: "wx" },
              );
            } else
              await writeFile(
                job.reportPath,
                JSON.stringify(
                  { error: job.error, source: job.source },
                  null,
                  2,
                ) + "\n",
                { flag: "wx" },
              );
            await this.persist(job);
          } catch (error) {
            job.status = "failed";
            job.error = {
              code: "report_write_failed",
              message: error.message,
              analysisOutcome: outcome,
            };
          }
          this.jobs.set(id, job);
          this.active = null;
          this.emit("update", job);
          resolveDone();
          resolveJob(job);
        };
        child.on("message", (message) => {
          if (message.type === "phase") {
            job.phase =
              job.status === "cancelling"
                ? "Waiting for REA cancellation and cleanup"
                : message.phase;
            this.emit("update", job);
          } else if (message.type === "result") outcome = message.outcome;
        });
        child.once("error", (error) => {
          startError = error;
        });
        // Keep ownership until the worker and its output streams have actually closed.
        child.once("close", (code, signal) => {
          void finish(
            outcome ?? {
              status: "failed",
              error: startError
                ? { code: "engine_start_failed", message: startError.message }
                : {
                    code: "engine_exit",
                    message: `REA stopped before returning a result (${code ?? signal}).`,
                    diagnostics: stderr,
                  },
            },
          );
        });
        child.send({ type: "run", source, action, outputRoot: job.exportRoot });
        if (active.cancelRequested) this.cancel();
      });
    } finally {
      if (this.active === active && !active.child) {
        this.active = null;
        resolveDone();
      }
    }
  }
  cancel() {
    if (!this.active) return false;
    this.active.cancelRequested = true;
    if (this.active.job) {
      this.active.job.status = "cancelling";
      this.active.job.phase = "Waiting for REA cancellation and cleanup";
      this.emit("update", this.active.job);
    }
    if (this.active.child?.connected)
      this.active.child.send({ type: "cancel" });
    return true;
  }
  async close() {
    const active = this.active;
    if (active) {
      this.cancel();
      await active.done;
    }
  }
  async setOutputRoot(path) {
    const root = await checkedDirectory(path);
    if (!withinDirectory(join(this.appRoot, "work", "outputs"), root))
      throw new Error(
        `Choose a folder inside ${join(this.appRoot, "work", "outputs")} to keep this application self-contained.`,
      );
    this.outputRoot = root;
    return root;
  }
  async allowedFolder(path) {
    if (typeof path !== "string") throw new Error("Invalid folder.");
    const real = await realpath(path);
    const roots = [
      this.outputRoot,
      this.stateRoot,
      ...(await this.list()).map((j) => j.outputRoot),
    ];
    if (
      !roots.some(
        (root) =>
          real === resolve(root) ||
          (!relative(root, real).startsWith(".." + sep) &&
            relative(root, real) !== ".." &&
            !isAbsolute(relative(root, real))),
      )
    )
      throw new Error("Only saved REA output folders can be opened.");
    await checkedDirectory(real);
    return real;
  }
}
