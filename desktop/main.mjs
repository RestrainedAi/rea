import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  protocol,
  net,
  shell,
  clipboard,
} from "electron";
import { access, mkdir, readFile, readdir, lstat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WorkbenchEngine, withinDirectory } from "./engine.mjs";

const trace = (message) => {
  if (process.env.REA_DESKTOP_DIAGNOSTICS === "1")
    console.error("[REA startup]", message);
};
trace("module loaded");
const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "../..");
const stateRoot = process.env.REA_DESKTOP_STATE
  ? resolve(process.env.REA_DESKTOP_STATE)
  : join(appRoot, "work", "desktop");
if (!withinDirectory(join(appRoot, "work"), stateRoot))
  throw new Error("Desktop data must remain within REA work.");
await mkdir(stateRoot, { recursive: true });
for (const name of ["user-data", "session", "logs", "crashes"])
  await mkdir(join(stateRoot, name), { recursive: true });
trace("state folders ready");
app.setName("REA Workbench");
app.setPath("userData", join(stateRoot, "user-data"));
app.setPath("sessionData", join(stateRoot, "session"));
app.setPath("crashDumps", join(stateRoot, "crashes"));
app.setAppLogsPath(join(stateRoot, "logs"));
protocol.registerSchemesAsPrivileged([
  {
    scheme: "rea",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);
const engine = new WorkbenchEngine({ appRoot, stateRoot });
let win;
let quitting = false;
let info;
const run = promisify(execFile);
async function status() {
  let version = null;
  let error = null;
  try {
    const r = await run(
      join(appRoot, "tools", "node-v24.18.0-win-x64", "node.exe"),
      [join(appRoot, "source", "scripts", "rea.mjs"), "--version"],
      { windowsHide: true, timeout: 20000, maxBuffer: 65536 },
    );
    version = r.stdout.trim();
  } catch (e) {
    error = "REA could not start. Check the portable runtime and source build.";
  }
  const available = async (path) => {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  };
  info = {
    appRoot,
    outputRoot: engine.outputRoot,
    stateRoot,
    version,
    error,
    connected: !!version,
    engines: [
      { name: "Palm resource reader", installed: !!version },
      { name: "Samsung TAR.MD5 reader", installed: !!version },
      {
        name: "Inno 7 / 7z reader",
        installed: await available(
          join(appRoot, "tools", "static-archives", "manifest.json"),
        ),
      },
      {
        name: "Ghidra native analysis",
        installed: await available(
          join(
            appRoot,
            "tools",
            "ghidra_12.1.4_PUBLIC",
            "support",
            "analyzeHeadless.bat",
          ),
        ),
      },
    ],
  };
  return info;
}
function trusted(event) {
  if (
    !win ||
    event.sender !== win.webContents ||
    event.senderFrame?.url !== "rea://workbench/index.html"
  )
    throw new Error("Untrusted desktop request.");
}
function handler(name, fn) {
  ipcMain.handle("rea:" + name, async (event, ...args) => {
    trusted(event);
    try {
      return { ok: true, value: await fn(...args) };
    } catch (error) {
      return { ok: false, error: { message: error.message } };
    }
  });
}
handler("info", status);
handler("list", () => engine.list());
handler("select", (path) => engine.select(path));
handler("restore", (id) => engine.restore(id));
handler("pick", async (directory) => {
  const result = await dialog.showOpenDialog(win, {
    title: directory
      ? "Choose an application folder"
      : "Choose a file to inspect",
    defaultPath: join(appRoot, "work", "inputs"),
    properties: [directory ? "openDirectory" : "openFile"],
  });
  if (result.canceled) return null;
  return engine.select(result.filePaths[0]);
});
handler("run", (id, action, options) => engine.run(id, action, options));
handler("cancel", () => engine.cancel());
handler("choose-output", async () => {
  const result = await dialog.showOpenDialog(win, {
    title: "Choose a folder inside REA outputs",
    defaultPath: engine.outputRoot,
    properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled) return engine.outputRoot;
  return engine.setOutputRoot(result.filePaths[0]);
});
handler("output-folders", async () => {
  await engine.ready();
  const entries = await readdir(engine.outputRoot, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && !e.isSymbolicLink())
    .slice(0, 500)
    .map((e) => ({ name: e.name, path: join(engine.outputRoot, e.name) }));
});
handler("open-folder", async (path) => {
  const selected = await engine.allowedFolder(path ?? engine.outputRoot);
  const error = await shell.openPath(selected);
  if (error) throw new Error(error);
  return true;
});
handler("copy", async (value) => {
  if (typeof value !== "string" || value.length > 65536)
    throw new Error("Invalid text to copy.");
  clipboard.writeText(value);
  return true;
});
handler("window", (action) => {
  if (action === "minimize") win.minimize();
  else if (action === "maximize")
    win.isMaximized() ? win.unmaximize() : win.maximize();
  else if (action === "close") win.close();
  else throw new Error("Unknown window action.");
  return true;
});
engine.on("update", (job) => {
  if (win && !win.isDestroyed()) win.webContents.send("rea:update", job);
});
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  trace("instance lock acquired");
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
  // Let the entry module finish evaluating so Electron can emit ready.
  trace("waiting for app ready");
  void app
    .whenReady()
    .then(async () => {
      trace("app ready");
      await engine.ready();
      trace("engine ready");
      protocol.handle("rea", (request) => {
        const url = new URL(request.url);
        if (url.hostname !== "workbench")
          return new Response("Not found", { status: 404 });
        let decoded;
        try {
          decoded = decodeURIComponent(url.pathname);
        } catch {
          return new Response("Invalid path", { status: 400 });
        }
        const path = resolve(here, "." + decoded);
        const rel = relative(here, path);
        if (
          rel.startsWith("..") ||
          ![".html", ".css", ".js", ".svg", ".woff", ".woff2"].includes(
            extname(path),
          )
        )
          return new Response("Not found", { status: 404 });
        return net.fetch(pathToFileURL(path).href);
      });
      win = new BrowserWindow({
        width: 1440,
        height: 960,
        minWidth: 1000,
        minHeight: 720,
        show: false,
        frame: false,
        backgroundColor: "#0d141e",
        title: "REA Workbench",
        icon: join(appRoot, "assets", "rea.ico"),
        autoHideMenuBar: true,
        webPreferences: {
          preload: join(here, "preload.cjs"),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webSecurity: true,
          spellcheck: false,
        },
      });
      trace("window created");
      win.webContents.session.setPermissionRequestHandler(
        (_contents, _permission, callback) => callback(false),
      );
      win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      win.webContents.on("will-navigate", (event, url) => {
        if (url !== "rea://workbench/index.html") event.preventDefault();
      });
      win.webContents.on("will-attach-webview", (event) =>
        event.preventDefault(),
      );
      win.on("close", (event) => {
        if (engine.active && !quitting) {
          event.preventDefault();
          void (async () => {
            const answer = await dialog.showMessageBox(win, {
              type: "question",
              title: "Analysis is running",
              message: "Cancel the analysis and close REA?",
              detail: "REA will finish its cleanup before closing.",
              buttons: ["Keep working", "Cancel and close"],
              defaultId: 0,
              cancelId: 0,
            });
            if (answer.response === 1) {
              quitting = true;
              await engine.close();
              win.close();
            }
          })();
        }
      });
      win.once("ready-to-show", () => win.show());
      await win.loadURL("rea://workbench/index.html");
      trace("page loaded");
      const index = process.argv.indexOf("--open-file");
      if (index >= 0 && process.argv[index + 1]) {
        const source = await engine.select(resolve(process.argv[index + 1]));
        win.webContents.send("rea:selected", source);
      }
      app.on("window-all-closed", () => app.quit());
    })
    .catch((error) => {
      console.error("REA desktop startup failed:", error);
      dialog.showErrorBox("REA could not open", error.message);
      app.exit(1);
    });
}
