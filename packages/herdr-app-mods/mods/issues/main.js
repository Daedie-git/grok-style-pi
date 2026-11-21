// Herdr Issues panel: a view over the coordinator. It keeps no authoritative state.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea, TextView, Popover } from "gpui-base";
import { spaces, panes, exec, hc, run, theme, shared, setShared, layout, home, machines, checking } from "herdr";

const FILTERS = { open: ["draft", "planning", "awaiting_approval", "queued", "implementing", "human_review", "finishing", "failed", "blocked"], done: ["done", "cancelled"], all: null };
const ROLES = ["planner", "coordinator", "implement", "verify", "review"];
const LIVE_ATTEMPT = ["dispatching", "accepted", "running"];

/** A model starting with claude- runs in Claude Code and takes its effort levels; any other runs in Pi. */
const harness = (model) => (model ?? "").startsWith("claude-") ? "claude" : "pi";
const thinkingFor = (stages, model) => stages?.thinking?.[harness(model)] ?? [];
const modelLabel = (model) => (model ?? "?").split("/").at(-1).replace(/^claude-/, "");
/** Keep the thinking level when the new model's harness has it, else the role's default, else a middle level. */
function snapThinking(stages, model, thinking, fallback) {
  const levels = thinkingFor(stages, model);
  if (!levels.length || levels.includes(thinking)) return thinking;
  if (levels.includes(fallback)) return fallback;
  return levels.includes("high") ? "high" : levels[Math.floor(levels.length / 2)];
}

/** The CLI that reaches the local coordinator; override with shared("herdr-issues.command"). */
function command() {
  const c = shared("herdr-issues.command");
  return Array.isArray(c) && c.length ? c : ["herdr-issues"];
}

async function resolveLauncher(program, cwd) {
  if (!program) return null;
  const windows = /^[A-Za-z]:[\\/]|^\\\\/.test(home());
  const script = windows
    ? `$p='${program.replace(/'/g, "''")}'; if ($p -notmatch '[\\\\/]') { $p=(Get-Command -Name $p -CommandType Application -ErrorAction Stop).Source }; $item=Get-Item -LiteralPath $p -Force -ErrorAction Stop; while ($item.Target) { $p=@($item.Target)[0]; if (![IO.Path]::IsPathRooted($p)) { $p=Join-Path $item.DirectoryName $p }; $item=Get-Item -LiteralPath $p -Force -ErrorAction Stop }; $item.FullName`
    : 'p=$(command -v "$1") || exit 1; while [ -L "$p" ]; do t=$(readlink "$p") || exit 1; case "$t" in /*) p=$t;; *) p=$(dirname "$p")/$t;; esac; done; d=$(CDPATH= cd -P "$(dirname "$p")" && pwd) || exit 1; printf "%s/%s\\n" "$d" "$(basename "$p")"';
  const args = windows ? ["-NoProfile", "-Command", script] : ["-c", script, "resolve-launcher", program];
  const result = await exec(windows ? "powershell" : "sh", args, { cwd, timeout: 10000 }).catch(() => null);
  if (!result || result.code !== 0 || !result.stdout.trim()) return null;
  return windows ? result.stdout.trim().toLowerCase() : result.stdout.trim();
}

/** Share startup attempts across copies; the service itself enforces the writer lock. */
let startedAt = null, startup = null;
function startCoordinator() {
  if (startedAt !== null && Date.now() - startedAt < 20000) return startup;
  startedAt = Date.now();
  const [prog, ...pre] = command();
  startup = (async () => {
    const name = "herdr-issues-coordinator";
    const existing = await hc(["get", name, "--json"]);
    if (existing.code === 0) {
      const terminal = JSON.parse(existing.stdout);
      if (terminal.finished_ms != null || ["exited", "signaled", "killed"].includes(terminal.state)) {
        const removed = await hc(["rm", terminal.address, "--json"]);
        if (removed.code !== 0) return { terminal: null, output: removed.stderr.trim() || removed.stdout.trim() };
      } else {
        const argv = terminal.argv ?? [], expected = [prog, ...pre];
        const launcher = await resolveLauncher(prog);
        const owner = await resolveLauncher(argv[0], terminal.cwd);
        const sameProgram = launcher !== null && launcher === owner;
        if (sameProgram && pre.every((arg, i) => argv[i + 1] === arg) && ["service", "coordinator"].includes(argv[expected.length])) {
          return { terminal: terminal.address, output: "Issues service is already starting" };
        }
        return { terminal: null, output: `Cannot start Issues: foreign live terminal ${name} (${terminal.address}) runs ${argv[0] ?? "another program"}; close or rename it first.` };
      }
    }
    // --keep would replace a signal-crashed service with a shell owning this name.
    const r = await hc(["run", "--bg", "--no-parent", "--no-notify", "--json", "--name", name, "--", prog, ...pre, "service"]);
    let terminal = null;
    try { terminal = JSON.parse(r.stdout).address; } catch { /* startup output is shown on failure */ }
    return { terminal, output: r.stderr.trim() || r.stdout.trim() || `exit ${r.code}` };
  })().catch((e) => ({ terminal: null, output: String(e) }));
  return startup;
}

async function request(cmd) {
  const [prog, ...pre] = command();
  try {
    const r = await exec(prog, [...pre, "request", "--json", JSON.stringify(cmd)], { timeout: 120000 });
    const line = r.stdout.trim().split("\n").at(-1);
    return line ? JSON.parse(line) : { ok: false, error: { code: "request_failed", message: r.stderr.trim() || `exit ${r.code}` } };
  } catch (e) {
    return { ok: false, error: { code: "coordinator_offline", message: String(e) } };
  }
}

const WATCH_SECONDS = 300;
async function watchBatch(since) {
  const [prog, ...pre] = command();
  let r;
  try { r = await exec(prog, [...pre, "watch", "--since", String(since), "--timeout", String(WATCH_SECONDS)], { timeout: 600000 }); }
  catch (e) { return { error: { code: "coordinator_offline", message: String(e) } }; }
  try {
    const reply = JSON.parse(r.stdout.trim().split("\n").at(-1) || "null");
    if (reply?.error) return reply;
    if (!Array.isArray(reply?.events) || !Number.isSafeInteger(reply.next)) throw new Error(r.stderr.trim() || "invalid watch reply");
    return reply;
  } catch (e) {
    return { error: { code: "watch_failed", message: r.stderr.trim() || String(e) } };
  }
}

/** layout.hide retains the view: stop on the close button and resume only when shown again. */
function panelVisible() {
  const find = (node, hidden = false) => {
    if (!node || typeof node !== "object") return null;
    hidden ||= !!node.hidden;
    if (node.id === "panel") return !hidden;
    for (const child of [...(node.children ?? []), ...(node.floating ?? [])]) {
      const visible = find(child, hidden);
      if (visible !== null) return visible;
    }
    return null;
  };
  const tree = layout();
  return find(tree?.root ?? tree) !== false;
}

/** The active space's repository: where its first terminal is now, on its machine. */
function location() {
  const space = spaces().find((s) => s.active);
  if (!space) return null;
  const first = space.tabs[0] && panes().find((p) => p.tab === space.tabs[0].id && p.terminal);
  return { machine: space.machine ?? null, cwd: first?.cwd || space.folder || null };
}

