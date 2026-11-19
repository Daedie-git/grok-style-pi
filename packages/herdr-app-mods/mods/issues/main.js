// Herdr Issues panel: a view over the coordinator. It keeps no authoritative state.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea, TextView } from "gpui-base";
import { spaces, panes, exec, hc, run, theme, shared, layout, home } from "herdr";

const FILTERS = { open: ["draft", "planning", "awaiting_approval", "queued", "implementing", "review", "failed", "blocked"], done: ["done", "cancelled"], all: null };

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
    this.reconcile(cx);
    this.startWatching(cx);
  }

  /** Drafts per checkout (machine and root), so a first issue typed before registration survives a workspace switch. */
  draft() { return this.repoKey && this.repo?.root ? (this.drafts[this.repoKey] ??= { title: "", body: "", reply: "", selected: null }) : null; }
  saveDraft() {
    const d = this.draft();
    if (d) { d.title = this.title.value(); d.body = this.body.value(); d.reply = this.reply.value(); }
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
      this.connected = true; this.offline = false; this.connectionState = null; this.connectionError = null; this.readinessFailures = 0;
      if (resuming) this.reconcile(cx, true);
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
          changed ||= batch.events.length > 0; resync ||= !!batch.resync;
          if (batch.more) continue;
          if (resync) this.reconcile(cx, true);
          else if (changed) {
            if (this.repo?.state === "registered") await this.loadIssues(this.repoKey, this.generation, cx);
            else if (this.repo?.state === "unregistered") await this.load({ cwd: this.repo.root, machine: this.repo.machineName }, this.generation, cx);
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
    const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: loc.cwd, on: loc.machine }).catch(() => null);
    if (!this.active() || this.generation !== generation) return;
    if (!top || top.code !== 0) return this.switchRepo({ state: "none", reason: "not a git checkout" }, `none:${loc.cwd}`);
    const root = top.stdout.trim(), key = `${loc.machine ?? ""}|${root}`;
    const res = await this.read({ type: "repo.resolve", machine: loc.machine, path: root }, cx);
    if (!res || !this.active() || this.generation !== generation) return;
    if (!res.ok) {
      this.switchRepo({ state: "error", root }, key);
      this.stale = true; this.error = res.error.message;
      return;
    }
    this.switchRepo({ ...res.result, root, machineName: loc.machine }, key);
    if (res.result.state !== "registered") { this.list = { issues: [] }; return; }
    await this.loadIssues(key, generation, cx);
  }

  switchRepo(repo, key) {
    if (this.repoKey === key) { this.repo = { ...this.repo, ...repo }; return; }
    this.saveDraft();
    this.repoKey = key; this.repo = repo; this.list = null; this.detail = null; this.confirm = null; this.generated = null; this.error = null; this.actionError = null; this.stale = false; this.busy = false;
    const d = this.draft();
    this.title.set_value(d?.title ?? ""); this.body.set_value(d?.body ?? ""); this.reply.set_value(d?.reply ?? "");
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
    this.list = list.result; this.detail = detail; this.stale = false; this.error = null;
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
          if (r.result?.issue && r.result.issue.repo_id === this.repo?.repoId) this.detail = r.result;
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
        const r = await request({ type: "issue.create", repoId, title, body, idempotencyKey: `create-${repoId}-${Date.now()}` });
        if (!r.ok) throw r.error;
        if (this.current(key, generation)) {
          this.title.set_value(""); this.body.set_value(""); this.creating = false;
          const d = this.draft(); if (d) { d.title = ""; d.body = ""; d.selected = r.result.issueId; }
          await this.loadIssues(key, generation, cx);
        }
      } catch (e) {
        if (this.current(key, generation)) this.actionError = e?.code ? `${e.code}: ${e.message}` : String(e?.message ?? e);
        if (e?.code === "coordinator_offline" && this.active()) { this.connected = false; await this.ready(cx); }
      } finally { if (this.current(key, generation)) this.busy = false; if (this.active()) cx.notify(); }
    });
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
    if (this.paused && !this.closed && panelVisible()) { this.paused = false; this.locationKey = undefined; this.connectionState = null; }
    this.reconcile(cx);
    this.startWatching(cx);
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
        .child(h_flex().child(button("create", "Create draft", (cx) => this.create(cx), true))));
    }
    if (!this.list) return v.child(div().pt(8).text_color(t.muted).child("Loading…"));
    if (!issues.length) v.child(div().pt(8).text_color(t.muted).child("No issues"));
    for (const i of issues) {
      v.child(v_flex().id(`i-${i.id}`).px(6).py(6).rounded(6).hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.select(cx, i.id))
        .child(h_flex().gap(6).items_center().child(div().flex_1().truncate().child(i.title)).child(chip(i.state.replace("_", " "), stateColor(t, i.state))))
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
    out.child(div().text_size(11).text_color(t.dim).child(`spec ${i.spec_revision} · ${i.workflow_id}@${i.workflow_version} · ${i.model} (${i.thinking}) · v${v}`));
    if (i.queue_reason) out.child(div().text_size(12).text_color(t.blocked).child(i.queue_reason));
    if (i.body) out.child(TextView.markdown(`body-${issueId}`, i.body));

    const actions = h_flex().gap(6).pt(6).flex_wrap();
    if (i.state === "draft") actions.child(button("plan", "Plan", (cx) => this.startPlanning(cx, s), true));
    if (i.state === "awaiting_approval" && plan && !plan.unauthorizedChanges.length)
      actions.child(button("approve", `Approve ${short(plan.hash, 8)} @ ${short(plan.base_commit, 8)}`, (cx) =>
        this.act(cx, { type: "plan.approve", repoId, issueId, expectedVersion: v, planRevisionId: plan.id, planHash: plan.hash }), true));
    if (i.state === "review") actions.child(button("accept", "Accept", (cx) => this.act(cx, { type: "issue.accept", repoId, issueId, expectedVersion: v }), true));
    if (i.state === "failed" && i.approvalValid) actions.child(button("retry", "Retry", (cx) => this.act(cx, { type: "issue.retry", repoId, issueId, expectedVersion: v })));
    if (["awaiting_approval", "blocked"].includes(i.state)) actions.child(button("restart", "New planning session", (cx) => this.act(cx, { type: "plan.restart", repoId, issueId, expectedVersion: v })));
    if (!["done", "cancelled", "draft"].includes(i.state) && this.revising?.issueId !== issueId)
      actions.child(button("revise", "Revise…", (cx) => { this.revising = { issueId, version: v }; this.reviseTitle.set_value(i.title); this.reviseBody.set_value(i.body); cx.notify(); }));
    if (!["done", "cancelled"].includes(i.state)) actions.child(button("cancel", "Cancel issue", (cx) => this.act(cx, { type: "issue.cancel", repoId, issueId, expectedVersion: v })));
    out.child(actions);
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
    if (["awaiting_approval", "blocked"].includes(i.state)) {
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
        .child(h_flex().gap(6).items_center().child(div().flex_1().child(`${a.kind} on ${a.machine}`)).child(chip(a.state.replace("_", " "), stateColor(t, a.state)))
          .when(!!a.superseded, (el) => el.child(chip("superseded")))
          .when(!!a.reservation, (el) => el.child(chip(`reservation ${a.reservation.state}`))))
        .when(!!a.reconcile_reason, (el) => el.child(div().text_size(12).text_color(t.blocked).child(a.reconcile_reason)))
        .when(!!a.receipt?.reason, (el) => el.child(div().text_size(12).text_color(t.muted).child(a.receipt.reason)))
        .when(!!a.terminal, (el) => el.child(div().text_size(11).text_color(t.dim).child(`terminal ${a.terminal}`)));
      const btns = h_flex().gap(6).pt(4).flex_wrap();
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
}

function stateColor(t, state) {
  return ({ review: t.done, done: t.done, succeeded: t.done, implementing: t.working, planning: t.working, running: t.working, queued: t.working,
    awaiting_approval: t.accent, failed: t.blocked, blocked: t.blocked, needs_reconcile: t.blocked, cancelled: t.dim })[state] ?? t.muted;
}
