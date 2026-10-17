// Evaluated by run_node, locally or over SSH. `args[0]` is JSON; `text` arrives on stdin with this program.
(async () => {
  const options = JSON.parse(args[0]);
  const dir = path.join(os.homedir(), '.cache', 'claude-sidecar', 'windows', options.session);
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const read = file => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  };
  const fail = (message, code = 1) => { console.error(`sidecar: ${message}`); process.exit(code); };
  const owner = read(path.join(dir, 'owner.json'));
  if (!owner || owner.pid !== options.pid) {
    fail('Windows control receiver does not match the process in this Herdr pane; reload the sidecar extension in its pane before retrying (nothing was sent)');
  }
  let ack;
  const check = () => {
    const current = read(path.join(dir, 'owner.json'));
    if (current?.token !== owner.token) {
      if (options.action === 'reload' && ack) {
        const receipt = read(ack);
        if (receipt?.token === owner.token && receipt.status === 'accepted') return { status: 'reloading' };
      }
      fail('Windows sidecar owner changed; inspect the pane before resending');
    }
    try { process.kill(owner.pid, 0); }
    catch (error) { if (error.code !== 'EPERM') fail('Windows sidecar process exited'); }
    const state = read(path.join(dir, 'status.json'));
    if (state?.token !== owner.token || Date.now() - state.updated > 15000) {
      fail('Windows sidecar control heartbeat is missing or stale; inspect the pane before resending');
    }
    if (state.status === 'error') fail('Windows sidecar control failed; inspect its pane');
    return state;
  };
  if (options.action === 'status') { console.log(JSON.stringify(check())); return; }
  if (options.action === 'wait') {
    for (;;) {
      const state = check();
      if (state.status === 'blocked') fail('sidecar is blocked on an approval or question in its pane', 5);
      if (state.status === 'idle') return;
      await sleep(250);
    }
  }
  if (check().status === 'blocked') fail('sidecar is blocked on an approval or question in its pane', 5);
  const id = require('node:crypto').randomUUID();
  const file = path.join(dir, `${id}.inbox`), tmp = `${file}.tmp`;
  ack = path.join(dir, `${id}.ack`);
  fs.writeFileSync(tmp, JSON.stringify({ token: owner.token, text, action: options.action }));
  fs.renameSync(tmp, file);
  const start = Date.now();
  const timeout = options.timeout || 10000;
  let accepted = false, nextProgress = start + options.progress * 1000;
  while (true) {
    const receipt = read(ack);
    // Reload may already have replaced the old owner; this receipt confirms only command submission.
    if (options.action === 'reload' && receipt?.token === owner.token && receipt.status === 'accepted') {
      fs.rmSync(ack, { force: true });
      return;
    }
    const state = check();
    if (receipt && receipt.token !== owner.token) fail('Windows delivery receipt belongs to another process');
    if (receipt?.status === 'rejected') fail(receipt.reason);
    accepted ||= ['accepted', 'seen', 'settled'].includes(receipt?.status);
    if (accepted && options.action === 'steer') {
      console.log(receipt.status === 'accepted' ? 'queued: Windows sidecar accepted the steering message' : 'steered: delivered into the Windows sidecar conversation');
      fs.rmSync(ack, { force: true });
      return;
    }
    // The report is the completion contract, independent of Herdr's status or the turn's final chat text.
    if (options.report && fs.existsSync(options.report)) {
      fs.rmSync(ack, { force: true });
      return;
    }
    if (receipt?.status === 'settled') {
      fs.rmSync(ack, { force: true });
      if (options.action === 'note') return;
      // Launcher prints its standard no-report diagnosis.
      process.exit(2);
    }
    if (state.status === 'blocked') fail('sidecar is blocked on an approval or question in its pane', 5);
    if (!accepted && Date.now() - start > timeout) {
      try { fs.unlinkSync(file); fail('Windows sidecar did not pick up the message; withdrawn and safe to resend', 4); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      fail('Windows delivery outcome unknown; message was claimed but not acknowledged, so do not resend blindly', 6);
    }
    if (options.progress > 0 && Date.now() >= nextProgress) {
      console.error(`sidecar: ${options.requestId || options.action} still working (${Math.floor((Date.now() - start) / 1000)}s; Windows runtime ${receipt?.status || 'awaiting delivery'})`);
      nextProgress = Date.now() + options.progress * 1000;
    }
    await sleep(250);
  }
})().catch(error => { console.error(`sidecar: Windows control failed: ${error}`); process.exit(1); });