const short = (s, n = 12) => (s ?? "").slice(0, n);

export default class Issues extends View {
  init(_props, cx) {
    this.repo = null; // { state, repoId, name, machine, root, head }
    this.repoKey = null;
    this.locationKey = undefined; this.generation = 0; this.snapshotGeneration = 0;
    this.closed = false; this.paused = false; this.watching = false; this.watchFailures = 0; this.watchError = null; this.readinessFailures = 0;
    this.revision = null; this.connected = false; this.connecting = null; this.connectionState = null; this.connectionError = null;
    this.retryDelays = new Set();
    this.list = null; this.detail = null; this.error = null; this.stale = false; this.offline = false;
    this.filter = "open"; this.drafts = {}; this.busy = false; this.confirm = null; this.generated = null; this.creating = false;
    this.title = InputState.new({ placeholder: "Issue title" });
    this.body = TextareaState.new({ placeholder: "What should change, and why", rows: 4 });
    this.reply = TextareaState.new({ placeholder: "Reply to the planner", rows: 3 });
    this.reviseTitle = InputState.new({ placeholder: "Title" });
    this.reviseBody = TextareaState.new({ placeholder: "Revised specification", rows: 5 });
    this.revising = null; // { issueId, version }: the version the form's text was read from
    this.sendBack = TextareaState.new({ placeholder: "What should the coordinator change?", rows: 3 });
    this.answers = new Map(); // `${issueId}:${key}` → TextareaState for an open attention item
    this.resolvedOpen = false;
    this.stages = null; // status.stages: { models, thinking: { claude, pi }, defaults }
    this.modelsOpen = false; this.stageEdit = null; this.picker = null;
    // Session launches: `${attemptId}:${launch}` → acknowledged; this view never launches one twice.
    this.launched = new Map(); this.sessionRun = false; this.sessionAgain = false; this.sessionsWaiting = 0;
    this.createdSpaces = new Map(); this.deferredSpaces = new Set();
    this.reconcile(cx);
    this.startWatching(cx);
  }

  /** Drafts per checkout (machine and root), so a first issue typed before registration survives a workspace switch. */
  draft() { return this.repoKey && this.repo?.root ? (this.drafts[this.repoKey] ??= { title: "", body: "", reply: "", sendBack: "", stages: {}, selected: null }) : null; }
  saveDraft() {
    const d = this.draft();
    if (d) { d.title = this.title.value(); d.body = this.body.value(); d.reply = this.reply.value(); d.sendBack = this.sendBack.value(); }
  }

  active() { return !this.closed && !this.paused; }
  current(key, generation) { return this.active() && this.repoKey === key && this.generation === generation; }

  close() { this.stop(true); }
  stop(permanent = false) {
    this.saveDraft();
    this.closed ||= permanent; this.paused = true;
    for (const delay of this.retryDelays) { delay.timer.cancel(); delay.resolve(); }
    this.retryDelays.clear();
  }

  reconnectDelay(cx, ms) {
    return new Promise((resolve) => {
      const delay = { resolve, timer: null };
      this.retryDelays.add(delay);
      delay.timer = cx.timer.after(ms, () => { this.retryDelays.delete(delay); resolve(); });
    });
  }

  ready(cx) {
    if (!this.active()) return Promise.resolve(false);
    if (this.connected) return Promise.resolve(true);
    if (!this.connecting) this.connecting = this.reconnect(cx).finally(() => { this.connecting = null; });
    return this.connecting.then((ready) => ready || !this.active() || this.connectionState !== null || this.readinessFailures > 0 ? ready : this.ready(cx));
  }

  seedRevision(revision) {
    if (this.revision === null && Number.isSafeInteger(revision) && revision >= 0) this.revision = revision;
  }

  async reconnect(cx) {
    const resuming = this.offline || this.readinessFailures > 0 || this.connectionState === "error";
    const status = await request({ type: "status" });
    if (!this.active()) return false;
    if (status.ok) {
      this.seedRevision(status.result?.revision);
      if (status.result?.stages) this.stages = status.result.stages;
      this.connected = true; this.offline = false; this.connectionState = null; this.connectionError = null; this.readinessFailures = 0;
      if (resuming) this.reconcile(cx, true);
      this.requestSessions(cx);
      cx.notify();
      return true;
    }
    if (status.error.code !== "coordinator_offline") {
      const code = status.error.code, ownerHome = status.error.details?.home ?? "the configured service home";
      const incompatible = ["unknown_command", "protocol_mismatch"].includes(code);
      this.offline = false; this.stale = true;
      if (!incompatible) this.readinessFailures++;
      this.connectionState = incompatible || this.readinessFailures >= 6 ? "error" : null;
      this.connectionError = incompatible
        ? `An incompatible coordinator owns ${ownerHome}; stop it before starting Issues (${code}: ${status.error.message}).`
        : this.readinessFailures >= 6 ? `Could not reach the Issues service: ${code}: ${status.error.message}` : null;
      cx.notify();
      return false;
    }
    this.offline = true; this.stale = true; this.readinessFailures++;
    this.connectionState = "starting"; cx.notify();
    const started = await startCoordinator();
    if (!this.active()) return false;
    let output = started.output;
    if (started.terminal) {
      const last = await hc(["read", started.terminal, "--lines", "30"]).catch((e) => ({ stdout: "", stderr: String(e) }));
      if (!this.active()) return false;
      output = last.stdout.trim() || last.stderr.trim() || output;
    }
    this.connectionState = this.readinessFailures >= 6 ? "error" : "starting";
    this.connectionError = this.readinessFailures >= 6 ? `Could not start the Issues service: ${status.error.message}\n${output}` : null;
    cx.notify();
    return false;
  }

  async read(cmd, cx) {
    if (!await this.ready(cx)) return null;
    let reply = await request(cmd);
    if (reply.error?.code === "coordinator_offline") {
      this.connected = false;
      if (!await this.ready(cx)) return null;
      reply = await request(cmd);
    }
    return reply;
  }

  startWatching(cx) {
    if (!this.active() || this.watching) return;
    this.watching = true;
    cx.spawn(async (cx) => {
      let changed = false, resync = false;
      try {
        while (this.active()) {
          if (!await this.ready(cx)) {
            if (!this.active()) break;
            const delay = this.readinessFailures > 0 ? Math.min(1000 * 2 ** Math.min(this.readinessFailures - 1, 5), 30000) : 30000;
            await this.reconnectDelay(cx, delay);
            continue;
          }
          this.revision ??= 0;
          const batch = await watchBatch(this.revision);
          if (!this.active()) break;
          if (batch.error) {
            this.connected = false;
            this.watchFailures++;
            this.watchError = `${batch.error.code}: ${batch.error.message}`;
            if (this.connectionState !== "error") this.connectionError = this.watchFailures >= 6 ? `Issues watch keeps failing: ${this.watchError}` : null;
            cx.notify();
            const delay = Math.min(1000 * 2 ** Math.min(this.watchFailures - 1, 5), 30000);
            await this.reconnectDelay(cx, delay);
            continue;
          }
          this.watchFailures = 0; this.watchError = null;
          this.revision = batch.next;
          if (batch.events.some((e) => e?.type === "session.launch_requested")) this.requestSessions(cx);
          changed ||= batch.events.length > 0; resync ||= !!batch.resync;
          if (batch.more) continue;
          if (resync) this.reconcile(cx, true);
          else if (changed) {
            if (this.repo?.state === "registered") await this.loadIssues(this.repoKey, this.generation, cx);
            else if (this.repo?.state === "unregistered") await this.load({ cwd: this.repo.toplevel ?? this.repo.root, machine: this.repo.machineName }, this.generation, cx);
            else this.reconcile(cx, true);
          }
          if (this.active() && (resync || changed)) cx.notify();
          changed = false; resync = false;
        }
      } finally { this.watching = false; }
    });
  }

