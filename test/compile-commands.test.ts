import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { planCompileCommands, refreshCompileCommands } from "../src/navigation/compile-commands.ts";

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "compile commands "));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
async function cmake(root: string, name = "build", source = root, generator = "Ninja") {
  const build = path.join(root, name);
  await fs.mkdir(build, { recursive: true });
  await fs.writeFile(path.join(build, "CMakeCache.txt"), `CMAKE_HOME_DIRECTORY:INTERNAL=${source}\nCMAKE_GENERATOR:INTERNAL=${generator}\nCMAKE_CACHEFILE_DIR:INTERNAL=${build}\n`);
  return build;
}
const db = (build: string, tag = "old") => JSON.stringify([{ directory: build, file: "main.c", command: tag }]);

test("silent non-native skip; unconfigured and unsupported builds do not run", async t => {
  const root = await fixture(t);
  assert.deepEqual(await refreshCompileCommands(root), { status: "skipped" });
  await fs.mkdir(path.join(root, "build"));
  assert.equal((await refreshCompileCommands(root)).status, "skipped");
  await cmake(root, "build", root, "Xcode");
  assert.equal((await refreshCompileCommands(root)).status, "skipped");
});

test("default nested build, ambiguity, and explicit dangling symlink priority", async t => {
  const root = await fixture(t);
  const first = await cmake(root, "out/debug");
  const plan = await planCompileCommands(root);
  assert.ok("build" in plan);
  assert.equal(plan.build, first);
  await cmake(root, "build");
  assert.match((await refreshCompileCommands(root)).message!, /Multiple/);
  await fs.symlink(path.join(first, "compile_commands.json"), path.join(root, "compile_commands.json"));
  const selected = await planCompileCommands(root);
  assert.ok("build" in selected);
  assert.equal(selected.build, first);
  assert.equal(selected.rootMode, "symlink");
});

test("preset-style out/build directories are discovered without recursively searching source folders", async t => {
  const root = await fixture(t);
  const build = await cmake(root, "out/build/clang-debug");
  await cmake(root, "src/nested-build");
  const plan = await planCompileCommands(root);
  assert.ok("build" in plan);
  assert.equal(plan.build, build);
});

test("copy selection refreshes root; symlinks stay symlinks; paths remain individual arguments", async t => {
  const root = await fixture(t);
  const build = await cmake(root, "build with spaces");
  const database = path.join(build, "compile_commands.json");
  const target = path.join(root, "compile_commands.json");
  await fs.writeFile(database, db(build));
  await fs.copyFile(database, target);
  const runner = async (command: string, args: string[]) => {
    assert.equal(command, "cmake");
    assert.deepEqual(args, ["-S", root, "-B", build, "-DCMAKE_EXPORT_COMPILE_COMMANDS=ON"]);
    await fs.writeFile(database, db(build, "new"));
  };
  assert.equal((await refreshCompileCommands(root, { runner })).status, "refreshed");
  assert.equal(await fs.readFile(target, "utf8"), db(build, "new"));
  await fs.unlink(target);
  await fs.symlink(database, target);
  assert.equal((await refreshCompileCommands(root, { runner })).status, "refreshed");
  assert.ok((await fs.lstat(target)).isSymbolicLink());
});

test("external builds require pointer; copied caches from another workspace rejected", async t => {
  const root = await fixture(t), other = await fixture(t);
  const external = await cmake(other, "build", root);
  await fs.symlink(external, path.join(root, "build"));
  assert.equal((await refreshCompileCommands(root)).status, "skipped");
  await fs.symlink(path.join(external, "compile_commands.json"), path.join(root, "compile_commands.json"));
  assert.ok("build" in await planCompileCommands(root));
  await cmake(other, "build", other);
  assert.equal((await refreshCompileCommands(root)).status, "skipped");
});

test("stale root copies refresh despite changed and new build entries; replaced files are preserved", async t => {
  const root = await fixture(t), build = await cmake(root);
  const target = path.join(root, "compile_commands.json"), database = path.join(build, "compile_commands.json");
  await fs.writeFile(database, JSON.stringify([...JSON.parse(db(build, "new flags")), { directory: build, file: "added.c", arguments: ["cc", "added.c"] }]));
  await fs.writeFile(target, db(build, "old flags"));
  assert.equal((await refreshCompileCommands(root, { runner: async () => {} })).status, "refreshed");
  assert.equal(await fs.readFile(target, "utf8"), await fs.readFile(database, "utf8"));
  const result = await refreshCompileCommands(root, { runner: async () => {
    await fs.writeFile(database, db(build, "refreshed"));
    await fs.unlink(target);
    await fs.writeFile(target, "replacement");
  } });
  assert.equal(result.status, "unavailable");
  assert.equal(await fs.readFile(target, "utf8"), "replacement");
});

test("replacement after the final snapshot check is not overwritten during copy publication", async t => {
  const root = await fixture(t), build = await cmake(root);
  const target = path.join(root, "compile_commands.json"), database = path.join(build, "compile_commands.json");
  await fs.writeFile(target, db(build, "old"));
  await fs.writeFile(database, db(build, "fresh"));
  const probe = await fs.open(target, "r");
  const original = await probe.stat();
  const prototype = Object.getPrototypeOf(probe);
  const write = prototype.write;
  await probe.close();
  let replaced = false;
  t.mock.method(prototype, "write", async function(this: fs.FileHandle, ...args: unknown[]) {
    const current = await this.stat();
    if (!replaced && current.dev === original.dev && current.ino === original.ino) {
      replaced = true;
      const replacement = path.join(root, "replacement.json");
      await fs.writeFile(replacement, "concurrent replacement");
      await fs.rename(replacement, target);
    }
    return Reflect.apply(write, this, args);
  });
  const result = await refreshCompileCommands(root, { runner: async () => {} });
  assert.equal(replaced, true);
  assert.equal(result.status, "unavailable");
  assert.match(result.message!, /replacement was left untouched/);
  assert.equal(await fs.readFile(target, "utf8"), "concurrent replacement");
});

