"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const SECRET = "SYNTHETIC_CREDENTIAL_DO_NOT_LOG";
const flush = () => new Promise(resolve => setImmediate(resolve));

function mainFixture(t) {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "zusage-private-diag-"));
  t.after(() => fs.rmSync(runtime, { recursive: true, force: true }));
  const windows = [];
  const sandbox = {
    __dirname: runtime, module: { exports: {} }, console: { error() {} },
    process: { pid: process.pid, platform: process.platform, resourcesPath: runtime,
      execPath: process.execPath, uptime: () => 1, env: {} },
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0,
    require(name) {
      if (["path", "url", "crypto"].includes(name)) return require(name);
      if (name === "fs") return { ...fs, watch() { throw new Error("watch disabled in fixture"); } };
      if (name === "electron") return { app: { getPath: () => runtime, on() {} },
        webContents: { getAllWebContents: () => windows }, ipcMain: { on() {} } };
      if (name === "child_process") return { spawn() { throw new Error("process forbidden"); }, execFile() {} };
      throw new Error("fixture forbids loading " + name);
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, "inject-main.cjs"), "utf8"), sandbox);
  const api = sandbox.module.exports.__zusageTest;
  function windowWith(raw) {
    const wc = { id: windows.length + 1, getType: () => "window", isDestroyed: () => false,
      getURL: () => "file://" + path.join(runtime, "index.html"),
      executeJavaScript: async js => js.includes("JSON.stringify(window.__zusageDiag") ? raw : "null" };
    windows.push(wc);
    return wc;
  }
  return { api, runtime, windowWith };
}

for (const file of ["overlay.js", "web/overlay.js"]) {
  test(file + " diagnostics do not read storage values, scope attributes or frame URLs", () => {
    const source = fs.readFileSync(path.join(ROOT, file), "utf8");
    let reads = 0;
    const localStorage = { auth: SECRET, arbitraryName: SECRET };
    Object.defineProperty(localStorage, "getItem", { value(key) { reads++; return this[key]; } });
    const element = { tagName: "TEXTAREA", attributes: [], getBoundingClientRect: () => ({ top: 500 }),
      getAttribute() { reads++; return SECRET; }, hasAttribute: () => false, parentElement: null };
    const FATAL = {};
    const context = { localStorage, FATAL, window: {}, innerHeight: 800, COMPOSER_SEL: "textarea",
      visible: () => true, elDesc: () => "TEXTAREA", document: { body: {},
        querySelectorAll: () => [element] } };
    const start = source.indexOf("    function diagPanes() {");
    const end = source.indexOf("    function track() {", start);
    assert.ok(start >= 0 && end > start);
    vm.runInNewContext(source.slice(start, end) + "\ndiagPanes();", context);
    // Reproduce the original credential leak if a legacy mount dump reappears.
    const dump = source.indexOf("lsVals: (function () {");
    if (dump >= 0) {
      const stop = source.indexOf("lastSessionVals:", dump);
      const expression = source.slice(dump + "lsVals: ".length, stop).trim().replace(/,\s*$/, "");
      FATAL.legacyDump = vm.runInNewContext(expression, context);
    }
    assert.equal(reads, 0, "diagnostics must never read arbitrary stored values or scope attributes");
    assert.equal(JSON.stringify(FATAL).includes(SECRET), false);
    assert.equal(FATAL.panes.composerCount, 1);
  });
}

test("main process persists only approved diagnostic fields and private permissions", async t => {
  const f = mainFixture(t);
  f.windowWith(JSON.stringify({ version: "v95", href: SECRET, fatal: SECRET,
    arbitraryName: SECRET, panes: { lsPane: [SECRET] },
    mount: { version: "v95", mode: "in-card", theme: "dark", lsVals: SECRET, picked: SECRET,
      href: SECRET, barRect: [1, 2, 300, 24], font: { fam: SECRET } } }));
  f.api.handlePayload({ recent: [], token: SECRET });
  await flush();
  const file = path.join(f.runtime, "diag-0.json");
  const text = fs.readFileSync(file, "utf8"), data = JSON.parse(text);
  assert.equal(text.includes(SECRET), false, "legacy/forged fields must not reach disk");
  assert.equal(data.mounted, true);
  assert.equal(data.version, "v95");
  assert.deepEqual(data.errors, ["fatal"]);
  assert.deepEqual(data.mount.barRect, [1, 2, 300, 24]);
  assert.equal(data.mount.mode, "in-card");
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("invalid JSON is discarded without the old raw-payload fallback", async t => {
  const f = mainFixture(t);
  f.windowWith(SECRET);
  f.api.handlePayload({ recent: [] });
  await flush();
  assert.equal(fs.existsSync(path.join(f.runtime, "diag-0.json")), false);
});

test("diagnostic replacement does not follow a pre-existing symlink", { skip: process.platform === "win32" }, async t => {
  const f = mainFixture(t);
  const target = path.join(f.runtime, "unrelated.txt"), file = path.join(f.runtime, "diag-0.json");
  fs.writeFileSync(target, "keep me");
  fs.symlinkSync(target, file);
  f.windowWith(JSON.stringify({ version: "v95", mount: { mode: "in-card" } }));
  f.api.handlePayload({ recent: [] });
  await flush();
  assert.equal(fs.readFileSync(target, "utf8"), "keep me");
  assert.equal(fs.lstatSync(file).isSymbolicLink(), false);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.readdirSync(f.runtime).some(name => name.includes(".tmp-")), false);
});