  /** Host changes invalidate snapshots, but never replace the view's watch or its cursor. */
  reconcile(cx, force = false) {
    if (!this.active()) return;
    const loc = location(), hostKey = JSON.stringify(loc);
    if (!force && this.locationKey === hostKey) return;
    this.locationKey = hostKey;
    const generation = ++this.generation;
    this.switchRepo({ state: loc?.cwd ? "loading" : "none" }, `pending:${hostKey}`);
    cx.spawn(async (cx) => {
      await this.load(loc, generation, cx);
      if (this.active()) cx.notify();
    });
  }

  async load(loc, generation, cx) {
    if (!loc?.cwd) return;
    // A linked worktree (such as a task's) shares its repository's issues, which belong to the
    // main worktree. Only a linked worktree's git dir is <common dir>/worktrees/<name>; there,
    // `git worktree list` names the main worktree first. All four are asked at once.
    const git = (args, cwd = loc.cwd) => exec("git", args, { cwd, on: loc.machine }).catch(() => null);
    const [top, gitDir, common, list] = await Promise.all([
      git(["rev-parse", "--show-toplevel"]), git(["rev-parse", "--git-dir"]),
      git(["rev-parse", "--git-common-dir"]), git(["worktree", "list", "--porcelain"]),
    ]);
    if (!this.active() || this.generation !== generation) return;
    if (!top || top.code !== 0) return this.switchRepo({ state: "none", reason: "not a git checkout" }, `none:${loc.cwd}`);
    const toplevel = line(top.stdout);
    const linked = gitDir?.code === 0 && /[\\/]worktrees[\\/][^\\/]+$/.test(line(gitDir.stdout));
    let main = linked && list?.code === 0 ? mainWorktree(list.stdout) : "";
    if (main && main !== toplevel) {
      // Only a candidate git confirms: a checkout whose toplevel is itself and that shares our
      // common git dir. A metadata dir, a misparsed path or another repository fails this.
      const [mainTop, mainCommon] = await Promise.all([git(["rev-parse", "--show-toplevel"], main), git(["rev-parse", "--git-common-dir"], main)]);
      if (!this.active() || this.generation !== generation) return;
      const same = mainTop?.code === 0 && line(mainTop.stdout) === main && mainCommon?.code === 0 && common?.code === 0
        && absolute(line(mainCommon.stdout), main) === absolute(line(common.stdout), toplevel);
      if (!same) main = "";
    }
    let root = toplevel;
    let res = await this.read({ type: "repo.resolve", machine: loc.machine, path: toplevel }, cx);
    if (!res || !this.active() || this.generation !== generation) return;
    // A worktree registered on its own (before worktrees shared issues) keeps its board.
    // Otherwise, when its own lookup succeeded without a board (unregistered, or a worktree
    // nested inside the main checkout), it shows the main worktree's, but only a board that
    // already exists: a candidate is never registered on the strength of this guess.
    if (main && main !== toplevel && res.ok && ["unregistered", "ambiguous"].includes(res.result.state)) {
      const shared = await this.read({ type: "repo.resolve", machine: loc.machine, path: main }, cx);
      if (!shared || !this.active() || this.generation !== generation) return;
      // A failed lookup is an error, not "no board": creating here would split the board.
      if (!shared.ok || shared.result.state === "registered") { root = main; res = shared; }
    }
    const key = `${loc.machine ?? ""}|${root}`;
    if (!res.ok) {
      this.switchRepo({ state: "error", root }, key);
      this.stale = true; this.error = res.error.message;
      return;
    }
    this.switchRepo({ ...res.result, root, toplevel, machineName: loc.machine }, key);
    if (res.result.state !== "registered") { this.list = { issues: [] }; return; }
    await this.loadIssues(key, generation, cx);
  }

  switchRepo(repo, key) {
    if (this.repoKey === key) { this.repo = { ...this.repo, ...repo }; return; }
    this.saveDraft();
    this.repoKey = key; this.repo = repo; this.list = null; this.detail = null; this.confirm = null; this.generated = null; this.error = null; this.actionError = null; this.stale = false; this.busy = false; this.stageEdit = null; this.picker = null;
    const d = this.draft();
    this.title.set_value(d?.title ?? ""); this.body.set_value(d?.body ?? ""); this.reply.set_value(d?.reply ?? ""); this.sendBack.set_value(d?.sendBack ?? "");
  }

  async loadIssues(key, generation, cx) {
    if (!this.current(key, generation) || this.repo?.state !== "registered") return;
    const repoId = this.repo.repoId, snapshot = ++this.snapshotGeneration;
    const sel = this.draft()?.selected;
    const current = () => this.current(key, generation) && this.snapshotGeneration === snapshot && this.draft()?.selected === sel;
    const list = await this.read({ type: "issue.list", repoId }, cx);
    if (!list || !current()) return;
    if (!list.ok) { this.stale = true; this.error = list.error.message; return; }
    let detail = null;
    if (sel) {
      const d = await this.read({ type: "issue.get", repoId, issueId: sel }, cx);
      if (!d || !current()) return;
      if (d.ok) detail = d.result; else this.draft().selected = null;
    }
    this.seedRevision(list.result.revision);
    this.list = list.result; this.setDetail(detail); this.stale = false; this.error = null;
    this.publishAttention(list.result.issues ?? []);
  }

  /** Shows an issue, creating the answer box for each open attention item now: text state can't be created during render. */
  setDetail(detail) {
    this.detail = detail;
    for (const a of detail?.attention ?? []) {
      const id = `${detail.issue.id}:${a.key}`;
      if (a.state === "open" && !this.answers.has(id)) this.answers.set(id, TextareaState.new({ placeholder: a.kind === "notice" ? "Reply (optional)" : "Your answer", rows: 2 }));
    }
  }

  /**
   * For the Issues button's badge: open attention counts per board under shared
   * "herdr-issues.attention" (keyed `machine|board root`), and under "herdr-issues.boards" which
   * board each checkout shows (`machine|toplevel` → that key), so a tab never has to guess.
   */
  publishAttention(issues) {
    const machine = this.repo.machineName ?? "", key = `${machine}|${this.repo.root}`;
    const boards = { ...(shared("herdr-issues.boards") ?? {}) }, checkout = `${machine}|${this.repo.toplevel ?? this.repo.root}`;
    if (boards[checkout] !== key) { boards[checkout] = key; setShared("herdr-issues.boards", boards); }
    const sum = (field) => issues.reduce((n, i) => n + (i.attention?.[field] ?? 0), 0);
    const counts = { open: sum("open"), waiting: sum("waiting") };
    const all = { ...(shared("herdr-issues.attention") ?? {}) };
    if (JSON.stringify(all[key] ?? { open: 0, waiting: 0 }) === JSON.stringify(counts)) return;
    if (counts.open) all[key] = counts; else delete all[key];
    setShared("herdr-issues.attention", all);
  }

