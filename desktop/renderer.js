const api = window.rea;
const state = {
  page: "home",
  source: null,
  job: null,
  jobs: [],
  folders: [],
  info: null,
  query: "",
  tab: "overview",
  selected: 0,
  error: null,
  mode: "inspect",
  folderName: "",
  exportName: "",
  started: 0,
};
const main = document.querySelector("#main");
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const img = (name, size = 20, screen = "3-52") =>
  `<img src="assets/${screen}/${name}.svg" width="${size}" height="${size}" alt="">`;
const icon = (name, size = 20) => img("imgIcon" + name, size);
const bytes = (value) =>
  value === null || value === undefined
    ? "Size not recorded"
    : value >= 1e9
      ? (value / 1e9).toFixed(2) + " GB"
      : value >= 1e6
        ? (value / 1e6).toFixed(2) + " MB"
        : value >= 1e3
          ? (value / 1e3).toFixed(2) + " KB"
          : value + " bytes";
const date = (value) =>
  new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
const button = (label, action, style = "primary", extra = "") =>
  `<button class="button ${style}" data-action="${action}" ${extra}>${esc(label)}</button>`;
const chip = (label, tone = "") =>
  `<span class="chip ${tone}">${esc(label)}</span>`;
const heading = (title, subtitle, actions = "") =>
  `<div class="page-heading"><div><h1>${esc(title)}</h1><p>${esc(subtitle)}</p></div>${actions ? `<div class="actions">${actions}</div>` : ""}</div>`;
const note = (text) =>
  `<div class="note">${icon("Info", 18)}<p>${esc(text)}</p></div>`;
const json = (value) => esc(JSON.stringify(value, null, 2));
const matches = (job) =>
  !state.query ||
  `${job.source?.name} ${job.source?.format} ${job.summary?.format} ${job.status}`
    .toLowerCase()
    .includes(state.query.toLowerCase());
