import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const appRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const require = createRequire(new URL("../../package.json", import.meta.url));
const { _electron } = require("playwright-core");
const root = await mkdtemp(join(appRoot, "work", "tmp", "rea-ui-acceptance-"));
const prefix = "desktop-acceptance-" + randomUUID().slice(0, 8);
const artifacts = join(appRoot, "setup", "desktop-acceptance", prefix);
await mkdir(artifacts, { recursive: true });
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
const original = Buffer.concat([
  tar,
  Buffer.from(createHash("md5").update(tar).digest("hex") + " x"),
]);
const input = join(root, "minimum.tar.md5");
await writeFile(input, original);
const errors = [];
const failedRequests = [];
const checks = [];
let application;
try {
  application = await _electron.launch({
    executablePath: join(
      appRoot,
      "tools",
      "desktop-runtime",
      "node_modules",
      "electron",
      "dist",
      "electron.exe",
    ),
    args: [join(appRoot, "source", "desktop"), "--open-file", input],
    env: {
      ...process.env,
      REA_DESKTOP_STATE: join(root, "state"),
      TEMP: join(appRoot, "work", "tmp"),
      TMP: join(appRoot, "work", "tmp"),
    },
    timeout: 20000,
  });
  const page = await application.firstWindow({ timeout: 15000 });
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("requestfailed", (r) =>
    failedRequests.push({ url: r.url(), error: r.failure()?.errorText }),
  );
  await page
    .getByRole("heading", { name: "Choose what you want to learn." })
    .waitFor({ timeout: 20000 });
  await page.locator("#folder-name").fill(prefix + "-inspect");
  await page.screenshot({
    path: join(artifacts, "implemented-plan.png"),
  });
  await page
    .getByRole("button", { name: "Start analysis", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Checking your file.", exact: true })
    .waitFor();
  await page.screenshot({
    path: join(artifacts, "implemented-running.png"),
  });
  await page
    .getByRole("heading", { name: "Package checksum matched", exact: true })
    .waitFor({ timeout: 20000 });
  assert.equal(await page.locator(".member").count(), 1);
  assert.match(await page.locator(".member").innerText(), /boot\.img/);
  checks.push("Real reader inspection and member list");
  await page.screenshot({
    path: join(artifacts, "implemented-findings.png"),
  });
  await page.getByRole("tab", { name: "Evidence", exact: true }).click();
  assert.match(await page.locator(".evidence-json").innerText(), /evidence_id/);
  checks.push("Complete evidence tab");
  await page.keyboard.press("ArrowLeft");
  assert.equal(
    await page
      .getByRole("tab", { name: "Raw data", exact: true })
      .getAttribute("aria-selected"),
    "true",
  );
  assert.equal(
    await page.getByRole("tabpanel").getAttribute("aria-labelledby"),
    "tab-raw",
  );
  checks.push("Arrow-key detail tabs with a labelled panel");
  await page
    .getByRole("button", { name: "Extract files", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Extract verified files.", exact: true })
    .waitFor();
  await page.locator("#export-name").fill(prefix + "-export");
  await page.screenshot({
    path: join(artifacts, "implemented-export.png"),
  });
  await page
    .getByRole("button", { name: "Extract files", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Your results, in one place.", exact: true })
    .waitFor({ timeout: 20000 });
  const output = join(appRoot, "work", "outputs", prefix + "-export");
  assert.equal(
    (await readFile(join(output, "files", "boot.img"))).toString(),
    "BOOT",
  );
  assert.deepEqual(await readFile(input), original);
  const report = JSON.parse(
    await readFile(join(output, "report.json"), "utf8"),
  );
  assert.ok(report.evidence_id);
  checks.push("Verified exported bytes, durable report and unchanged original");
  await page.screenshot({
    path: join(artifacts, "implemented-outputs.png"),
  });
  await page.getByRole("button", { name: "Projects", exact: true }).click();
  assert.equal(await page.locator(".project-row").count(), 2);
  await page.locator(".project-row").first().click();
  await page
    .getByRole("heading", { name: "Package checksum matched", exact: true })
    .waitFor();
  checks.push("Saved project restored");
  await page.keyboard.press("Control+k");
  assert.equal(
    await page.locator("#search").evaluate((n) => n === document.activeElement),
    true,
  );
  await page.locator("#search").fill("boot");
  assert.equal(await page.locator(".member").count(), 1);
  await page.locator("#search").fill("");
  await page.getByRole("button", { name: "Help", exact: true }).click();
  assert.equal(await page.locator("#help").isVisible(), true);
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#help").isVisible(), false);
  checks.push("Search shortcut and keyboard help dialog");
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1000, 720),
  );
  await page.waitForTimeout(200);
  assert.equal(
    await page.locator("body").evaluate((n) => n.scrollWidth <= innerWidth),
    true,
  );
  await page.screenshot({
    path: join(artifacts, "implemented-minimum-window.png"),
  });
  checks.push("1000 by 720 layout without horizontal document overflow");
  assert.equal(
    await page.evaluate(
      () =>
        typeof require === "undefined" &&
        typeof process === "undefined" &&
        !("select" in window.rea),
    ),
    true,
  );
  checks.push("Renderer has no raw Node globals or raw-path selection method");
  await rename(input, join(root, "preserved-original.tar.md5"));
  await page.getByRole("button", { name: "Projects", exact: true }).click();
  await page.locator(".project-row").first().click();
  assert.equal(
    await page
      .getByRole("button", { name: "Extract files", exact: true })
      .isDisabled(),
    true,
  );
  assert.match(await page.locator("#main").innerText(), /historical findings/);
  checks.push(
    "Historical findings remain readable and extraction is disabled when the original is unavailable",
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(failedRequests, []);
  checks.push("No observed renderer exceptions or failed asset requests");
  const receipt = {
    date: new Date().toISOString(),
    runtimeVersions: await application.evaluate(() => ({
      electron: process.versions.electron,
      node: process.versions.node,
      v8: process.versions.v8,
    })),
    workerNode: process.version,
    scope:
      "Local Windows Electron integration; synthetic Samsung fixture selected through supported launch argument",
    input,
    output,
    checks,
    errors,
    failedRequests,
    limitations: [
      "Native file-picker interaction, drag/drop, screen-reader audit and real Ghidra run are not covered by this automation.",
    ],
    stateRoot: join(root, "state"),
  };
  await writeFile(
    join(root, "acceptance.json"),
    JSON.stringify(receipt, null, 2) + "\n",
  );
  await writeFile(
    join(artifacts, "acceptance.json"),
    JSON.stringify(receipt, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({
      checks,
      output,
      receipt: join(artifacts, "acceptance.json"),
    }),
  );
} catch (error) {
  if (application) {
    const page = (await application.windows())[0];
    if (page) {
      await page.screenshot({
        path: join(artifacts, "implemented-check-failure.png"),
      });
      console.error(
        JSON.stringify({
          error: error.message,
          ui: (await page.locator("#main").innerText()).slice(0, 4500),
          errors,
          failedRequests,
          root,
        }),
      );
    }
  }
  throw error;
} finally {
  if (application) await application.close();
}