  /** Every mutation carries the repository and issue it was made from, never the current focus. */
  act(cx, cmd, after) {
    const key = this.repoKey, generation = this.generation;
    this.busy = true; this.actionError = null; cx.notify();
    cx.spawn(async (cx) => {
      const r = await request(cmd);
      if (this.current(key, generation)) {
        this.busy = false;
        if (!r.ok) this.actionError = `${r.error.code}: ${r.error.message}`;
        else {
          if (r.result?.issue && r.result.issue.repo_id === this.repo?.repoId) this.setDetail(r.result);
          after?.(r.result);
          await this.loadIssues(key, generation, cx);
        }
      }
      if (r.error?.code === "coordinator_offline" && this.active()) { this.connected = false; await this.ready(cx); }
      if (this.active()) cx.notify();
    });
  }

  select(cx, issueId) {
    const d = this.draft();
    if (d) d.selected = issueId;
    this.detail = null; this.confirm = null; this.generated = null;
    this.refreshNow(cx);
  }

  refreshNow(cx) {
    const key = this.repoKey, generation = this.generation;
    cx.spawn(async (cx) => { await this.loadIssues(key, generation, cx); if (this.active()) cx.notify(); });
  }

  create(cx) {
    const title = this.title.value().trim(), body = this.body.value();
    if (!title) { this.actionError = "Give the issue a title"; return cx.notify(); }
    const key = this.repoKey, generation = this.generation, target = { ...this.repo };
    const stages = this.stageOverrides();
    this.busy = true; this.actionError = null; cx.notify();
    cx.spawn(async (cx) => {
      try {
        let repoId = target.repoId;
        if (target.state !== "registered") {
          // First issue in this checkout: register it now.
          const r = await request({ type: "repo.ensure", machine: target.machineName, path: target.root });
          if (!r.ok) throw r.error;
          if (this.current(key, generation)) this.repo = { ...this.repo, ...r.result };
          repoId = r.result.repoId;
        }
        const r = await request({ type: "issue.create", repoId, title, body, ...(stages ? { stages } : {}), idempotencyKey: `create-${repoId}-${Date.now()}` });
        if (!r.ok) throw r.error;
        if (this.current(key, generation)) {
          // Stage overrides belong to the issue just made, never to the next one.
          this.title.set_value(""); this.body.set_value(""); this.creating = false; this.modelsOpen = false;
          const d = this.draft(); if (d) { d.title = ""; d.body = ""; d.stages = {}; d.selected = r.result.issueId; }
          await this.loadIssues(key, generation, cx);
        }
      } catch (e) {
        if (this.current(key, generation)) this.actionError = e?.code ? `${e.code}: ${e.message}` : String(e?.message ?? e);
        if (e?.code === "coordinator_offline" && this.active()) { this.connected = false; await this.ready(cx); }
      } finally { if (this.current(key, generation)) this.busy = false; if (this.active()) cx.notify(); }
    });
  }

  /** The new-issue form's stage for a role: the configured default with this checkout's picks over it. */
  newStage(role) { return { ...this.stages?.defaults?.[role], ...this.draft()?.stages?.[role] }; }
  /** Only the roles the person changed from the defaults, each as a complete {model, thinking}; null when none. */
  stageOverrides() {
    const picks = this.draft()?.stages ?? {}, out = {};
    for (const role of ROLES) if (picks[role]) out[role] = this.newStage(role);
    return Object.keys(out).length ? out : null;
  }
  pickNewStage(role, stage) {
    const d = this.draft(), base = this.stages?.defaults?.[role];
    if (!d) return;
    if (base && base.model === stage.model && base.thinking === stage.thinking) delete d.stages[role];
    else d.stages[role] = { model: stage.model, thinking: stage.thinking };
  }

  /** One session.requests pass at a time; a request made meanwhile runs once more afterwards. */
  requestSessions(cx) {
    if (!this.active() || checking()) return; // herdr-app check runs init for real: never open sessions there
    if (this.sessionRun) { this.sessionAgain = true; return; }
    this.sessionRun = true;
    cx.spawn(async (cx) => {
      try {
        do { this.sessionAgain = false; await this.fulfilSessions(cx); } while (this.sessionAgain && this.active());
      } finally { this.sessionRun = false; }
    });
  }

  /** The service cannot open tabs: open each requested planner or coordinator session in the person's Spaces. */
  async fulfilSessions(cx) {
    const r = await this.read({ type: "session.requests" }, cx);
    if (!r?.ok || !this.active()) return;
    let waiting = 0;
    for (const q of r.result?.requests ?? []) {
      if (!this.active()) return;
      const key = `${q.attemptId}:${q.launch}`;
      if (!this.launched.has(key)) {
        const opened = this.launchSession(q);
        if (opened === "waiting") waiting++;
        if (opened !== "opened") continue;
        this.launched.set(key, false);
      }
      if (this.launched.get(key)) continue;
      const ack = await request({ type: "session.launched", attemptId: q.attemptId, launch: q.launch, space: q.spaceName });
      // stale or conflict: another copy of the panel (or an earlier pass) already reported it.
      if (ack.ok || ["stale", "conflict"].includes(ack.error?.code)) this.launched.set(key, true);
    }
    if (this.sessionsWaiting !== waiting) { this.sessionsWaiting = waiting; cx.notify(); }
  }

  /** "opened", "waiting" (its machine is unavailable), or "deferred" (a space this view just made has not appeared yet). */
  launchSession(q) {
    const machine = q.machine ?? null, spaceKey = `${machine ?? ""}|${q.spaceName}`;
    if (machine && machines().find((m) => m.name === machine)?.layout !== "ready") return "waiting";
    const space = spaces().find((s) => s.name === q.spaceName && (s.machine ?? null) === machine);
    const made = this.createdSpaces.get(spaceKey);
    if (!space && made !== undefined && Date.now() - made < 15000) { this.deferredSpaces.add(spaceKey); return "deferred"; }
    const name = q.role === "coordinator" ? "Coordinator" : "Planner";
    try {
      if (space) run("tab.new", { space: space.id, name, folder: q.folder, argv: q.argv, focus: false });
      else {
        run("space.new", { name: q.spaceName, tab: name, folder: q.folder, machine: machine ?? "", argv: q.argv, focus: false });
        this.createdSpaces.set(spaceKey, Date.now());
      }
    } catch (e) {
      console.warn(`Issues: could not open ${q.spaceName}: ${e}`);
      return "waiting";
    }
    return "opened";
  }

