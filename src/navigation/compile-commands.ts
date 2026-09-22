import { spawn } from "node:child_process";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type CompileCommandsResult = { status: "refreshed" | "skipped" | "unavailable"; message?: string };
type Snapshot = { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number };
export type CompileCommandsPlan = {
  command: "cmake" | "meson"; args: string[]; workspace: string; build: string;
  rootMode: "symlink" | "copy" | "missing"; rootSnapshot?: Snapshot;
};
export type CompileCommandsPlanningResult = CompileCommandsPlan | CompileCommandsResult;
const LIMIT = 256 * 1024;
const warning = (message: string): CompileCommandsResult => ({ status: "skipped", message });
const inside = (parent: string, child: string) => {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
};
async function stat(file: string) {
  try { return await fs.lstat(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
async function prefix(file: string): Promise<string> {
  const handle = await fs.open(file, "r");
  try {
    if (!(await handle.stat()).isFile()) throw new Error(`Not a regular file: ${file}`);
    const buffer = Buffer.alloc(LIMIT);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.toString("utf8", 0, bytesRead);
  } finally { await handle.close(); }
}
async function small(file: string) {
  const info = await fs.stat(file);
  if (!info.isFile()) throw new Error(`Not a regular configuration file: ${file}`);
  if (info.size > LIMIT) throw new Error(`Configuration exceeds read limit: ${file}`);
  return prefix(file);
}
async function candidate(workspace: string, directory: string, explicit: boolean): Promise<CompileCommandsPlan | undefined> {
  try {
    const build = await fs.realpath(directory);
    if (!explicit && !inside(workspace, build)) return;
    let source: string;
    let command: "cmake" | "meson";
    let args: string[];
    if (await stat(path.join(build, "CMakeCache.txt"))) {
      const cache = await small(path.join(build, "CMakeCache.txt"));
      const value = (key: string) => cache.match(new RegExp(`^${key}:[^=\\r\\n]+=([^\\r\\n]*)`, "m"))?.[1];
      source = await fs.realpath(value("CMAKE_HOME_DIRECTORY") ?? "\0");
      if (!["Ninja", "Ninja Multi-Config", "Unix Makefiles", "MinGW Makefiles", "MSYS Makefiles", "NMake Makefiles"].includes(value("CMAKE_GENERATOR") ?? "")) return;
      // CMake itself rejects moved caches; reject them before invoking it as well.
      const cachedBuild = value("CMAKE_CACHEFILE_DIR");
      if (cachedBuild && await fs.realpath(cachedBuild) !== build) return;
      command = "cmake";
      args = ["-S", source, "-B", build, "-DCMAKE_EXPORT_COMPILE_COMMANDS=ON"];
    } else {
      if (!(await stat(path.join(build, "meson-private", "coredata.dat")))?.isFile()) return;
      const info = JSON.parse(await small(path.join(build, "meson-info", "meson-info.json")));
      source = await fs.realpath(info.directories.source);
      if (await fs.realpath(info.directories.build) !== build) return;
      command = "meson";
      args = ["setup", "--reconfigure", build, source];
    }
    if (!inside(workspace, source)) return;
    return { command, args, workspace, build, rootMode: "missing" };
  } catch { return; }
}

/** Read-only, bounded discovery. An existing root database always takes precedence. */
export async function planCompileCommands(workspace: string): Promise<CompileCommandsPlanningResult> {
  workspace = await fs.realpath(workspace);
  const root = path.join(workspace, "compile_commands.json");
  const rootStat = await stat(root);
  if (rootStat?.isSymbolicLink()) {
    const target = await fs.realpath(root).catch(() => fs.readlink(root).then(link => path.resolve(workspace, link)));
    const plan = path.basename(target) === "compile_commands.json" ? await candidate(workspace, path.dirname(target), true) : undefined;
    return plan ? { ...plan, rootMode: "symlink", rootSnapshot: rootStat } : warning("Root compile_commands.json points to an unsupported or stale build. Configure once in that build or replace the pointer.");
  }
  if (rootStat) {
    if (!rootStat.isFile()) return warning("Root compile_commands.json is not a regular file or symlink.");
    let dirs: Set<string>;
    try { dirs = await databaseDirectories(root); }
    catch { return warning("Cannot prove root database provenance within safe read limits. Configure once, then symlink compile_commands.json to the intended build database."); }
    const plans = new Map<string, CompileCommandsPlan>();
    for (const dir of dirs) {
      let current: string;
      try { current = await fs.realpath(dir); }
      catch { return warning("Root database contains an unresolved directory. Configure once and point compile_commands.json at the intended build database."); }
      let matched = false;
      for (let depth = 0; depth < 5; depth++) {
        const plan = await candidate(workspace, current, true);
        if (plan) { plans.set(plan.build, plan); matched = true; break; }
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
      }
      if (!matched) return warning("Root database contains a directory with no supported configured build. Configure once and point compile_commands.json at the intended build database.");
    }
    if (plans.size !== 1) return warning("Cannot identify one configured build for the root database. Configure once and point compile_commands.json at the intended build database.");
    const plan = [...plans.values()][0];
    const database = path.join(plan.build, "compile_commands.json");
    if (database === root) return warning("In-source build database cannot be safely refreshed automatically.");
    // All entries establish the same build provenance, even when this copy is stale.
    return { ...plan, rootMode: "copy", rootSnapshot: rootStat };
  }
  const directories = new Set<string>();
  const common = /^(?:build(?:[-_].*)?|out|\.build|cmake-build.*)$/;
  const entries = await fs.opendir(workspace);
  let count = 0;
  for await (const entry of entries) {
    if (++count > 256) return warning("Workspace discovery limit reached. Add a compile_commands.json symlink to the intended build.");
    if ([".git", ".hg", ".svn", "node_modules", "vendor", "third_party", ".venv", "venv"].includes(entry.name)) continue;
    if (entry.isDirectory() || (entry.isSymbolicLink() && common.test(entry.name))) directories.add(path.join(workspace, entry.name));
  }
  const plans = new Map<string, CompileCommandsPlan>();
  const queue = [...directories].map(directory => ({ directory, depth: 1, descend: common.test(path.basename(directory)) }));
  let inspectedChildren = 0;
  for (const { directory, depth, descend } of queue) {
    const plan = await candidate(workspace, directory, false);
    if (plan) { plans.set(plan.build, plan); continue; }
    // Inspect arbitrary immediate directories, but recurse only under build-like roots.
    // Three levels cover common out/build/<preset> layouts without walking source trees.
    if (!descend || depth >= 3) continue;
    let canonical: string;
    try { canonical = await fs.realpath(directory); } catch { continue; }
    if (!inside(workspace, canonical) || !(await fs.stat(canonical)).isDirectory()) continue;
    const children = await fs.opendir(directory);
    for await (const child of children) {
      if (++inspectedChildren > 128) return warning("Build discovery limit reached. Select a build using a root database symlink.");
      if (!child.isDirectory() || ["node_modules", ".git", "src", "source", "vendor", "third_party", "_deps", "CMakeFiles"].includes(child.name)) continue;
      queue.push({ directory: path.join(directory, child.name), depth: depth + 1, descend: true });
    }
  }
  if (plans.size === 0) {
    if (await stat(path.join(workspace, "CMakeLists.txt")) || await stat(path.join(workspace, "meson.build"))) {
      return warning("No supported configured build found. Configure once with CMake (Ninja/Makefiles) or Meson, then retry.");
    }
    return { status: "skipped" };
  }
  if (plans.size !== 1) return warning("Multiple configured builds found. Symlink compile_commands.json to the intended build database.");
  return [...plans.values()][0];
}

// Validate the complete array one bounded entry at a time; a prefix cannot prove
// provenance for merged databases. Neither commands nor arguments are executed.
async function databaseDirectories(file: string): Promise<Set<string>> {
  const handle = await fs.open(file, "r");
  const dirs = new Set<string>();
  const fail = () => { throw new Error("Unproven database provenance"); };
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 32 * 1024 * 1024) fail();
    let phase: "start" | "first" | "entry" | "separator" | "done" = "start";
    let entry = "", depth = 0, quoted = false, escaped = false, bytes = 0;
    for await (const chunk of handle.createReadStream({ encoding: "utf8", highWaterMark: LIMIT, autoClose: false })) {
      const text = String(chunk);
      bytes += Buffer.byteLength(text);
      if (bytes > 32 * 1024 * 1024) fail();
      for (const char of text) {
        if (depth > 0) {
          entry += char;
          if (entry.length > LIMIT) fail();
          if (quoted) {
            if (escaped) escaped = false;
            else if (char === "\\") escaped = true;
            else if (char === '"') quoted = false;
          } else if (char === '"') quoted = true;
          else if (char === "{" || char === "[") depth++;
          else if (char === "}" || char === "]") depth--;
          if (depth === 0) {
            const parsed = JSON.parse(entry);
            if (typeof parsed.directory !== "string" || !path.isAbsolute(parsed.directory)) fail();
            dirs.add(parsed.directory);
            if (dirs.size > 32) fail();
            entry = "";
            phase = "separator";
          }
          continue;
        }
        if (/\s/.test(char)) continue;
        if (phase === "start" && char === "[") phase = "first";
        else if ((phase === "first" || phase === "entry") && char === "{") { entry = char; depth = 1; }
        else if ((phase === "first" || phase === "separator") && char === "]") phase = "done";
        else if (phase === "separator" && char === ",") phase = "entry";
        else fail();
      }
    }
    if (phase !== "done" || depth !== 0 || dirs.size === 0) fail();
    return dirs;
  } finally { await handle.close(); }
}

export type CompileCommandsRunner = (command: string, args: string[], options: { cwd: string; signal?: AbortSignal }) => Promise<void>;
const run: CompileCommandsRunner = (command, args, options) => new Promise((resolve, reject) => {
  options.signal?.throwIfAborted();
  const child = spawn(command, args, { cwd: options.cwd, detached: process.platform !== "win32", shell: false, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  let timedOut = false;
  const capture = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-8192); };
  child.stdout.on("data", capture); child.stderr.on("data", capture);
  const kill = () => {
    try {
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch { /* Already exited. */ }
  };
  const abort = () => { kill(); cleanup(); reject(new Error("Refresh aborted")); };
  const timeout = setTimeout(() => { timedOut = true; kill(); cleanup(); reject(new Error(`${command} timed out`)); }, 60_000);
  const cleanup = () => { clearTimeout(timeout); options.signal?.removeEventListener("abort", abort); };
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  child.once("error", error => { cleanup(); reject(error); });
  child.once("close", code => {
    cleanup();
    if (code === 0 && !timedOut) resolve();
    else reject(new Error(`${command} ${timedOut ? "timed out" : `failed (${code})`}${output ? `: ${output.trim()}` : ""}`));
  });
});
function unchanged(a: Snapshot | undefined, b: Snapshot | undefined) {
  return a === undefined ? b === undefined : b !== undefined && ["dev", "ino", "size", "mtimeMs", "ctimeMs"].every(key => a[key as keyof Snapshot] === b[key as keyof Snapshot]);
}

// Pin the original inode instead of renaming over a path that another writer may
// have replaced after our snapshot check. Cursor opens only after publication.
async function updateCopy(root: string, staged: string, expected: Snapshot | undefined, signal?: AbortSignal) {
  if ((await fs.stat(staged)).size > 32 * 1024 * 1024) throw new Error("Generated database exceeds automatic copy limit; use a symlink");
  const content = await fs.readFile(staged);
  const handle = await fs.open(root, constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const original = await handle.stat();
    if (!unchanged(expected, original) || !unchanged(expected, await stat(root))) {
      throw new Error("Root database changed during refresh; leaving it untouched");
    }
    signal?.throwIfAborted();
    // Finish once writing starts: aborting half-way would leave invalid JSON.
    for (let offset = 0; offset < content.length;) {
      const { bytesWritten } = await handle.write(content, offset, content.length - offset, offset);
      if (bytesWritten === 0) throw new Error("Could not write compilation database");
      offset += bytesWritten;
    }
    await handle.truncate(content.length);
    const current = await stat(root);
    if (!current || current.dev !== original.dev || current.ino !== original.ino) {
      throw new Error("Root database was replaced during publication; the replacement was left untouched");
    }
  } finally { await handle.close(); }
}

export async function refreshCompileCommands(workspace: string, options: {
  signal?: AbortSignal; onProgress?: (message: string) => void; runner?: CompileCommandsRunner;
} = {}): Promise<CompileCommandsResult> {
  let temporary: string | undefined;
  try {
    options.signal?.throwIfAborted();
    const plan = await planCompileCommands(workspace);
    if ("status" in plan) return plan;
    options.signal?.throwIfAborted();
    options.onProgress?.(`Refreshing compilation database with ${plan.command} in ${plan.build}`);
    await (options.runner ?? run)(plan.command, plan.args, { cwd: plan.workspace, signal: options.signal });
    options.signal?.throwIfAborted();
    const database = path.join(plan.build, "compile_commands.json");
    if (!(await fs.stat(database)).isFile()) throw new Error("Configure did not produce a compilation database");
    const root = path.join(plan.workspace, "compile_commands.json");
    if (!unchanged(plan.rootSnapshot, await stat(root))) throw new Error("Root database changed during refresh; leaving it untouched");
    if (plan.rootMode !== "symlink") {
      temporary = path.join(plan.workspace, `.compile_commands.${randomUUID()}.tmp`);
      options.signal?.throwIfAborted();
      await fs.copyFile(database, temporary, constants.COPYFILE_EXCL);
      options.signal?.throwIfAborted();
      if (plan.rootMode === "missing") {
        // link is atomic and fails rather than replacing a concurrently created file.
        await fs.link(temporary, root);
      } else {
        await updateCopy(root, temporary, plan.rootSnapshot, options.signal);
      }
    }
    return { status: "refreshed" };
  } catch (error) {
    return { status: "unavailable", message: `Compilation database refresh failed: ${error instanceof Error ? error.message : String(error)}` };
  } finally { if (temporary) await fs.unlink(temporary).catch(() => {}); }
}
