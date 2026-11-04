// Sandboxed preloads have no ESM context: https://www.electronjs.org/docs/latest/tutorial/esm#sandboxed-preload-scripts-cant-use-esm-imports
// oxlint-disable-next-line typescript/no-var-requires -- Electron's sandbox exposes this CommonJS loader.
const { contextBridge, ipcRenderer, webUtils } = require("electron");
async function invoke(name, ...args) {
  const result = await ipcRenderer.invoke("rea:" + name, ...args);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
contextBridge.exposeInMainWorld("rea", {
  info: () => invoke("info"),
  list: () => invoke("list"),
  pick: (directory) => invoke("pick", directory === true),
  restore: (id) => invoke("restore", id),
  droppedFile: (file) => invoke("select", webUtils.getPathForFile(file)),
  run: (id, action, options) => invoke("run", id, action, options),
  cancel: () => invoke("cancel"),
  chooseOutput: () => invoke("choose-output"),
  folders: () => invoke("output-folders"),
  openFolder: (path) => invoke("open-folder", path),
  copy: (text) => invoke("copy", text),
  window: (action) => invoke("window", action),
  onUpdate: (callback) => {
    const listener = (_event, job) => callback(job);
    ipcRenderer.on("rea:update", listener);
    return () => ipcRenderer.removeListener("rea:update", listener);
  },
  onSelected: (callback) => {
    const listener = (_event, source) => callback(source);
    ipcRenderer.on("rea:selected", listener);
    return () => ipcRenderer.removeListener("rea:selected", listener);
  },
});