  /** Focus a session's agent by terminal, else show its space. */
  openSession(cx, terminal, spaceName) {
    if (terminal) return run("agent.focus", { terminal });
    const space = spaces().find((s) => s.name === spaceName);
    if (space) run("space.select", { id: space.id });
    else { this.actionError = `Space ${spaceName} is not open`; cx.notify(); }
  }

  dropdown(t, id, value, options, label, onPick) {
    return Popover.new(id).anchor("top_left").open(this.picker === id)
      .on_open_change((open, cx) => { this.picker = open ? id : this.picker === id ? null : this.picker; cx.notify(); })
      .trigger(div().px(6).py(1).rounded(5).text_size(12).border_1().border_color(t.border).bg(t.raised).child(`${label(value)} ▾`))
      .content(v_flex().p(4).gap(1).rounded(6).border_1().border_color(t.border).bg(t.popover).children(options.map((o) =>
        div().id(`${id}:${o}`).px(8).py(2).rounded(4).text_size(12).bg(o === value ? t.selected : t.popover).hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { this.picker = null; if (!this.busy && o !== value) onPick(o, cx); cx.notify(); }).child(label(o)))));
  }

  /** One row per role: a model and a thinking dropdown. A model of the other harness snaps thinking to one it has. */
  stageRows(t, prefix, stageOf, onPick) {
    const st = this.stages;
    return v_flex().gap(4).children(ROLES.map((role) => {
      const value = stageOf(role), fallback = st?.defaults?.[role]?.thinking;
      const models = st?.models?.includes(value.model) ? st.models : [value.model, ...(st?.models ?? [])];
      const levels = thinkingFor(st, value.model), thinking = levels.includes(value.thinking) ? levels : [value.thinking, ...levels];
      return h_flex().gap(6).items_center()
        .child(div().w(84).text_size(12).text_color(t.muted).child(role))
        .child(this.dropdown(t, `${prefix}-${role}-model`, value.model, models, modelLabel,
          (model, cx) => onPick(cx, role, { model, thinking: snapThinking(st, model, value.thinking, fallback) })))
        .child(this.dropdown(t, `${prefix}-${role}-thinking`, value.thinking, thinking, String,
          (level, cx) => onPick(cx, role, { model: value.model, thinking: level })));
    }));
  }

  startPlanning(cx, s) {
    const repoId = s.issue.repo_id, issueId = s.issue.id, version = s.issue.version;
    const root = this.repo.root, on = this.repo.machineName, key = this.repoKey, generation = this.generation;
    this.busy = true; cx.notify();
    cx.spawn(async (cx) => {
      const head = await exec("git", ["rev-parse", "HEAD"], { cwd: root, on }).catch(() => null);
      if (!this.current(key, generation)) return;
      this.busy = false;
      if (!head || head.code !== 0) { this.actionError = "cannot read the checkout's HEAD"; cx.notify(); return; }
      this.act(cx, { type: "issue.plan", repoId, issueId, expectedVersion: version, baseCommit: head.stdout.trim() });
    });
  }

  render(cx) {
    const resumed = this.paused && !this.closed && panelVisible();
    if (resumed) { this.paused = false; this.locationKey = undefined; this.connectionState = null; }
    this.reconcile(cx);
    this.startWatching(cx);
    // Requests wait while the panel is hidden; a deferred one goes on once the space this view made appears.
    const appeared = [...this.deferredSpaces].some((k) => spaces().some((s) => `${s.machine ?? ""}|${s.name}` === k));
    if (appeared) this.deferredSpaces.clear();
    if ((resumed && this.connected) || appeared) this.requestSessions(cx);
    const t = theme();
    const chip = (text, color) => div().px(6).py(1).rounded(5).text_size(11).text_color(color ?? t.muted).border_1().border_color(t.border).child(text);
    const button = (id, label, onClick, primary) => div().id(id).px(10).py(4).rounded(6).text_size(12)
      .bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground)
      .when(!this.busy, (el) => el.hover((s) => s.bg(primary ? t.accent : t.hover)).on_click((_e, cx) => onClick(cx)))
      .child(label);
    const section = (title) => div().pt(10).pb(4).text_size(11).text_color(t.dim).child(title.toUpperCase());

    const header = h_flex().gap(8).items_center().pb(8).border_b_1().border_color(t.border)
      .child(div().flex_1().truncate().font_semibold().child(this.repo?.name ?? (this.repo?.root ? this.repo.root.split(/[\\/]/).at(-1) : "Issues")))
      .when(this.offline, (el) => el.child(chip("coordinator offline", t.blocked)))
      .when(this.stale && !this.offline, (el) => el.child(chip("stale", t.blocked)))
      .child(button("close", "×", () => { this.stop(); run("layout.hide", { id: "panel" }); }));

    const root = v_flex().id("root").size_full().bg(t.surface).p(10).text_size(13).text_color(t.foreground).child(header);
    const state = this.repo?.state;
    if (this.connectionState === "error") return root.child(div().pt(12).text_color(t.blocked).child(this.connectionError ?? "Issues service is unavailable"));
    if (this.connectionState === "starting") return root.child(div().pt(12).text_color(t.muted).child("Starting…"));
    if (!this.repo || state === "none") return root.child(div().pt(12).text_color(t.muted).child("Not a git repository"));
    if (state === "loading") return root.child(div().pt(12).text_color(t.muted).child("Loading…"));
    if (state === "ambiguous") return root.child(div().pt(12).text_color(t.muted).child(`Ambiguous repository: ${this.repo.reason}`));
    if (state !== "registered" && state !== "unregistered") return root.child(div().pt(12).text_color(t.blocked).child(this.error ?? "Unavailable"));

    const body = v_flex().flex_1().min_h(0).overflow_y_scrollbar().id("scroll");
    if (this.connectionError) body.child(div().py(6).text_color(t.blocked).child(this.connectionError));
    if (this.actionError) body.child(div().py(6).text_color(t.blocked).child(this.actionError));
    if (this.error) body.child(div().py(6).text_color(t.blocked).child(this.error));
    if (this.sessionsWaiting) body.child(div().py(4).text_size(12).text_color(t.muted).child(`${this.sessionsWaiting} session${this.sessionsWaiting === 1 ? "" : "s"} waiting to open (machine unavailable)`));
    body.child(this.detail ? this.renderDetail(cx, t, chip, button, section) : this.renderList(t, chip, button, section));
    return root.child(body);
  }

  renderList(t, chip, button, section) {
    const filter = FILTERS[this.filter];
    const issues = (this.list?.issues ?? []).filter((i) => !filter || filter.includes(i.state));
    const v = v_flex().gap(2);
    v.child(h_flex().gap(6).pt(8).children(Object.keys(FILTERS).map((f) =>
      div().id(`f-${f}`).px(8).py(2).rounded(5).text_size(12).bg(this.filter === f ? t.selected : t.surface).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { this.filter = f; cx.notify(); }).child(f)))
      .child(div().flex_1()).child(button("new", this.creating ? "Close" : "New issue", (cx) => { this.creating = !this.creating; cx.notify(); })));
    if (this.creating) {
      v.child(v_flex().gap(6).py(8)
        .child(div().h(30).px(8).flex().items_center().rounded(6).border_1().border_color(t.input).bg(t.background).child(Input.new(this.title).h_full()))
        .child(div().px(8).py(4).rounded(6).border_1().border_color(t.input).bg(t.background).child(Textarea.new(this.body).h(80)))
        .when(!!this.stages?.defaults, (el) => {
          const changed = Object.keys(this.draft()?.stages ?? {}).length;
          el.child(div().id("models").text_size(12).text_color(t.muted).hover((s) => s.text_color(t.foreground))
            .on_click((_e, cx) => { this.modelsOpen = !this.modelsOpen; cx.notify(); })
            .child(`${this.modelsOpen ? "▾" : "▸"} Models${changed ? ` (${changed} changed)` : ": defaults"}`));
          return this.modelsOpen ? el.child(this.stageRows(t, "new", (role) => this.newStage(role), (cx, role, stage) => { this.pickNewStage(role, stage); cx.notify(); })) : el;
        })
        .child(h_flex().child(button("create", "Create draft", (cx) => this.create(cx), true))));
    }
    if (!this.list) return v.child(div().pt(8).text_color(t.muted).child("Loading…"));
    if (!issues.length) v.child(div().pt(8).text_color(t.muted).child("No issues"));
    for (const i of issues) {
      v.child(v_flex().id(`i-${i.id}`).px(6).py(6).rounded(6).hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.select(cx, i.id))
        .child(h_flex().gap(6).items_center().child(div().flex_1().truncate().child(i.title))
          .when(i.attention?.open > 0, (el) => el.child(chip(`${i.attention.open} need${i.attention.open === 1 ? "s" : ""} you`, i.attention.waiting > 0 ? t.blocked : t.accent)))
          .child(chip(i.state.replace("_", " "), stateColor(t, i.state))))
        .when(!!i.queue_reason, (el) => el.child(div().text_size(11).text_color(t.dim).truncate().child(i.queue_reason)))
        .when(i.cleanup.length > 0, (el) => el.child(h_flex().gap(4).pt(2).children(i.cleanup.map((c) => chip(c.replace("_", " ")))))));
    }
    return v;
  }

  renderDetail(cx, t, chip, button, section) {
    const s = this.detail, i = s.issue, repoId = i.repo_id, issueId = i.id, v = i.version;
    const plan = s.planRevisions.find((p) => p.id === i.plan_revision_id);
    const out = v_flex().gap(4).pt(8);
    out.child(h_flex().gap(6).items_center()
      .child(button("back", "←", (cx) => { this.draft().selected = null; this.detail = null; cx.notify(); }))
      .child(div().flex_1().font_semibold().truncate().child(i.title))
      .child(chip(i.state.replace("_", " "), stateColor(t, i.state))));
    const approved = !!(i.approval_id || s.approval), policy = i.policy ?? {};
    const stagesEditable = i.stages && this.stages && (i.state === "draft" || (["planning", "awaiting_approval", "blocked"].includes(i.state) && !approved));
    out.child(div().text_size(11).text_color(t.dim).child(`spec ${i.spec_revision} · ${i.workflow_id}@${i.workflow_version} · v${v}`));
    if (i.stages) out.child(h_flex().gap(6).items_center()
      .child(div().flex_1().text_size(11).text_color(t.dim).child(ROLES.filter((r) => i.stages[r]).map((r) => `${r} ${modelLabel(i.stages[r].model)} ${i.stages[r].thinking}`).join(" · ")))
      .when(!!stagesEditable, (el) => el.child(button("edit-stages", this.stageEdit === issueId ? "Done" : "Models…", (cx) => { this.stageEdit = this.stageEdit === issueId ? null : issueId; cx.notify(); }))));
    else out.child(div().text_size(11).text_color(t.dim).child(`${i.model} (${i.thinking})`));
    if (stagesEditable && this.stageEdit === issueId)
      out.child(this.stageRows(t, `issue-${issueId}`, (role) => i.stages[role], (cx, role, stage) =>
        this.act(cx, { type: "issue.set_stages", repoId, issueId, expectedVersion: v, stages: { [role]: stage } })));
    if (i.queue_reason) out.child(div().text_size(12).text_color(t.blocked).child(i.queue_reason));
    if (i.body) out.child(TextView.markdown(`body-${issueId}`, i.body));

    const actions = h_flex().gap(6).pt(6).flex_wrap();
    if (i.state === "draft") actions.child(button("plan", "Plan", (cx) => this.startPlanning(cx, s), true));
    if (i.state === "awaiting_approval" && plan && !plan.unauthorizedChanges.length)
      actions.child(button("approve", `Approve ${short(plan.hash, 8)} @ ${short(plan.base_commit, 8)}`, (cx) =>
        this.act(cx, { type: "plan.approve", repoId, issueId, expectedVersion: v, planRevisionId: plan.id, planHash: plan.hash }), true));
    if (i.state === "failed" && i.approvalValid) actions.child(button("retry", "Retry", (cx) => this.act(cx, { type: "issue.retry", repoId, issueId, expectedVersion: v })));
    if (["awaiting_approval", "blocked"].includes(i.state) && !approved) actions.child(button("restart", "New planning session", (cx) => this.act(cx, { type: "plan.restart", repoId, issueId, expectedVersion: v })));
    if (!["done", "cancelled", "draft"].includes(i.state) && this.revising?.issueId !== issueId)
      actions.child(button("revise", "Revise…", (cx) => { this.revising = { issueId, version: v }; this.reviseTitle.set_value(i.title); this.reviseBody.set_value(i.body); cx.notify(); }));
    if (!["done", "cancelled"].includes(i.state)) actions.child(button("cancel", "Cancel issue", (cx) => this.act(cx, { type: "issue.cancel", repoId, issueId, expectedVersion: v })));
    out.child(actions);
    this.renderAttention(out, t, chip, button, section, s);
    const coordinator = [...s.attempts].reverse().find((a) => a.role === "coordinator" && LIVE_ATTEMPT.includes(a.state));
    if (i.state === "implementing") out.child(h_flex().gap(6).items_center().pt(6)
      .child(div().flex_1().text_color(t.working).child(`Coordinator running${i.coordination?.branch ? ` on ${i.coordination.branch}` : ""}${i.coordination?.machine ? ` (${i.coordination.machine})` : ""}`))
      .when(!!(coordinator?.terminal || coordinator?.space), (el) => el.child(button("open-coordinator", "Open", (cx) => this.openSession(cx, coordinator.terminal, coordinator.space)))));
    if (i.state === "finishing") out.child(div().pt(6).text_color(t.working).child(`Delivering: ${policy.done ?? "the repository's done action"}`));
    if (i.state === "human_review") this.renderReview(out, t, section, button, s, policy);
    // Send back continues the coordinator's conversation; it needs an implemented approved plan.
    if (i.state === "human_review" || (["failed", "blocked"].includes(i.state) && approved && i.coordination)) {
      out.child(section("Send back"))
        .child(div().px(8).py(4).rounded(6).border_1().border_color(t.input).bg(t.background).child(Textarea.new(this.sendBack).h(60)))
        .child(h_flex().child(button("send-back", "Send back", (cx) => {
          const instructions = this.sendBack.value().trim();
          if (!instructions) { this.actionError = "Say what should change"; return cx.notify(); }
          this.act(cx, { type: "issue.send_back", repoId, issueId, expectedVersion: v, instructions }, () => { this.sendBack.set_value(""); });
        })));
    }
    if (this.revising?.issueId === issueId) {
      // Saving creates a new specification revision: approval is invalidated and running work is asked to stop.
      out.child(v_flex().gap(6).py(6)
        .child(div().text_size(12).text_color(t.muted).child("Saving invalidates the approval and supersedes earlier results; a running attempt is asked to stop."))
        .child(div().h(30).px(8).flex().items_center().rounded(6).border_1().border_color(t.input).bg(t.background).child(Input.new(this.reviseTitle).h_full()))
        .child(div().px(8).py(4).rounded(6).border_1().border_color(t.input).bg(t.background).child(Textarea.new(this.reviseBody).h(100)))
        .child(h_flex().gap(6)
          .child(button("save-revision", "Save revision", (cx) => this.act(cx, { type: "issue.revise", repoId, issueId, expectedVersion: this.revising.version, title: this.reviseTitle.value().trim() || i.title, body: this.reviseBody.value() }, () => { this.revising = null; }), true))
          .child(button("cancel-revision", "Keep current", (cx) => { this.revising = null; cx.notify(); }))));
    }

    if (plan) {
      const c = plan.content;
      out.child(section(`Plan revision ${short(plan.hash, 8)}`));
      if (plan.unauthorizedChanges.length) out.child(div().text_color(t.blocked).child(`Planning changed its checkout: ${plan.unauthorizedChanges.join(", ")}`));
      out.child(TextView.markdown(`plan-${plan.id}`, [c.summary, c.plan,
        c.questions?.length ? `**Questions**\n${c.questions.map((q) => `- ${q}`).join("\n")}` : "",
        c.scope?.length ? `**Scope**: ${c.scope.join(", ")}` : "",
        c.dependencies?.length ? `**Dependencies**: ${c.dependencies.join(", ")}` : "",
        c.verification?.length ? `**Verification**\n${c.verification.map((q) => `- \`${q}\``).join("\n")}` : ""].filter(Boolean).join("\n\n")));
    }

    if (s.messages.length) {
      out.child(section("Discussion"));
      for (const m of s.messages) out.child(v_flex().py(4).child(div().text_size(11).text_color(t.dim).child(`${m.author} · ${m.ts.slice(0, 16).replace("T", " ")}`)).child(TextView.markdown(`m-${m.id}`, m.content)));
    }
    if (["planning", "awaiting_approval", "blocked"].includes(i.state) && !approved) {
      out.child(div().px(8).py(4).rounded(6).border_1().border_color(t.input).bg(t.background).child(Textarea.new(this.reply).h(60)))
        .child(h_flex().child(button("send", "Send reply", (cx) => {
          const content = this.reply.value().trim();
          if (content) this.act(cx, { type: "plan.reply", repoId, issueId, expectedVersion: v, content }, () => { this.reply.set_value(""); });
        })));
    }

    out.child(section("Attempts"));
    for (const a of [...s.attempts].reverse()) {
      const wt = a.worktree;
      const row = v_flex().py(4).border_t_1().border_color(t.border)
        .child(h_flex().gap(6).items_center().child(div().flex_1().child(`${a.role ?? a.kind} on ${a.machine}${a.space ? ` · ${a.space}` : ""}`)).child(chip(a.state.replace("_", " "), stateColor(t, a.state)))
          .when(!!a.superseded, (el) => el.child(chip("superseded")))
          .when(!!a.reservation, (el) => el.child(chip(`reservation ${a.reservation.state}`))))
        .when(!!a.reconcile_reason, (el) => el.child(div().text_size(12).text_color(t.blocked).child(a.reconcile_reason)))
        .when(!!a.receipt?.reason, (el) => el.child(div().text_size(12).text_color(t.muted).child(a.receipt.reason)))
        .when(!!a.terminal, (el) => el.child(div().text_size(11).text_color(t.dim).child(`terminal ${a.terminal}`)));
      const btns = h_flex().gap(6).pt(4).flex_wrap();
      if (LIVE_ATTEMPT.includes(a.state) && (a.terminal || a.space))
        btns.child(button(`open-${a.id}`, "Open", (cx) => this.openSession(cx, a.terminal, a.space)));
      if (["dispatching", "accepted", "running", "needs_reconcile"].includes(a.state) && !a.cancel_requested)
        btns.child(button(`stop-${a.id}`, "Cancel attempt", (cx) => this.act(cx, { type: "attempt.cancel", repoId, issueId, attemptId: a.id })));
      if (a.state === "needs_reconcile")
        btns.child(button(`abandon-${a.id}`, "Abandon (worker confirmed stopped)", (cx) => this.act(cx, { type: "attempt.abandon", repoId, issueId, attemptId: a.id })));
      if (wt && !["removed", "removed_archived", "none"].includes(wt.cleanup_state)) {
        row.child(div().text_size(12).text_color(t.muted).child(`worktree ${wt.cleanup_state.replace("_", " ")}${wt.cleanup_reason ? `: ${wt.cleanup_reason}` : ""}`));
        if (wt.path) row.child(div().text_size(11).text_color(t.dim).truncate().child(`${wt.path}${wt.branch ? ` (${wt.branch})` : ""}${wt.observed_head ? ` @ ${short(wt.observed_head)}` : ""}`));
        btns.child(button(`inspect-${a.id}`, "Inspect", (cx) => this.act(cx, { type: "cleanup.inspect", repoId, issueId, attemptId: a.id }, (r) => {
          this.generated = r.generated?.paths.length ? { attemptId: a.id, ...r.generated } : null;
        })));
        const g = this.generated?.attemptId === a.id ? this.generated : null;
        if (g) {
          row.child(div().text_size(12).text_color(t.foreground).pt(4).child(`Generated outputs recorded by this run, unchanged: ${g.paths.slice(0, 5).join(", ")}${g.paths.length > 5 ? ` and ${g.paths.length - 5} more` : ""}`));
          btns.child(button(`clear-${a.id}`, `Remove ${g.paths.length} generated output${g.paths.length === 1 ? "" : "s"}`, (cx) => this.act(cx, { type: "cleanup.clear_generated", repoId, issueId, attemptId: a.id, token: g.token }, () => { this.generated = null; })));
        }
        // Also offered when archive_ready: archiving again yields a fresh confirmation after a reload.
        if (a.kind === "implement" && a.state === "succeeded" && !(wt.cleanup_state === "archive_ready" && this.confirm?.attemptId === a.id))
          btns.child(button(`archive-${a.id}`, "Archive and Remove…", (cx) => this.act(cx, { type: "cleanup.archive", repoId, issueId, attemptId: a.id }, (r) => { if (r.confirm) this.confirm = { attemptId: a.id, ...r.confirm }; })));
        if (wt.cleanup_state === "archive_ready" && this.confirm?.attemptId === a.id) {
          const c = this.confirm;
          row.child(div().text_size(12).text_color(t.foreground).pt(4).child(`Archived and verified ${short(c.head)}. Remove ${c.path} and branch ${c.branch}?`));
          btns.child(button(`confirm-${a.id}`, "Confirm removal", (cx) => this.act(cx, { type: "cleanup.confirm", repoId, issueId, attemptId: a.id, token: c.token }, () => { this.confirm = null; }), true));
        }
      }
      out.child(row.child(btns));
    }
    return out;
  }

  /** What the issue needs from the person: open attention items first, with their controls, then the closed ones. */
  renderAttention(out, t, chip, button, section, s) {
    const items = s.attention ?? [], i = s.issue;
    const open = items.filter((a) => a.state === "open"), closed = items.filter((a) => a.state !== "open");
    if (!items.length) return;
    const send = (cx, type, a, extra = {}) => this.act(cx, { type, repoId: i.repo_id, issueId: i.id, key: a.key, ...extra }, () => this.answers.get(`${i.id}:${a.key}`)?.set_value(""));
    if (open.length) out.child(section(`Needs you (${open.length})`));
    for (const a of open) {
      const id = `${i.id}:${a.key}`;
      const answer = this.answers.get(id);
      if (!answer) continue; // its box is made when the issue loads
      const item = v_flex().gap(4).p(6).mb(4).rounded(6).border_1().border_color(a.waiting ? t.blocked : t.border)
        .child(h_flex().gap(6).items_center()
          .child(chip(a.kind, a.kind === "notice" ? t.muted : t.accent))
          .child(div().flex_1().font_semibold().child(a.title))
          .when(!!a.waiting, (el) => el.child(chip("waiting", t.blocked))))
        .when(!!a.detail, (el) => el.child(TextView.markdown(`att-${id}`, a.detail)))
        .when(a.role === "planner", (el) => el.child(div().text_size(11).text_color(t.dim).child("from the planner: answering asks for a revised plan")));
      if (a.kind === "decision")
        item.child(h_flex().gap(6).flex_wrap().children((a.options ?? []).map((o, n) =>
          button(`att-opt-${id}-${n}`, o === a.recommendation ? `${o} (recommended)` : o, (cx) => send(cx, "attention.answer", a, { option: o, answer: answer.value().trim() }), o === a.recommendation))));
      item.child(div().px(8).py(4).rounded(6).border_1().border_color(t.input).bg(t.background).child(Textarea.new(answer).h(44)));
      const controls = h_flex().gap(6);
      if (a.kind === "notice") controls.child(button(`att-ack-${id}`, "Acknowledge", (cx) => send(cx, "attention.acknowledge", a), true));
      controls.child(button(`att-answer-${id}`, a.kind === "notice" ? "Reply" : "Answer", (cx) => {
        const text = answer.value().trim();
        if (!text) { this.actionError = "Write an answer"; return cx.notify(); }
        send(cx, "attention.answer", a, { answer: text });
      }, a.kind === "question"));
      out.child(item.child(controls));
    }
    if (closed.length) {
      out.child(div().id("att-resolved").pt(4).text_size(12).text_color(t.muted).hover((st) => st.text_color(t.foreground))
        .on_click((_e, cx) => { this.resolvedOpen = !this.resolvedOpen; cx.notify(); })
        .child(`${this.resolvedOpen ? "▾" : "▸"} Resolved (${closed.length})`));
      if (this.resolvedOpen) for (const a of closed)
        out.child(v_flex().py(2).text_size(12)
          .child(h_flex().gap(6).child(chip(a.state, a.state === "superseded" ? t.dim : t.done)).child(div().flex_1().child(a.title)))
          .when(!!a.answer || !!a.answered_by, (el) => el.child(div().pl(8).text_color(t.muted).child(`${a.answered_by ? `${a.answered_by}: ` : ""}${a.answer ?? "acknowledged"}`))));
    }
  }

  /** The coordinator's review: what it produced, how each phase went, and what the repository asks of the person. */
  renderReview(out, t, section, button, s, policy) {
    const r = s.issue.review;
    out.child(section("Review"));
    if (policy.humanReview) out.child(div().text_size(12).text_color(t.muted).child(`Review: ${policy.humanReview}`));
    if (!r) out.child(div().text_color(t.muted).child("No review reported yet"));
    if (r?.summary) out.child(TextView.markdown(`review-${s.issue.id}`, r.summary));
    if (r?.url) {
      const web = /^https?:\/\/[^/\s]+/.test(r.url);
      out.child(h_flex().gap(6).items_center()
        .child(TextView.markdown(`review-url-${s.issue.id}`, `\`${r.url.replace(/`/g, "")}\``).selectable(true).flex_1())
        .when(web, (el) => el.child(button("open-review", "Open", (cx) => cx.open_url(r.url)))));
    }
    if (r?.head) out.child(div().text_size(11).text_color(t.dim).child(`head ${short(r.head)}`));
    for (const p of r?.phases ?? [])
      out.child(h_flex().gap(6).text_size(12).child(div().text_color(p.passed ? t.done : t.blocked).child(`${p.passed ? "✓" : "✗"} ${p.name}`))
        .when(!!p.detail, (el) => el.child(div().flex_1().text_color(t.muted).child(p.detail))));
    const i = s.issue;
    out.child(div().pt(4).text_size(12).text_color(t.muted).child(`Accept will: ${policy.done ?? "archive the branch and remove the worktree"}`))
      .child(h_flex().pt(4).child(button("accept", acceptLabel(s.attention), (cx) => this.act(cx, { type: "issue.accept", repoId: i.repo_id, issueId: i.id, expectedVersion: i.version }), true)));
    return out;
  }
}