function notify(text) {
  const n = document.querySelector("#notification");
  n.textContent = text;
  n.classList.add("visible");
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => n.classList.remove("visible"), 6500);
}
function folderName(source, suffix = "") {
  return (
    (source.name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 42) || "analysis") +
    suffix +
    "-" +
    crypto.randomUUID().slice(0, 8)
  );
}
function setSource(source) {
  if (!source) return;
  state.source = source;
  state.job = null;
  state.error = null;
  state.mode = "inspect";
  state.folderName = folderName(source);
  state.page = "plan";
  state.tab = "overview";
  state.selected = 0;
  render();
}
function route(page) {
  if (state.job?.status === "running" || state.job?.status === "cancelling") {
    if (!["home", "projects", "outputs", "tools"].includes(page))
      page = "running";
  }
  state.page = page;
  state.error = null;
  render();
}
async function refresh() {
  [state.jobs, state.folders] = await Promise.all([api.list(), api.folders()]);
}
function jobRows(jobs) {
  return `<div class="panel project-list">${jobs.map((j) => `<button class="project-row" data-open-job="${esc(j.id)}"><span class="project-symbol">${icon(j.source.kind === "samsung" ? "Shield" : j.source.kind === "palm" ? "Code1" : "File")}</span><span><span class="project-name">${esc(j.source.name)}</span><span class="project-meta">${esc(j.source.format)} Â· ${esc(j.action === "extract" ? "Extraction" : "Inspection")}</span></span>${chip(j.status === "completed" ? (j.summary?.integrity === "match" ? "Checksum matched" : j.action === "extract" ? "Extraction complete" : "Findings saved") : j.status === "cancelled" ? "Cancelled" : j.status === "failed" ? "Needs attention" : j.status === "interrupted" ? "Interrupted" : j.status === "cancelling" ? "Cancelling" : "In progress", j.status === "failed" ? "danger" : j.status === "cancelled" ? "warning" : j.status === "completed" ? "" : "info")}<span class="project-date">${esc(date(j.startedAt))}</span>${icon("Chevron")}</button>`).join("")}</div>`;
}
function home() {
  const jobs = state.jobs
    .filter(matches)
    .slice(0, state.page === "projects" ? 100 : 6);
  return (
    heading(
      state.page === "projects" ? "Your projects." : "Make sense of any file.",
      state.page === "projects"
        ? "Inspections and exports created in this workbench."
        : "Open a file to see what it contains and choose your next step.",
      button("New analysis", "pick"),
    ) +
    `<section class="dropzone panel" id="dropzone" aria-label="Drop a file or folder"><div class="drop-main"><div class="drop-symbol">${icon("Upload", 24)}</div><div><h2>Drop a file or a folder here</h2><p>REA identifies the file and suggests useful analysis.</p><div class="drop-actions">${button("Choose files", "pick")}<span>or drag and drop from File Explorer</span><button class="link" data-action="pick-folder">Choose a folder</button></div></div></div><div class="drop-footer">${icon("Folder3", 17)}<code>Save results to ${esc(state.info?.outputRoot ?? "the application output folder")}</code><button class="link" data-action="change-output">Change</button></div></section><div class="section-heading"><h2>${state.page === "projects" ? "SAVED PROJECTS" : "CONTINUE A PROJECT"}</h2><button class="link" data-page="projects">View all projects</button></div>` +
    (jobs.length
      ? jobRows(jobs)
      : `<section class="panel empty"><h2>${state.query ? "No matching projects" : "Your first discovery starts here"}</h2><p>${state.query ? "Try a different search, or choose a new file." : "Choose a file to start a real REA inspection. Existing results are available from Outputs."}</p>${button("Browse saved outputs", "outputs", "secondary")}</section>`) +
    note(
      "Start with inspection. You can extract files after reviewing the findings.",
    )
  );
}
function sourceCard() {
  const s = state.source;
  return `<div class="panel source-card">${img("imgIconFile", 32, "3-53")}<div><h2 title="${esc(s.path)}">${esc(s.name)}</h2><p>${esc(s.format)} Â· ${esc(s.isDirectory ? "Folder" : bytes(s.bytes))} Â· Original is preserved</p></div>${chip(s.confirmed ? "Recognized" : "Suggested workflow", s.confirmed ? "" : "info")}</div>`;
}
function setup() {
  if (!state.source) return home();
  const native = /\.(exe|dll)$/i.test(state.source.name);
  return (
    heading(
      "Choose what you want to learn.",
      `${state.source.format}. REA validates the selected profile during inspection.`,
    ) +
    sourceCard() +
    `<h2 class="eyebrow">ANALYSIS</h2><div class="analysis-options" role="radiogroup" aria-label="Analysis type">${[["inspect", "Inspect contents", "List the contents, record integrity findings, and save a report."], ["extract", "Inspect and extract", "Also save recovered files to a new output folder."], ...(native ? [["native", "Analyze native code", "Use the installed Ghidra engine to inspect this executable."]] : [])].map(([value, title, description]) => `<label class="analysis-option"><input type="radio" name="mode" value="${value}" ${state.mode === value ? "checked" : ""}><span><h3>${title}</h3><p>${description}</p></span></label>`).join("")}</div><label class="field">New output folder name<input id="folder-name" value="${esc(state.folderName)}" maxlength="100" required></label><div class="path-preview"><code id="destination-preview">${esc(state.info.outputRoot + "\\" + state.folderName)}</code><button class="link" data-action="change-output">Change location</button></div><p class="muted small">A new project folder keeps your results together. Existing files are kept.</p><details class="advanced"><summary>Advanced options</summary><p>Complete evidence is saved as report.json. Extractions are saved in the files subfolder.</p><p>Source: <code>${esc(state.source.path)}</code></p><p>REA uses its existing format limits and reports unsupported profiles explicitly.</p></details><div class="foot-actions">${button("Back", "home", "secondary")}${button("Start analysis", "start")}</div>`
  );
}
function running() {
  const job = state.job;
  const extracting = job?.action === "extract";
  return (
    heading(
      extracting ? "Extracting and verifying files." : "Checking your file.",
      "You can keep browsing while REA works.",
    ) +
    `<section class="panel progress-panel">${chip(job?.status === "cancelling" ? "Cancelling" : "In progress", "info")}<h2>${esc(job?.phase ?? "Starting REA")}</h2><p>${esc(job?.source.name ?? state.source?.name)}</p><div class="progress-track" role="progressbar" aria-label="Analysis in progress"><div class="progress-segment"></div></div><p>Elapsed <span data-elapsed>00:00</span> Â· Time remaining is not yet known.</p><div class="steps"><div>${icon("Check", 18)}<span>Source selected</span></div><div>${img("imgIconClock", 18, "3-54")}<span>${extracting ? "REA is reading, extracting and verifying the complete supported input." : "REA is examining the complete supported input."}</span></div><div>${img("imgIconFile", 18, "3-54")}<span>Results will appear when analysis and cleanup finish.</span></div></div></section><div class="foot-actions">${button("Cancel analysis", "cancel", "secondary", job?.status === "cancelling" ? "disabled" : "")}</div>` +
    note(
      "Your original file stays unchanged. No invented percentage or completion time is shown.",
    )
  );
}
function integrity(job) {
  const s = job.summary;
  const failed = job.status === "failed";
  let title =
    s?.integrity === "match"
      ? "Package checksum matched"
      : s?.integrity === "mismatch"
        ? "Package checksum does not match"
        : job.action === "extract"
          ? "Files extracted and verified"
          : "Inspection findings saved";
  let detail =
    s?.integrity === "match"
      ? `${s.entries.length} files identified. Publisher authenticity and device compatibility are not checked.`
      : s?.integrity === "mismatch"
        ? "Inspection is preserved, but extraction is blocked. Check the source and try again."
        : `${s?.entries.length ?? 0} items recorded. Hashes and limitations are available in the saved evidence.`;
  if (failed) {
    title = "Analysis needs attention";
    detail = job.error?.message ?? "The selected workflow could not finish.";
  }
  return `<section class="integrity-summary ${failed ? "danger" : s?.integrity === "mismatch" ? "warning" : ""}">${img("imgIconShield", 32, "3-55")}<div><h2>${esc(title)}</h2><p>${esc(detail)}</p></div></section>`;
}
function findings() {
  const j = state.job;
  if (!j) return home();
  if (!j.evidence) return failure();
  const s = j.summary;
  const entries = s.entries.filter(
    (e) =>
      !state.query || e.name.toLowerCase().includes(state.query.toLowerCase()),
  );
  if (state.selected >= entries.length) state.selected = 0;
  const selected = entries[state.selected];
  const mismatched = s.integrity === "mismatch";
  const unavailable = state.source?.available === false;
  let detail = "";
  if (state.tab === "evidence")
    detail = `<h2>Recorded evidence</h2><p class="muted small">${esc(j.evidence.evidence_id)}</p><button class="link" data-action="copy-evidence-id">Copy evidence ID</button><pre class="evidence-json">${json(j.evidence)}</pre>`;
  else if (state.tab === "raw")
    detail = `<h2>Source metadata</h2><p class="muted small">Structured observations from the saved REA report.</p><pre class="evidence-json">${json(j.evidence.normalized_result)}</pre>`;
  else
    detail = `<div class="detail-title">${img("imgIconFile2", 24, "3-55")}<span>${esc(selected?.name ?? j.source.name)}</span></div><dl class="facts"><div><dt>${selected ? "Item size" : "Source size"}</dt><dd>${esc(bytes(selected?.bytes ?? j.source.bytes))}</dd></div><div><dt>Integrity</dt><dd>${selected?.sha256 ? "SHA-256 recorded" : s.sha256 ? "Source SHA-256 recorded" : "See evidence for integrity coverage"}</dd></div>${(selected?.sha256 ?? s.sha256) ? `<div><dt>SHA-256</dt><dd><code>${esc(selected?.sha256 ?? s.sha256)}</code></dd></div>` : ""}<div><dt>Content handling</dt><dd>${esc(selected?.kind ?? s.format)}</dd></div>${selected?.offset !== null && selected?.offset !== undefined ? `<div><dt>Source byte offset</dt><dd>${esc(selected.offset)}</dd></div>` : ""}</dl>${selected?.text ? `<pre class="evidence-json">${esc(selected.text)}</pre>` : ""}<button class="link" data-action="evidence-tab">View complete checksum and byte ranges â€º</button>`;
  return (
    heading(
      j.source.name,
      `${j.source.format} Â· ${bytes(j.source.bytes)}`,
      button("Save report", "save-report", "secondary") +
        button(
          "Extract files",
          "export",
          "primary",
          unavailable
            ? 'disabled title="Choose the original again for a new analysis"'
            : mismatched
              ? 'disabled title="Extraction requires a matching checksum"'
              : "",
        ),
    ) +
    integrity(j) +
    (unavailable ? note(state.source.availabilityIssue) : "") +
    `<div class="findings-grid"><section class="panel file-tree"><h2>CONTENTS Â· ${entries.length}</h2>${entries.length ? entries.map((e, i) => `<button class="member" data-member="${i}" aria-pressed="${state.selected === i}">${img(state.selected === i ? "imgIconFile1" : "imgIconFile", 20, "3-55")}<span class="member-name" title="${esc(e.name)}">${esc(e.name)}</span><span class="member-size">${esc(bytes(e.bytes))}</span></button>`).join("") : `<p class="muted small">${state.query ? "No matching items." : "This workflow did not produce a member list. Review the complete evidence."}</p>`}</section><section class="panel file-details"><div class="tabs" role="tablist" aria-label="Finding details">${[
      ["overview", "Overview"],
      ["raw", "Raw data"],
      ["evidence", "Evidence"],
    ]
      .map(
        ([value, label]) =>
          `<button role="tab" id="tab-${value}" aria-controls="finding-panel" tabindex="${state.tab === value ? 0 : -1}" data-tab="${value}" aria-selected="${state.tab === value}">${label}</button>`,
      )
      .join(
        "",
      )}</div><div role="tabpanel" id="finding-panel" aria-labelledby="tab-${state.tab}" tabindex="0">${detail}</div></section></div>${s.limitations.length ? `<details class="limitations"><summary>Analysis limits and incomplete coverage (${s.limitations.length})</summary><ul>${s.limitations.map((v) => `<li>${esc(v)}</li>`).join("")}</ul></details>` : ""}`
  );
}
function exportPage() {
  const s = state.job?.summary;
  if (!s) return home();
  if (!state.exportName) state.exportName = folderName(state.source, "-export");
  return (
    heading(
      "Extract verified files.",
      "Save the recovered contents into a new folder, with the complete REA report.",
    ) +
    `<label class="field">New output folder name<input id="export-name" value="${esc(state.exportName)}" maxlength="100" required></label><div class="path-preview"><code id="destination-preview">${esc(state.info.outputRoot + "\\" + state.exportName + "\\files")}</code><button class="link" data-action="change-output">Change location</button></div><p class="muted">A new folder will be created. No existing files will be replaced.</p><section class="panel export-list"><h2>Included in this export</h2><div class="export-row">${img("imgIconCheck1", 20, "3-56")}<div><h3>${s.entries.length} recorded items</h3><p>All files admitted by the selected REA reader.</p></div></div><div class="export-row">${img("imgIconCheck1", 20, "3-56")}<div><h3>REA evidence report</h3><p>Observed hashes, paths, provenance and limitations.</p></div></div><div class="export-row">${img("imgIconCheck1", 20, "3-56")}<div><h3>Format-specific metadata</h3><p>Manifest, original footer or resource directory where provided by the reader.</p></div></div></section><div class="verification-note">${img("imgIconShield", 24, "3-56")}<p>REA validates the saved output before marking the extraction complete. Unsupported formats are refused.</p></div><div class="foot-actions">${button("Back to findings", "findings", "secondary")}${button("Extract files", "extract")}</div>`
  );
}
function outputs() {
  const jobs = state.jobs.filter(matches);
  const paths = new Set(jobs.map((j) => j.outputRoot));
  const folders = state.folders.filter(
    (f) =>
      !paths.has(f.path) &&
      (!state.query ||
        f.name.toLowerCase().includes(state.query.toLowerCase())),
  );
  const done =
    state.job?.action === "extract" && state.job.status === "completed";
  return (
    heading(
      "Your results, in one place.",
      `Reports and extracted files are saved under ${state.info.outputRoot}.`,
      button("Open output folder", "open-output"),
    ) +
    (done
      ? `<section class="integrity-summary">${img("imgIconCheck1", 28, "3-57")}<div><h2>${state.job.summary.entries.length} items extracted and verified</h2><p>Your original is unchanged. Complete evidence is saved beside the exported files.</p></div></section>`
      : "") +
    `<div class="section-heading"><h2>SAVED OUTPUTS</h2><button class="link" data-action="refresh">Refresh</button></div><section class="panel project-list">${jobs.map((j) => `<button class="output-row" data-open-folder="${esc(j.outputRoot)}">${img("imgIconFolder3", 24, "3-57")}<span><span class="project-name">${esc(j.source.name)} / ${j.action === "extract" ? "files" : "report"}</span><span class="project-meta">${esc(j.outputRoot)}</span></span><span class="small muted">${esc(date(j.startedAt))}</span>${chip(j.status === "completed" ? "Saved" : j.status === "cancelled" ? "Cancelled" : "Attention", j.status === "completed" ? "" : "warning")}</button>`).join("")}${folders.map((f) => `<button class="output-row" data-open-folder="${esc(f.path)}">${img("imgIconFolder3", 24, "3-57")}<span><span class="project-name">${esc(f.name)}</span><span class="project-meta">Existing REA output folder</span></span><span class="small muted">Open in Explorer</span>${chip("Local folder", "info")}</button>`).join("")}${!jobs.length && !folders.length ? '<div class="empty"><h2>No saved output yet</h2><p>Start an inspection from Workbench. Your report will appear here.</p></div>' : ""}</section>` +
    (state.job
      ? `<div class="panel selected-path"><p class="eyebrow">SELECTED OUTPUT</p><code>${esc(state.job.outputRoot)}</code><button class="link" data-action="findings">Review this jobâ€™s findings â€º</button></div>`
      : "")
  );
}
function tools() {
  return (
    heading(
      "Tools & storage.",
      "Your local installation and output locations.",
      button("Check again", "check-tools", "secondary"),
    ) +
    `<section class="panel">${state.info.engines.map((e) => `<div class="tool-row"><span>${esc(e.name)}</span>${chip(e.installed ? "Installed" : "Not installed", e.installed ? "" : "warning")}</div>`).join("")}</section><section class="panel selected-path"><p class="eyebrow">APPLICATION</p><code>${esc(state.info.appRoot)}</code><p class="muted small">REA ${esc(state.info.version ?? "unavailable")} Â· Portable desktop interface</p><p class="eyebrow">OUTPUTS</p><code>${esc(state.info.outputRoot)}</code><button class="link" data-action="change-output">Choose an output subfolder</button><p class="eyebrow">DESKTOP DATA</p><code>${esc(state.info.stateRoot)}</code></section>` +
    note(
      "Installed status checks files and REA startup. Each analysis validates its own format, provider and resource requirements.",
    )
  );
}
function failure() {
  const e = state.job?.error ?? state.error;
  return (
    heading(
      state.job?.status === "cancelled"
        ? "Analysis cancelled."
        : "This analysis needs attention.",
      "Your original file is unchanged.",
    ) +
    `<section class="error-panel"><h2>${esc(e?.message ?? "The workflow could not finish.")}</h2>${e?.remediation?.action ? `<p>${esc(e.remediation.action)}</p>` : ""}<details><summary>Technical details</summary><pre class="evidence-json">${json(e)}</pre></details></section><div class="actions">${button("Choose another file", "pick")}${button("Back to setup", "plan", "secondary")}${button("View saved outputs", "outputs", "secondary")}</div>`
  );
}
function render() {
  if (!state.info) return;
  const active = ["home", "plan", "running"].includes(state.page)
    ? "home"
    : ["findings", "export"].includes(state.page)
      ? "projects"
      : state.page;
  document
    .querySelectorAll("[data-page]")
    .forEach((n) =>
      n.setAttribute(
        "aria-current",
        n.dataset.page === active ? "page" : "false",
      ),
    );
  document.querySelector("#breadcrumb").textContent =
    {
      home: "Workbench",
      projects: "Projects",
      plan: "New analysis",
      running: "Analysis in progress",
      findings: "Projects / " + state.source?.name,
      export: "Export",
      outputs: "Outputs",
      tools: "Tools & storage",
      failure: "Analysis details",
    }[state.page] ?? "Workbench";
  document.querySelector("#current-project").textContent =
    state.source?.name ?? "Local workspace";
  document.querySelector("#output-path").textContent =
    "Output  " + state.info.outputRoot;
  document.querySelector("#application-path").textContent = state.info.appRoot;
  const connection = document.querySelector("#connection");
  connection.classList.toggle("error", !state.info.connected);
  connection.querySelector("strong").textContent = state.info.connected
    ? "REA connected"
    : "REA unavailable";
  const views = {
    home,
    projects: home,
    plan: setup,
    running,
    findings,
    export: exportPage,
    outputs,
    tools,
    failure,
  };
  main.innerHTML =
    (state.error
      ? `<div class="error-panel" role="alert"><h2>${esc(state.error.message)}</h2></div>`
      : "") + (views[state.page] ?? home)();
}
async function start(action, folder) {
  if (!state.source) return;
  state.error = null;
  state.started = Date.now();
  state.page = "running";
  state.job = {
    source: state.source,
    status: "running",
    action,
    phase: "Starting REA",
  };
  render();
  try {
    const job = await api.run(state.source.id, action, { folderName: folder });
    state.job = job;
    await refresh();
    state.selected = 0;
    state.tab = "overview";
    state.page =
      job.status === "completed"
        ? action === "extract"
          ? "outputs"
          : "findings"
        : "failure";
    render();
  } catch (error) {
    state.error = error;
    state.page = "plan";
    render();
  }
}
const actions = {
  pick: async () => setSource(await api.pick(false)),
  "pick-folder": async () => setSource(await api.pick(true)),
  home: () => route("home"),
  plan: () => route("plan"),
  findings: () => route("findings"),
  outputs: async () => {
    await refresh();
    route("outputs");
  },
  start: () => start(state.mode, state.folderName),
  extract: () => start("extract", state.exportName),
  export: () => {
    state.exportName = "";
    route("export");
  },
  cancel: async () => {
    await api.cancel();
    notify("Cancellation requested. Waiting for REA cleanup.");
  },
  "open-output": () => api.openFolder(state.info.outputRoot),
  "change-output": async () => {
    state.info.outputRoot = await api.chooseOutput();
    await refresh();
    render();
  },
  "check-tools": async () => {
    state.info = await api.info();
    render();
    notify(
      state.info.connected ? "REA startup checked." : "REA could not start.",
    );
  },
  refresh: async () => {
    await refresh();
    render();
  },
  "save-report": async () => {
    await api.openFolder(state.job.outputRoot);
    notify("report.json contains the complete recorded REA evidence.");
  },
  "copy-evidence-id": async () => {
    await api.copy(state.job.evidence.evidence_id);
    notify("Evidence ID copied.");
  },
  "evidence-tab": () => {
    state.tab = "evidence";
    render();
  },
  help: () => document.querySelector("#help").showModal(),
  "close-help": () => document.querySelector("#help").close(),
};
document.addEventListener("click", async (event) => {
  const n = event.target.closest("button");
  if (!n || n.disabled) return;
  try {
    if (n.dataset.window) await api.window(n.dataset.window);
    else if (n.dataset.action) await actions[n.dataset.action]?.();
    else if (n.dataset.page) {
      if (n.dataset.page === "outputs") await refresh();
      route(n.dataset.page);
    } else if (n.dataset.openJob) {
      state.job = await api.restore(n.dataset.openJob);
      state.source = state.job.source;
      state.selected = 0;
      state.tab = "overview";
      route(state.job.evidence ? "findings" : "failure");
    } else if (n.dataset.openFolder) await api.openFolder(n.dataset.openFolder);
    else if (n.dataset.member !== undefined) {
      state.selected = Number(n.dataset.member);
      state.tab = "overview";
      render();
      document.querySelector(`[data-member="${state.selected}"]`)?.focus();
    } else if (n.dataset.tab) {
      state.tab = n.dataset.tab;
      render();
      document.querySelector(`[data-tab="${state.tab}"]`)?.focus();
    }
  } catch (error) {
    state.error = error;
    notify(error.message);
    render();
  }
});
document.addEventListener("change", (event) => {
  if (event.target.name === "mode") state.mode = event.target.value;
});
document.addEventListener("input", (event) => {
  if (event.target.id === "search") {
    state.query = event.target.value;
    state.selected = 0;
    render();
  }
  if (event.target.id === "folder-name" || event.target.id === "export-name") {
    const exporting = event.target.id === "export-name";
    state[exporting ? "exportName" : "folderName"] = event.target.value;
    const p = document.querySelector("#destination-preview");
    if (p)
      p.textContent =
        state.info.outputRoot +
        "\\" +
        event.target.value +
        (exporting ? "\\files" : "");
  }
});
document.addEventListener("keydown", (event) => {
  if (
    event.target.closest('[role="tab"]') &&
    ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
  ) {
    event.preventDefault();
    const tabs = ["overview", "raw", "evidence"];
    const index = tabs.indexOf(state.tab);
    state.tab =
      tabs[
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? 2
            : (index + (event.key === "ArrowRight" ? 1 : 2)) % 3
      ];
    render();
    document.querySelector(`[data-tab="${state.tab}"]`).focus();
  }
  if (event.ctrlKey && event.key.toLowerCase() === "o") {
    event.preventDefault();
    void actions.pick().catch((e) => notify(e.message));
  }
  if (event.ctrlKey && event.key.toLowerCase() === "k") {
    event.preventDefault();
    document.querySelector("#search").focus();
  }
});
document.addEventListener("dragover", (event) => {
  event.preventDefault();
  document.querySelector("#dropzone")?.classList.add("dragover");
});
document.addEventListener("dragleave", () =>
  document.querySelector("#dropzone")?.classList.remove("dragover"),
);
document.addEventListener("drop", async (event) => {
  event.preventDefault();
  try {
    const file = event.dataTransfer.files[0];
    if (file) setSource(await api.droppedFile(file));
  } catch (error) {
    notify(error.message);
  }
});
api.onUpdate((job) => {
  state.job = job;
  if (state.page === "running") render();
});
api.onSelected(setSource);
setInterval(() => {
  const e = document.querySelector("[data-elapsed]");
  if (e) {
    const s = Math.max(0, Math.floor((Date.now() - state.started) / 1000));
    e.textContent =
      String(Math.floor(s / 60)).padStart(2, "0") +
      ":" +
      String(s % 60).padStart(2, "0");
  }
}, 1000);
try {
  state.info = await api.info();
  await refresh();
  render();
} catch (error) {
  main.textContent = "REA Workbench could not start: " + error.message;
}
