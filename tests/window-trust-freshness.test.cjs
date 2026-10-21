"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const source = fs.readFileSync(path.join(__dirname, "..", "inject-main.cjs"), "utf8");
const local = "file:///fixture/resources/app.asar/out/renderer/index.html";
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture(urls = [local]) {
  const ipc = new EventEmitter(), windows = [], timers = [], procs = [];
  let now = 100000;
  function add(url) {
    const wc = new EventEmitter();
    Object.assign(wc, { id: windows.length + 1, url, dead: false, scripts: [], queue: [],
      mainFrame: { url }, getURL() { return this.url; }, getType: () => "window",
      isDestroyed() { return this.dead; }, isLoading: () => false,
      async executeJavaScript(js) {
        this.scripts.push(js);
        if (js.includes("q.splice")) return this.queue.splice(0, 8);
        if (js.includes("var a=window.__zusageWantSids")) return JSON.stringify({ s: ["sid"], w: {}, p: {} });
        return "null";
      },
      navigate(url) {
        this.emit("did-start-navigation", {}, url, false, true);
        this.url = this.mainFrame.url = url; this.emit("did-finish-load");
      },
    });
    windows.push(wc); return wc;
  }
  urls.forEach(add);
  class Clock extends Date { static now() { return now; } }
  const app = new EventEmitter(); app.getPath = () => "/fixture/home";
  const sandbox = vm.createContext({ __dirname: "/fixture/runtime", Date: Clock,
    module: { exports: {} }, console: { error() {} },
    process: { resourcesPath: "/fixture/resources", execPath: process.execPath, uptime: () => 1, env: {} },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout() {},
    setInterval: () => 0,
    require(name) {
      if (["path", "crypto", "url"].includes(name)) return require(name);
      if (name === "fs") return { readFileSync: file => file.endsWith("config.json") ? '{"resident":false}' : 'window.assetLoaded=true;',
        statSync: () => ({ mtimeMs: 1, size: 1 }), existsSync: () => false, watch: () => ({ on() {} }) };
      if (name === "electron") return { app, ipcMain: ipc, webContents: { getAllWebContents: () => windows } };
      if (name === "child_process") return { execFile() {}, spawn() {
        const p = new EventEmitter(); p.stdout = new EventEmitter(); p.stderr = new EventEmitter(); p.kill = () => {};
        procs.push(p); return p;
      } };
      throw new Error("fixture blocks " + name);
    },
  });
  vm.runInContext(source, sandbox);
  const api = vm.runInContext("({ handlePayload, runQuery, maybeSpawn, pollPluginRequests, activeSid, windowTasks, windowWorkspaces, scopeBindings, remoteEvidence })", sandbox);
  const event = wc => ({ sender: wc, senderFrame: wc.mainFrame });
  return { windows, add, api, ipc, event, timers, procs, sandbox, advance: ms => { now += ms; } };
}

test("external and outside-resource windows receive no injection, query reads or statistics", async () => {
  const f = fixture([local, "https://example.invalid", "file:///fixture/outside.html", "file:///fixture/resources-other/index.html"]);
  await flush();
  f.api.handlePayload({ recent: [{ sid: "sid", total: 42 }] }); await flush();
  assert.ok(f.windows[0].scripts.some(js => js.includes("assetLoaded")));
  assert.ok(f.windows[0].scripts.some(js => js.startsWith("window.__zusageUpdate")));
  for (const wc of f.windows.slice(1)) assert.deepEqual(wc.scripts, []);
});

test("all three IPC channels reject subframes, missing frames and remote windows", () => {
  const f = fixture([local, "https://example.invalid"]), wc = f.windows[0];
  for (const event of [{ sender: wc }, { sender: wc, senderFrame: { url: local } }, f.event(f.windows[1])]) {
    f.ipc.emit("zcode:sync-active-task-session", event, "forged");
    f.ipc.emit("zcode:sync-web-remote-control-workspaces", event, [{ workspacePath: "/p", kind: "remote", workspaceIdentity: "remote:ssh:a:22:u:/p" }]);
    f.ipc.emit("zcode:sync-web-remote-control-tasks", event, [{ taskId: "forged", workspaceKind: "remote", workspaceIdentity: "remote:ssh:a:22:u:/p" }]);
  }
  assert.equal(f.api.activeSid.size, 0);
  assert.equal(f.api.windowTasks.size, 0);
  assert.equal(f.api.windowWorkspaces.size, 0);
  f.ipc.emit("zcode:sync-active-task-session", f.event(wc), "valid");
  assert.equal(f.api.activeSid.get(wc.id), "valid");
});

test("a loading main frame cannot receive statistics or send trusted IPC", async () => {
  const f = fixture(), wc = f.windows[0]; await flush();
  wc.isLoadingMainFrame = () => true;
  const count = wc.scripts.length;
  f.ipc.emit("zcode:sync-active-task-session", f.event(wc), "forged");
  f.api.handlePayload({ recent: [] }); await flush();
  assert.equal(f.api.activeSid.size, 0);
  assert.equal(wc.scripts.length, count);
});