/** One path printed by git: only its trailing newline is not part of it. */
const line = (stdout) => stdout.replace(/\r?\n$/, "");

/** A path git printed relative to `base` (as `--git-common-dir` can), made absolute. */
function absolute(path, base) {
  if (/^(\/|[A-Za-z]:[\\/])/.test(path)) return path.replace(/[\\/]+$/, "");
  return `${base.replace(/[\\/]+$/, "")}/${path}`.replace(/[\\/]\.\/?$/, "").replace(/[\\/]+$/, "");
}

/**
 * The main worktree from `git worktree list --porcelain`, whose first record it always is; ""
 * when there is none to use: a bare repository, or a path that is not plainly absolute.
 */
function mainWorktree(stdout) {
  const record = stdout.split(/\r?\n\r?\n/)[0].split(/\r?\n/);
  const path = record[0]?.startsWith("worktree ") ? record[0].slice("worktree ".length) : "";
  if (record.includes("bare") || !/^(\/|[A-Za-z]:[\\/])/.test(path)) return "";
  return path;
}

/** Accept stays possible with open items, but says so. */
function acceptLabel(items) {
  const open = (items ?? []).filter((a) => a.state === "open").length;
  return open ? `Accept (${open} open item${open === 1 ? "" : "s"})` : "Accept";
}

function stateColor(t, state) {
  return ({ human_review: t.accent, finishing: t.working, done: t.done, succeeded: t.done, implementing: t.working, planning: t.working, running: t.working, queued: t.working,
    awaiting_approval: t.accent, failed: t.blocked, blocked: t.blocked, needs_reconcile: t.blocked, cancelled: t.dim })[state] ?? t.muted;
}