test("Meson metadata in arbitrary top-level builddir preserves source/build configuration", async t => {
  const root = await fixture(t), build = path.join(root, "builddir");
  await fs.mkdir(path.join(build, "meson-info"), { recursive: true });
  await fs.mkdir(path.join(build, "meson-private"));
  await fs.writeFile(path.join(build, "meson-private/coredata.dat"), "configured");
  await fs.writeFile(path.join(build, "meson-info/meson-info.json"), JSON.stringify({ directories: { source: root, build } }));
  const plan = await planCompileCommands(root);
  assert.ok("command" in plan);
  assert.equal(plan.command, "meson");
  assert.deepEqual(plan.args, ["setup", "--reconfigure", build, root]);
});

test("failures, cancellation, and concurrent root creation do not publish", async t => {
  const root = await fixture(t), build = await cmake(root);
  const target = path.join(root, "compile_commands.json");
  assert.equal((await refreshCompileCommands(root, { runner: async () => { throw new Error("configure failed"); } })).status, "unavailable");
  const controller = new AbortController();
  controller.abort();
  assert.equal((await refreshCompileCommands(root, { signal: controller.signal, runner: async () => assert.fail("must not run") })).status, "unavailable");
  const during = new AbortController();
  assert.equal((await refreshCompileCommands(root, { signal: during.signal, runner: async () => {
    await fs.writeFile(path.join(build, "compile_commands.json"), db(build));
    during.abort();
  } })).status, "unavailable");
  await assert.rejects(fs.stat(target));
  assert.equal((await refreshCompileCommands(root, { runner: async () => {
    await fs.writeFile(target, "concurrent");
  } })).status, "unavailable");
  assert.equal(await fs.readFile(target, "utf8"), "concurrent");
});

test("all directory provenance is required, including entries beyond the first chunk", async t => {
  const root = await fixture(t), build = await cmake(root), second = await cmake(root, "other-config");
  const target = path.join(root, "compile_commands.json");
  await fs.mkdir(path.join(root, "unconfigured"));
  for (const directory of [second, path.join(root, "missing"), path.join(root, "unconfigured")]) {
    const entries = Array.from({ length: 5000 }, () => JSON.parse(db(build))[0]);
    entries.push({ directory, file: "other.c", command: "cc" });
    await fs.writeFile(target, JSON.stringify(entries));
    assert.equal((await refreshCompileCommands(root, { runner: async () => assert.fail("must not run") })).status, "skipped");
  }
  await fs.writeFile(target, db(build));
  await fs.truncate(target, 33 * 1024 * 1024);
  assert.match((await refreshCompileCommands(root)).message!, /safe read limits/);
});

test("native unconfigured workspaces warn, chained links resolve, arbitrary CMake build names work", async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, "CMakeLists.txt"), "project(test)");
  assert.match((await refreshCompileCommands(root)).message!, /Configure once/);
  const build = await cmake(root, "arbitrary-config", root, "Ninja Multi-Config");
  const detected = await planCompileCommands(root);
  assert.ok("build" in detected);
  assert.equal(detected.build, build);
  await fs.writeFile(path.join(build, "compile_commands.json"), db(build));
  await fs.symlink(path.join(build, "compile_commands.json"), path.join(root, "intermediate"));
  await fs.symlink("intermediate", path.join(root, "compile_commands.json"));
  const linked = await planCompileCommands(root);
  assert.ok("build" in linked);
  assert.equal(linked.build, build);
  assert.equal(linked.rootMode, "symlink");
});

for (const tool of ["cmake", "meson"] as const) {
  test(`real ${tool} configure smoke (no compilation)`, async t => {
    if (spawnSync(tool, ["--version"]).status !== 0 || spawnSync("ninja", ["--version"]).status !== 0 || spawnSync("cc", ["--version"]).status !== 0) return t.skip("configure tools unavailable");
    const root = await fixture(t), build = path.join(root, "build");
    await fs.writeFile(path.join(root, "main.c"), "int main(void) { return 0; }\n");
    const filename = tool === "cmake" ? "CMakeLists.txt" : "meson.build";
    await fs.writeFile(path.join(root, filename), tool === "cmake" ? "cmake_minimum_required(VERSION 3.16)\nproject(smoke C)\nadd_executable(smoke main.c)\n" : "project('smoke', 'c')\nexecutable('smoke', 'main.c')\n");
    const initial = spawnSync(tool, tool === "cmake" ? ["-S", root, "-B", build, "-G", "Ninja"] : ["setup", build, root], { encoding: "utf8", timeout: 30_000 });
    assert.equal(initial.status, 0, initial.stderr);
    const result = await refreshCompileCommands(root);
    assert.equal(result.status, "refreshed", result.message);
    assert.match(await fs.readFile(path.join(root, "compile_commands.json"), "utf8"), /main\.c/);
    await assert.rejects(fs.stat(path.join(build, "smoke")));
  });
}
