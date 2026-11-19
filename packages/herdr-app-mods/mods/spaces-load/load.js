// CPU and GPU busy percent per machine, for the machine headers.
// Each probe prints "cpu <total> <idle>" (cumulative counters; busy is their
// delta between polls) and "gpu <percent>" per GPU (NVIDIA, AMD).

import { exec } from "herdr";

const LINUX = ["-c", [
  "awk 'NR==1{t=0;for(i=2;i<=9;i++)t+=$i;print \"cpu\",t,$5+$6;exit}' /proc/stat",
  "command -v nvidia-smi >/dev/null && nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits 2>/dev/null | sed 's/^/gpu /'",
  "for f in /sys/class/drm/card*/device/gpu_busy_percent; do [ -r \"$f\" ] && echo \"gpu $(cat \"$f\")\"; done",
  "true"].join("; ")];
// Windows PowerShell, UTF-16LE base64: _Total processor idle timer and nvidia-smi.
const WINDOWS = ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
  "JABQAHIAbwBnAHIAZQBzAHMAUAByAGUAZgBlAHIAZQBuAGMAZQA9ACIAUwBpAGwAZQBuAHQAbAB5AEMAbwBuAHQAaQBuAHUAZQAiADsAIAAkAHAAIAA9ACAARwBlAHQALQBDAGkAbQBJAG4AcwB0AGEAbgBjAGUAIABXAGkAbgAzADIAXwBQAGUAcgBmAFIAYQB3AEQAYQB0AGEAXwBQAGUAcgBmAE8AUwBfAFAAcgBvAGMAZQBzAHMAbwByACAAfAAgAFcAaABlAHIAZQAtAE8AYgBqAGUAYwB0ACAATgBhAG0AZQAgAC0AZQBxACAAIgBfAFQAbwB0AGEAbAAiADsAIAAiAGMAcAB1ACAAJAAoACQAcAAuAFQAaQBtAGUAcwB0AGEAbQBwAF8AUwB5AHMAMQAwADAATgBTACkAIAAkACgAJABwAC4AUABlAHIAYwBlAG4AdABQAHIAbwBjAGUAcwBzAG8AcgBUAGkAbQBlACkAIgA7ACAAaQBmACAAKABHAGUAdAAtAEMAbwBtAG0AYQBuAGQAIABuAHYAaQBkAGkAYQAtAHMAbQBpACAALQBFAHIAcgBvAHIAQQBjAHQAaQBvAG4AIABTAGkAbABlAG4AdABsAHkAQwBvAG4AdABpAG4AdQBlACkAIAB7ACAAbgB2AGkAZABpAGEALQBzAG0AaQAgAC0ALQBxAHUAZQByAHkALQBnAHAAdQA9AHUAdABpAGwAaQB6AGEAdABpAG8AbgAuAGcAcAB1ACAALQAtAGYAbwByAG0AYQB0AD0AYwBzAHYALABuAG8AaABlAGEAZABlAHIALABuAG8AdQBuAGkAdABzACAAfAAgAEYAbwByAEUAYQBjAGgALQBPAGIAagBlAGMAdAAgAHsAIAAiAGcAcAB1ACAAJABfACIAIAB9ACAAfQA="];

// Machines silent this long lose their numbers rather than show stale ones.
const STALE = 15000;
// PowerShell costs ~0.3 CPU s per probe: Windows machines are sampled at most this often.
const WINDOWS_EVERY = 6000;
// Failed probes in a row before the machine's OS is detected again (a replaced machine).
const REDETECT = 3;

function parse(stdout) {
  let cpu = null;
  const gpus = [];
  for (const line of stdout.split(/\r?\n/)) {
    const [kind, a, b] = line.trim().split(/\s+/);
    if (kind === "cpu" && Number.isFinite(+a) && Number.isFinite(+b)) cpu = { total: +a, idle: +b };
    else if (kind === "gpu" && Number.isFinite(+a)) gpus.push(+a);
  }
  return cpu ? { cpu, gpus } : null;
}

export class Load {
  constructor() {
    this.os = {};       // machine key -> "linux" | "windows"
    this.counters = {}; // machine key -> last cpu counters
    this.values = {};   // machine key -> { cpu, gpu, gpus, at }
    this.busy = new Set();
    this.failures = {}; // machine key -> failed probes in a row
    this.sampled = {};  // machine key -> when it was last probed
  }

  // m: a machine name, or null for this computer.
  get(m) {
    const v = this.values[m ?? ""];
    return v && Date.now() - v.at < STALE ? v : null;
  }

  async probe(m) {
    const on = m ?? undefined;
    const run = (os) => (os === "windows" ? exec("powershell.exe", WINDOWS, { on, timeout: 10000 })
      : exec("sh", LINUX, { on, timeout: 10000 })).then((r) => (r.code === 0 ? parse(r.stdout) : null), () => null);
    const key = m ?? "";
    if (this.os[key]) {
      const sample = await run(this.os[key]);
      this.failures[key] = sample ? 0 : (this.failures[key] ?? 0) + 1;
      if (this.failures[key] >= REDETECT) { delete this.os[key]; delete this.counters[key]; this.failures[key] = 0; }
      return sample;
    }
    for (const os of ["linux", "windows"]) {
      const sample = await run(os);
      if (sample) { this.os[key] = os; return sample; }
    }
    return null;
  }

  // Samples every machine not already being sampled; resolves when all are done.
  async poll(names) {
    const due = (key) => !this.busy.has(key)
      && !(this.os[key] === "windows" && Date.now() - (this.sampled[key] ?? 0) < WINDOWS_EVERY);
    await Promise.all(names.filter((m) => due(m ?? "")).map(async (m) => {
      const key = m ?? "";
      this.busy.add(key);
      this.sampled[key] = Date.now();
      try {
        const sample = await this.probe(m);
        if (!sample) return;
        const old = this.counters[key];
        this.counters[key] = sample.cpu;
        const total = old && sample.cpu.total - old.total, idle = old && sample.cpu.idle - old.idle;
        if (!(total > 0 && idle >= 0 && idle <= total)) return;
        const cpu = Math.round(100 * (1 - idle / total));
        const gpu = sample.gpus.length ? Math.round(Math.max(...sample.gpus)) : null;
        this.values[key] = { cpu, gpu, gpus: sample.gpus, at: Date.now() };
      } finally {
        this.busy.delete(key);
      }
    }));
  }
}