test("about:blank windows can load a trusted page later and navigation revokes their state", async () => {
  const f = fixture(["about:blank"]), wc = f.windows[0];
  assert.deepEqual(wc.scripts, []);
  wc.navigate(local); await flush();
  assert.ok(wc.scripts.some(js => js.includes("assetLoaded")));
  f.ipc.emit("zcode:sync-active-task-session", f.event(wc), "sid");
  for (const map of [f.api.windowTasks, f.api.windowWorkspaces, f.api.scopeBindings, f.api.remoteEvidence]) map.set(wc.id, {});
  wc.navigate("https://example.invalid");
  const count = wc.scripts.length;
  f.api.handlePayload({ recent: [] }); await flush();
  assert.equal(wc.scripts.length, count);
  for (const map of [f.api.activeSid, f.api.windowTasks, f.api.windowWorkspaces, f.api.scopeBindings, f.api.remoteEvidence]) assert.equal(map.has(wc.id), false);
});

test("controls returned after navigation cannot trigger an update", async () => {
  const f = fixture(), wc = f.windows[0]; await flush();
  let actions = 0;
  f.sandbox.actionCount = () => { actions++; };
  vm.runInContext("pluginUpdater = { request: async () => { actionCount(); } }", f.sandbox);
  const execute = wc.executeJavaScript.bind(wc);
  wc.executeJavaScript = async js => {
    if (js.includes("q.splice")) { wc.navigate("https://example.invalid"); return [{ action: "update" }]; }
    return execute(js);
  };
  await f.api.pollPluginRequests();
  assert.equal(actions, 0);
});

test("a completed local reload cannot authorize controls from the previous document", async () => {
  const f = fixture(), wc = f.windows[0]; await flush();
  let actions = 0;
  f.sandbox.actionCount = () => { actions++; };
  vm.runInContext("pluginUpdater = { status: () => ({}), request: async () => { actionCount(); } }", f.sandbox);
  const execute = wc.executeJavaScript.bind(wc);
  wc.executeJavaScript = async js => {
    if (js.includes('q.splice')) { wc.navigate(local); return [{ action: 'update' }]; }
    return execute(js);
  };
  await f.api.pollPluginRequests();
  assert.equal(actions, 0);
});

test("main document navigation and destruction revoke every window identity map", () => {
  const f = fixture(), wc = f.windows[0];
  const maps = [f.api.activeSid, f.api.windowTasks, f.api.windowWorkspaces, f.api.scopeBindings, f.api.remoteEvidence];
  for (const map of maps) map.set(wc.id, {});
  wc.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
  assert.ok(maps.every(map => map.has(wc.id)));
  wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
  assert.ok(maps.every(map => map.has(wc.id)));
  wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  assert.ok(maps.every(map => !map.has(wc.id)));
  for (const map of maps) map.set(wc.id, {});
  wc.dead = true; wc.emit('destroyed');
  assert.ok(maps.every(map => !map.has(wc.id)));
});

test("query failures publish stale status with retained readings, and success clears it", async () => {
  const f = fixture(); await flush();
  const wc = f.windows[0];
  function latest() {
    const js = wc.scripts.filter(s => s.startsWith("window.__zusageUpdate")).at(-1);
    let value;
    vm.runInNewContext(js, { window: { __zusageUpdate: d => { value = d; } } });
    return value;
  }
  f.api.handlePayload({ recent: [{ sid: "sid", total: 42 }], today: { total: 42 } });
  assert.equal(latest().data_health.state, "fresh");
  const updated = latest().data_health.updated_at;
  f.advance(1000); f.api.handlePayload({ error: "/private/path must not be shown" });
  assert.equal(latest().data_health.state, "stale");
  assert.equal(latest().recent[0].total, 42);
  assert.equal(latest().data_health.updated_at, updated);
  assert.equal(JSON.stringify(latest()).includes("/private/path"), false);
  f.api.handlePayload({ recent: [{ sid: "sid", total: 43 }] });
  assert.equal(latest().data_health.state, "fresh");
  assert.equal(latest().recent[0].total, 43);
});

test("an initial failed local query shows unavailable and schedules recovery", async () => {
  const f = fixture(); await flush();
  f.api.runQuery({ sids: ["sid"], scopes: [] });
  const proc = f.procs.at(-1);
  proc.emit("error", new Error("fixture failure"));
  const js = f.windows[0].scripts.filter(s => s.startsWith("window.__zusageUpdate")).at(-1);
  let value;
  vm.runInNewContext(js, { window: { __zusageUpdate: d => { value = d; } } });
  assert.equal(value.data_health.state, "unavailable");
  assert.equal(value.data_health.updated_at, 0);
  assert.ok(f.timers.some(t => t.ms === 3000));
});

test("malformed snapshots fail closed instead of replacing successful readings", async () => {
  const f = fixture(); await flush();
  f.api.handlePayload({ recent: [{ sid: 'sid', total: 42 }] });
  for (const payload of [{}, [], { recent: {} }, { recent: [null] }, { recent: [], today: [] }]) {
    assert.doesNotThrow(() => f.api.handlePayload(payload));
    const js = f.windows[0].scripts.filter(s => s.startsWith('window.__zusageUpdate')).at(-1);
    let value;
    vm.runInNewContext(js, { window: { __zusageUpdate: d => { value = d; } } });
    assert.equal(value.data_health.state, 'stale');
    assert.equal(value.recent[0].total, 42);
  }
});
