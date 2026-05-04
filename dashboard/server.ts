import { Database } from 'bun:sqlite';
import { existsSync, readdirSync, readFileSync, appendFileSync, openSync, readSync, closeSync, statSync } from 'fs';
import path from 'path';
import http from 'http';

const DATA_DIR          = process.env.DATA_DIR          || '/data';
const LOGS_DIR          = process.env.LOGS_DIR          || '/logs';
const PORT              = parseInt(process.env.DASHBOARD_PORT || '3100');
const HOST_PROC         = process.env.HOST_PROC         || '/host/proc';
const HOST_ETC          = process.env.HOST_ETC          || '/host/etc';
const CLAUDE_PROJECTS   = process.env.CLAUDE_PROJECTS_DIR || '/host/claude-projects';
const ANSI_RE           = /\x1b\[[0-9;]*m/g;
const CONTEXT_WINDOW    = 200000; // Claude model context window (tokens)
const COMPACT_THRESHOLD = 165000; // Claude Code auto-compact trigger

// ─── Unix socket HTTP helper ─────────────────────────────────────────────────

function unixGet(socketPath: string, urlPath: string, timeoutMs = 5000, extraHeaders: Record<string, string> = {}): Promise<unknown> {
  if (!existsSync(socketPath)) return Promise.resolve(null);
  const request = new Promise<unknown>(resolve => {
    const req = http.request(
      { socketPath, method: 'GET', path: urlPath, headers: { Host: 'localhost', ...extraHeaders } },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch { resolve(null); } });
      },
    );
    req.on('error', () => resolve(null));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null); });
    req.end();
  });
  const timer = new Promise<null>(resolve => setTimeout(() => resolve(null), timeoutMs + 500));
  return Promise.race([request, timer]);
}

const dockerGet  = (p: string) => unixGet('/var/run/docker.sock', p);
const tailscaleGet = (p: string) => unixGet('/var/run/tailscale/tailscaled.sock', p, 3000, { Host: 'local-tailscaled.sock' });
const snapGet    = (p: string) => unixGet('/run/snapd.socket', p, 5000);

// ─── SQLite helpers ──────────────────────────────────────────────────────────

function openCentral(): Database | null {
  const p = path.join(DATA_DIR, 'v2.db');
  if (!existsSync(p)) return null;
  try { return new Database(p, { readonly: true }); } catch { return null; }
}
function q<T = Record<string, unknown>>(db: Database, sql: string): T[] {
  try { return db.query(sql).all() as T[]; } catch { return []; }
}
function qSession<T = Record<string, unknown>>(dbPath: string, sql: string): T[] {
  if (!existsSync(dbPath)) return [];
  let db: Database | null = null;
  try { db = new Database(dbPath, { readonly: true }); return db.query(sql).all() as T[]; }
  catch { return []; }
  finally { try { db?.close(); } catch {} }
}

// ─── Host /proc helpers ──────────────────────────────────────────────────────

function readHost(rel: string): string {
  try { return readFileSync(path.join(HOST_PROC, rel), 'utf-8'); } catch { return ''; }
}
function readHostEtc(rel: string): string {
  try { return readFileSync(path.join(HOST_ETC, rel), 'utf-8'); } catch { return ''; }
}
function readHostFile(abs: string): string {
  try { return readFileSync(abs, 'utf-8'); } catch { return ''; }
}

// Memory
function collectMemory() {
  const raw = readHost('meminfo'); if (!raw) return null;
  const v: Record<string, number> = {};
  for (const line of raw.split('\n')) { const m = line.match(/^(\w+):\s+(\d+)/); if (m) v[m[1]] = parseInt(m[2]) * 1024; }
  const total = v.MemTotal || 0, avail = v.MemAvailable || 0, used = total - avail;
  return {
    total, avail, used,
    usedPct:   total > 0 ? Math.round(used / total * 100) : 0,
    buffers:   v.Buffers || 0, cached: v.Cached || 0,
    swapTotal: v.SwapTotal || 0, swapFree: v.SwapFree || 0,
    swapUsed:  (v.SwapTotal || 0) - (v.SwapFree || 0),
    swapPct:   v.SwapTotal ? Math.round(((v.SwapTotal - v.SwapFree) / v.SwapTotal) * 100) : 0,
  };
}

// Load + uptime
function collectLoadavg() {
  const raw = readHost('loadavg'); if (!raw) return null;
  const p = raw.trim().split(/\s+/);
  return { load1: +p[0] || 0, load5: +p[1] || 0, load15: +p[2] || 0,
           runningProcs: parseInt(p[3]?.split('/')[0]) || 0, totalProcs: parseInt(p[3]?.split('/')[1]) || 0 };
}
function collectUptime() {
  const raw = readHost('uptime'); if (!raw) return null;
  const secs = parseFloat(raw.split(' ')[0]) || 0;
  const d = Math.floor(secs / 86400), h = Math.floor(secs % 86400 / 3600), m = Math.floor(secs % 3600 / 60);
  const parts: string[] = []; if (d) parts.push(d + 'd'); if (h) parts.push(h + 'h'); parts.push(m + 'm');
  return { seconds: secs, human: parts.join(' ') };
}

// CPU
type CpuRow = { user:number; nice:number; system:number; idle:number; iowait:number; irq:number; softirq:number; steal:number };
let prevCpu: Record<string, CpuRow> = {};
function parseCpuLine(line: string): CpuRow {
  const p = line.split(/\s+/);
  return { user:+p[1]||0, nice:+p[2]||0, system:+p[3]||0, idle:+p[4]||0, iowait:+p[5]||0, irq:+p[6]||0, softirq:+p[7]||0, steal:+p[8]||0 };
}
function cpuPct(cur: CpuRow, prev: CpuRow): number {
  const td = Object.values(cur).reduce((a,b)=>a+b,0) - Object.values(prev).reduce((a,b)=>a+b,0);
  const id = (cur.idle + cur.iowait) - (prev.idle + prev.iowait);
  return td > 0 ? Math.round((td - id) / td * 100) : 0;
}
function collectCpu() {
  const raw = readHost('stat'); if (!raw) return null;
  const lines = raw.split('\n').filter(l => l.startsWith('cpu'));
  const cur: Record<string, CpuRow> = {};
  for (const l of lines) cur[l.split(/\s+/)[0]] = parseCpuLine(l);
  const result = { overall: 0, cores: [] as number[], count: lines.filter(l => /^cpu\d/.test(l)).length, ready: Object.keys(prevCpu).length > 0 };
  if (result.ready) {
    result.overall = cpuPct(cur['cpu'], prevCpu['cpu']);
    result.cores = Object.keys(cur).filter(k => /^cpu\d/.test(k)).sort().map(k => prevCpu[k] ? cpuPct(cur[k], prevCpu[k]) : 0);
  }
  prevCpu = cur;
  return result;
}

// Disk I/O from /proc/diskstats
let prevDiskIo: Record<string, { rBytes:number; wBytes:number; ts:number }> = {};
function collectDiskIo() {
  const raw = readHost('diskstats'); if (!raw) return [];
  const now = Date.now();
  const result = [];
  for (const line of raw.split('\n')) {
    const p = line.trim().split(/\s+/);
    if (p.length < 14) continue;
    const dev = p[2];
    if (/\d$/.test(dev) && !/^nvme\d+n\d+$/.test(dev)) continue; // skip partitions
    if (dev.startsWith('loop') || dev.startsWith('ram')) continue;
    const rBytes = +p[5] * 512, wBytes = +p[9] * 512;
    const prev = prevDiskIo[dev];
    let rRate = 0, wRate = 0;
    if (prev) { const dt = (now - prev.ts) / 1000; if (dt > 0.1) { rRate = Math.max(0, (rBytes - prev.rBytes) / dt); wRate = Math.max(0, (wBytes - prev.wBytes) / dt); } }
    prevDiskIo[dev] = { rBytes, wBytes, ts: now };
    result.push({ device: dev, readBytes: rBytes, writeBytes: wBytes, readRate: rRate, writeRate: wRate });
  }
  return result;
}

// Network I/O
let prevNet: Record<string, { rx:number; tx:number; ts:number }> = {};
function collectNetwork() {
  const raw = readHost('net/dev'); if (!raw) return [];
  const now = Date.now();
  const result = [];
  for (const line of raw.split('\n').slice(2)) {
    const m = line.trim().match(/^(\S+?):\s*(\d+)\s+(\d+)\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+(\d+)\s+(\d+)/);
    if (!m) continue;
    const [, iface, rxB, rxP, txB, txP] = m;
    const rx = +rxB, tx = +txB;
    const prev = prevNet[iface];
    let rxRate = 0, txRate = 0;
    if (prev) { const dt = (now - prev.ts) / 1000; if (dt > 0.1) { rxRate = Math.max(0, (rx - prev.rx) / dt); txRate = Math.max(0, (tx - prev.tx) / dt); } }
    prevNet[iface] = { rx, tx, ts: now };
    result.push({ iface, rxBytes: rx, txBytes: tx, rxPackets: +rxP, txPackets: +txP, rxRate, txRate });
  }
  return result;
}

function collectOsInfo() {
  const raw = readHostEtc('os-release'); if (!raw) return {};
  const v: Record<string, string> = {};
  for (const line of raw.split('\n')) { const m = line.match(/^(\w+)=["']?([^"'\n]*)["']?$/); if (m) v[m[1]] = m[2]; }
  return v;
}

// Disk — BusyBox-compatible df (no -x, use -Pk)
async function collectDisk() {
  try {
    const proc = Bun.spawn(['df', '-Pk', '/data'], { stdout: 'pipe', stderr: 'pipe' });
    const out = await new Response(proc.stdout).text();
    const seen = new Set<string>();
    return out.trim().split('\n').slice(1).flatMap(line => {
      const p = line.trim().split(/\s+/);
      if (p.length < 6 || seen.has(p[0])) return [];
      seen.add(p[0]);
      return [{ filesystem: p[0], total: +p[1]*1024, used: +p[2]*1024, available: +p[3]*1024, usePct: parseInt(p[4])||0, mountpoint: '/ (host)' }];
    });
  } catch { return []; }
}

// ─── Tailscale ───────────────────────────────────────────────────────────────

async function collectTailscale() {
  try {
    const s = await tailscaleGet('/localapi/v0/status') as Record<string, unknown> | null;
    if (!s) return null;
    const self = s.Self as Record<string, unknown> | undefined;
    const peers = Object.values((s.Peer as Record<string, unknown>) || {}) as Array<Record<string, unknown>>;
    return {
      backend:  s.BackendState,
      version:  s.Version,
      tailnet:  self?.DNSName ? String(self.DNSName).split('.').slice(1).join('.').replace(/\.$/, '') : null,
      self: self ? {
        hostname:  self.HostName,
        ips:       self.TailscaleIPs,
        os:        self.OS,
        online:    self.Online,
        relay:     self.Relay,
        keyExpiry: self.KeyExpiry,
        rxBytes:   self.RxBytes,
        txBytes:   self.TxBytes,
      } : null,
      peers: peers.map(p => ({
        hostname:      p.HostName,
        dns:           p.DNSName,
        ips:           p.TailscaleIPs,
        os:            p.OS,
        online:        p.Online,
        relay:         p.Relay,
        lastSeen:      p.LastSeen,
        lastHandshake: p.LastHandshake,
        rxBytes:       p.RxBytes,
        txBytes:       p.TxBytes,
        exitNode:      p.ExitNode,
        active:        p.Active,
        keyExpiry:     p.KeyExpiry,
        tags:          p.Tags,
      })),
    };
  } catch { return null; }
}

// ─── Package updates ─────────────────────────────────────────────────────────

function collectAptUpdates() {
  const raw = readHostFile('/host/update-notifier/updates-available');
  if (!raw) return null;
  let count = 0, security = 0, esm = 0;
  for (const line of raw.split('\n')) {
    const m = line.match(/^(\d+)/);
    if (!m) continue;
    const n = parseInt(m[1]);
    if (/ESM/i.test(line)) esm += n;
    else if (/[Ss]icherheit|[Ss]ecurity/.test(line)) security += n;
    else if (/Aktualisierung|upgradable|update/i.test(line)) count += n;
  }
  return { count, security, esm, raw: raw.trim() };
}

function collectBrewUpdates() {
  const p = path.join(DATA_DIR, 'brew-outdated.json');
  if (!existsSync(p)) return null;
  try {
    const d = JSON.parse(readFileSync(p, 'utf-8'));
    const formulae: { name: string; installed: string; current: string; pinned: boolean }[] =
      (d.formulae || []).map((f: Record<string, unknown>) => ({
        name:      String(f.name ?? ''),
        installed: String((f.installed_versions as string[])?.[0] ?? ''),
        current:   String(f.current_version ?? ''),
        pinned:    Boolean(f.pinned),
      }));
    const casks: { name: string; installed: string; current: string }[] =
      (d.casks || []).map((c: Record<string, unknown>) => ({
        name:      String(c.name ?? ''),
        installed: String((c.installed_versions as string[])?.[0] ?? ''),
        current:   String(c.current_version ?? ''),
      }));
    return { formulae, casks, timestamp: d.timestamp ?? null };
  } catch { return null; }
}

async function collectSnapUpdates() {
  try {
    const r = await snapGet('/v2/find?select=refresh') as Record<string, unknown> | null;
    if (!r || r['status-code'] !== 200) return { count: 0, snaps: [] };
    const snaps = (r.result as Array<Record<string, unknown>>) || [];
    return { count: snaps.length, snaps: snaps.map(s => ({ name: s.name, version: s.version, channel: s.channel })) };
  } catch { return { count: 0, snaps: [] }; }
}

// ─── Docker ──────────────────────────────────────────────────────────────────

async function getDockerInfo() {
  const info = await dockerGet('/info') as Record<string, unknown> | null;
  if (!info) return null;
  return {
    serverVersion: info.ServerVersion, kernelVersion: info.KernelVersion,
    operatingSystem: info.OperatingSystem, osType: info.OSType, architecture: info.Architecture,
    totalMemory: info.MemTotal, cpuCount: info.NCPU,
    containersRunning: info.ContainersRunning, containersStopped: info.ContainersStopped, containersPaused: info.ContainersPaused,
    imagesCount: info.Images, storageDriver: info.Driver, loggingDriver: info.LoggingDriver,
    cgroupDriver: info.CgroupDriver, dockerRootDir: info.DockerRootDir,
  };
}

async function getDockerImages() {
  const imgs = await dockerGet('/images/json') as Array<Record<string, unknown>> | null;
  if (!imgs) return [];
  return imgs.map(i => ({
    id: String(i.Id || '').replace('sha256:', '').slice(0, 12),
    tags: (i.RepoTags as string[]) || ['<none>:<none>'],
    size: +((i.Size as number) || 0),
    created: +((i.Created as number) || 0),
  })).sort((a, b) => b.created - a.created).slice(0, 40);
}

async function getDockerNetworks() {
  const nets = await dockerGet('/networks') as Array<Record<string, unknown>> | null;
  if (!nets) return [];
  return nets.map(n => ({
    id: String(n.Id || '').slice(0, 12), name: String(n.Name || ''),
    driver: String(n.Driver || ''), scope: String(n.Scope || ''),
    internal: !!(n.Internal as boolean),
    containers: Object.keys((n.Containers as object) || {}).length,
  }));
}

async function getDockerVolumes() {
  const r = await dockerGet('/volumes') as Record<string, unknown> | null;
  if (!r) return [];
  return ((r.Volumes as Array<Record<string, unknown>>) || []).map(v => ({
    name:       String(v.Name || ''),
    driver:     String(v.Driver || ''),
    mountpoint: String(v.Mountpoint || ''),
    created:    String(v.CreatedAt || ''),
    scope:      String(v.Scope || ''),
    labels:     (v.Labels as Record<string, string>) || {},
  }));
}

async function getContainerStats(id: string) {
  try {
    const s = await dockerGet(`/containers/${id}/stats?stream=false`) as Record<string, unknown> | null;
    if (!s) return null;
    const cpu = s.cpu_stats as Record<string, unknown> | undefined;
    const preCpu = s.precpu_stats as Record<string, unknown> | undefined;
    const mem = s.memory_stats as Record<string, unknown> | undefined;
    const cpuD = ((cpu?.cpu_usage as Record<string, number>)?.total_usage || 0) - ((preCpu?.cpu_usage as Record<string, number>)?.total_usage || 0);
    const sysD = ((cpu?.system_cpu_usage as number) || 0) - ((preCpu?.system_cpu_usage as number) || 0);
    const numCpu = (cpu?.online_cpus as number) || 1;
    const cpuPct = sysD > 0 ? (cpuD / sysD) * numCpu * 100 : 0;
    const memUsage = (mem?.usage as number) || 0;
    const memLimit = (mem?.limit as number) || 0;
    const memCache = ((mem?.stats as Record<string, number>)?.cache) || 0;
    const memActual = memUsage - memCache;
    return { cpuPercent: Math.round(cpuPct * 10) / 10, memUsage: memActual, memLimit, memPercent: memLimit > 0 ? Math.round(memActual / memLimit * 100) : 0 };
  } catch { return null; }
}

async function collectContainers() {
  const list = await dockerGet('/containers/json?all=1') as Array<Record<string, unknown>> | null;
  if (!list) return [];
  const containers = list.map(c => ({
    id: String(c.Id ?? '').slice(0, 12), fullId: String(c.Id ?? ''),
    names: ((c.Names as string[]) ?? []).map(n => n.replace(/^\//, '')),
    image: String(c.Image ?? ''), state: String(c.State ?? ''), status: String(c.Status ?? ''),
    created: c.Created as number ?? 0,
    labels: (c.Labels as Record<string, string>) ?? {},
    isNanoclaw: 'nanoclaw-install' in ((c.Labels as Record<string, string>) ?? {}),
    stats: null as null | Awaited<ReturnType<typeof getContainerStats>>,
  }));
  const running = containers.filter(c => c.state === 'running').slice(0, 10);
  const statsArr = await Promise.all(running.map(c => getContainerStats(c.fullId)));
  running.forEach((c, i) => { c.stats = statsArr[i]; });
  return containers;
}

// ─── Rate-limit metrics ──────────────────────────────────────────────────────

const LIMIT_5H  = parseInt(process.env.CLAUDE_5H_OUTPUT_LIMIT    || '0');
const LIMIT_24H = parseInt(process.env.CLAUDE_DAILY_OUTPUT_LIMIT  || '0');
const LIMIT_7D  = parseInt(process.env.CLAUDE_WEEKLY_OUTPUT_LIMIT || '0');

// Plan-Tabelle (Output-Tokens pro 5h-Block) — Quelle: Maciek-roboblog/Claude-Code-Usage-Monitor
const PLAN_LIMITS: Record<string, { h5: number }> = {
  pro:    { h5:  19_000 },
  max5x:  { h5:  88_000 },
  max20x: { h5: 220_000 },
};
const CLAUDE_PLAN = (process.env.CLAUDE_PLAN ?? '').toLowerCase();
const PLAN_INFO   = PLAN_LIMITS[CLAUDE_PLAN] ?? null;
// Effektives 5h-Limit: explizite env > Plan-Tabelle > 0 (kein Limit)
const EFF_LIMIT_5H = LIMIT_5H || PLAN_INFO?.h5 || 0;

// ─── Exhaustion-Learning ─────────────────────────────────────────────────────
// Jedes "out of extra usage"-Ereignis wird mit dem 5h-Token-Stand zur Zeit der
// Erschöpfung geloggt. Der Median aller Werte ergibt das gelernte echte Limit.

const EXHAUSTION_LOG = path.join(DATA_DIR, 'claude-exhaustion-events.jsonl');

interface ExhaustionEvent {
  ts: number;          // ms-Timestamp der Erschöpfung
  out5hAtHit: number;  // 5h-Tokens zum Zeitpunkt der Erschöpfung
  burnPerMin: number;
  resetTs: number | null;
}

function readExhaustionEvents(): ExhaustionEvent[] {
  try {
    return readFileSync(EXHAUSTION_LOG, 'utf-8')
      .split('\n').filter(l => l.trim())
      .map(l => JSON.parse(l) as ExhaustionEvent);
  } catch { return []; }
}

function computeLearnedLimit(events: ExhaustionEvent[]): number | null {
  if (!events.length) return null;
  const vals = events.map(e => e.out5hAtHit).sort((a, b) => a - b);
  return vals[Math.floor(vals.length / 2)]; // Median — robust gegen Ausreißer
}

function collectRateLimitMetrics() {
  const now = Date.now();
  const window5hMs  = 5  * 3600000;
  const window24hMs = 24 * 3600000;
  const window7dMs  = 7  * 86400000;

  // UTC midnight of today
  const todayUtcMs = now - (now % 86400000);

  let out5h    = 0;
  let out24h   = 0;
  let out7d    = 0;
  let cacheRead5h    = 0;
  let cacheRead24h   = 0;
  let cacheRead7d    = 0;
  let cacheCreate5h  = 0;
  let cacheCreate24h = 0;
  let cacheCreate7d  = 0;
  let input5h        = 0;
  let input24h       = 0;
  let input7d        = 0;

  // Oldest token timestamp inside 5h window — used to compute resetInMs
  let oldest5hTs: number | null = null;

  // All events in last 7d for peak-5h computation: [ts, outputTokens]
  const events7d: [number, number][] = [];

  // Most recent "out of extra usage" synthetic message
  let lastExtraHitTs: number | null = null;
  let lastExtraHitMsg = '';

  function scanFile(filePath: string) {
    try {
      const lines = readFileSync(filePath, 'utf-8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line);
          if (e.type !== 'assistant' || !e.timestamp) continue;
          const ts = new Date(e.timestamp).getTime();
          if (isNaN(ts)) continue;

          // Synthetic rate-limit messages (model: '<synthetic>')
          if (e.message?.model === '<synthetic>') {
            const content: unknown[] = Array.isArray(e.message?.content) ? e.message.content : [];
            for (const c of content) {
              if (typeof (c as Record<string,unknown>)?.text === 'string') {
                const text = (c as {text: string}).text;
                if (text.includes('out of extra usage')) {
                  if (lastExtraHitTs === null || ts > lastExtraHitTs) {
                    lastExtraHitTs = ts;
                    lastExtraHitMsg = text;
                  }
                }
              }
            }
            continue;
          }

          if (!e.message?.usage) continue;
          const outputTokens:  number = e.message.usage.output_tokens              || 0;
          const cacheRead:     number = e.message.usage.cache_read_input_tokens    || 0;
          const cacheCreate:   number = e.message.usage.cache_creation_input_tokens || 0;
          const inputTokens:   number = e.message.usage.input_tokens               || 0;
          const age = now - ts;

          if (age <= window7dMs) {
            out7d        += outputTokens;
            cacheRead7d  += cacheRead;
            cacheCreate7d += cacheCreate;
            input7d      += inputTokens;
            events7d.push([ts, outputTokens]);
            if (age <= window24hMs) {
              out24h        += outputTokens;
              cacheRead24h  += cacheRead;
              cacheCreate24h += cacheCreate;
              input24h      += inputTokens;
              if (age <= window5hMs) {
                out5h        += outputTokens;
                cacheRead5h  += cacheRead;
                cacheCreate5h += cacheCreate;
                input5h      += inputTokens;
                if (oldest5hTs === null || ts < oldest5hTs) oldest5hTs = ts;
              }
            }
          }
        } catch {}
      }
    } catch {}
  }

  // NanoClaw agent sessions
  const sessDir = path.join(DATA_DIR, 'v2-sessions');
  if (existsSync(sessDir)) {
    let agDirs: string[] = [];
    try { agDirs = readdirSync(sessDir).filter(d => d.startsWith('ag-')); } catch {}
    for (const ag of agDirs) {
      const claudeDir = path.join(sessDir, ag, '.claude-shared/projects/-workspace-agent');
      if (!existsSync(claudeDir)) continue;
      let files: string[] = [];
      try { files = readdirSync(claudeDir).filter(f => f.endsWith('.jsonl')); } catch { continue; }
      const cutoff = now - window7dMs;
      for (const f of files) {
        const fp = path.join(claudeDir, f);
        try { if (statSync(fp).mtimeMs < cutoff) continue; } catch { continue; }
        scanFile(fp);
      }
    }
  }

  // Claude Code CLI sessions
  if (existsSync(CLAUDE_PROJECTS)) {
    let projDirs: string[] = [];
    try { projDirs = readdirSync(CLAUDE_PROJECTS); } catch {}
    const cutoff = now - window7dMs;
    for (const proj of projDirs) {
      const projPath = path.join(CLAUDE_PROJECTS, proj);
      let files: string[] = [];
      try { files = readdirSync(projPath).filter(f => f.endsWith('.jsonl')); } catch { continue; }
      for (const f of files) {
        const fp = path.join(projPath, f);
        try { if (statSync(fp).mtimeMs < cutoff) continue; } catch { continue; }
        scanFile(fp);
      }
    }
  }

  // resetInMs: time until the oldest token in the 5h window falls out
  const resetInMs = oldest5hTs !== null
    ? Math.max(0, window5hMs - (now - oldest5hTs))
    : 0;

  // Date string for daily bucket (UTC)
  const dailyDate = new Date(todayUtcMs).toISOString().slice(0, 10);

  // Parse "resets 7pm" / "resets 1:30am" as first Europe/Berlin occurrence AFTER the hit (minute scan)
  function parseExtraReset(msg: string, hitTs: number): number | null {
    const m = msg.match(/resets\s+(\d+)(?::(\d+))?\s*(am|pm)/i);
    if (!m) return null;
    let h = parseInt(m[1]);
    const min = parseInt(m[2] || '0');
    const ap = m[3].toLowerCase();
    if (ap === 'pm' && h !== 12) h += 12;
    else if (ap === 'am' && h === 12) h = 0;
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Berlin', hour: 'numeric', minute: '2-digit', hour12: false });
    for (let off = 1; off <= 25 * 60; off++) {
      const t = hitTs + off * 60000;
      const s = fmt.format(new Date(t));
      const parts = s.split(':');
      if (parseInt(parts[0]) % 24 === h && parseInt(parts[1]) === min) return t - (t % 60000);
    }
    return null;
  }

  // Peak 5h rolling window over last 7d (sliding window over sorted events)
  let peak5h = out5h;
  if (events7d.length > 1) {
    events7d.sort((a, b) => a[0] - b[0]);
    let windowSum = 0;
    let left = 0;
    for (let right = 0; right < events7d.length; right++) {
      windowSum += events7d[right][1];
      while (events7d[right][0] - events7d[left][0] > window5hMs) {
        windowSum -= events7d[left][1];
        left++;
      }
      if (windowSum > peak5h) peak5h = windowSum;
    }
  } else if (events7d.length === 1) {
    events7d.sort((a, b) => a[0] - b[0]);
  }

  // Daily average: out7d / number of distinct UTC days with activity
  const activeDays = new Set(events7d.map(([ts]) => Math.floor(ts / 86400000))).size;
  const dailyAvg = activeDays > 0 ? Math.round(out7d / activeDays) : 0;

  const extraResetTs = lastExtraHitMsg && lastExtraHitTs !== null ? parseExtraReset(lastExtraHitMsg, lastExtraHitTs) : null;
  const extraLimited = extraResetTs !== null && extraResetTs > now;

  // Burn-Rate (Tokens/min) über die letzten 60 Minuten — Quelle: Maciek
  const burnWindowMs = 3_600_000;
  let burn1hTokens = 0;
  for (const [ts, tok] of events7d) {
    if (now - ts <= burnWindowMs) burn1hTokens += tok;
  }
  const burnPerMin = burn1hTokens / 60;

  // 5h-Block-Detection (Gap-basiert mit 5h-Cap): rückwärts vom jüngsten Event;
  // Block bricht bei einer Lücke > 5h ODER wenn das Event > 5h vor dem jüngsten liegt
  // (bei kontinuierlicher Aktivität sonst unbegrenzt langer Block).
  let blockStart: number | null = null;
  let blockTokens = 0;
  if (events7d.length > 0) {
    const newest = events7d[events7d.length - 1][0];
    const blockFloor = newest - window5hMs;
    blockStart = newest;
    for (let i = events7d.length - 1; i >= 0; i--) {
      const [ts, tok] = events7d[i];
      if (ts < blockFloor) break;
      if (blockStart - ts > window5hMs) break;
      blockStart = ts;
      blockTokens += tok;
    }
  }
  const blockEndTs       = blockStart !== null ? blockStart + window5hMs : null;
  const blockElapsedMs   = blockStart !== null ? now - blockStart : 0;
  const blockRemainingMs = blockEndTs !== null ? Math.max(0, blockEndTs - now) : 0;

  // Exhaustion-Learning: out5h rückwirkend zum Zeitpunkt der letzten Erschöpfung
  let out5hAtHit = 0;
  if (lastExtraHitTs !== null) {
    for (const [ts, tok] of events7d) {
      const age = lastExtraHitTs - ts;
      if (age >= 0 && age <= window5hMs) out5hAtHit += tok;
    }
  }
  const pastEvents = readExhaustionEvents();
  const knownHitTs = new Set(pastEvents.map(e => e.ts));
  if (lastExtraHitTs !== null && !knownHitTs.has(lastExtraHitTs) && out5hAtHit > 0) {
    const ev: ExhaustionEvent = { ts: lastExtraHitTs, out5hAtHit, burnPerMin, resetTs: extraResetTs };
    try { appendFileSync(EXHAUSTION_LOG, JSON.stringify(ev) + '\n'); } catch {}
    pastEvents.push(ev);
  }
  const learnedLimit5h = computeLearnedLimit(pastEvents);
  // Dynamisches Limit: explizite LIMIT_5H-env > gelernt (Realwert) > Plan-Tabelle > 0
  // Gelernt hat Vorrang vor Plan-Tabelle, weil es echte Messwerte repräsentiert.
  const dynLimit5h = LIMIT_5H || learnedLimit5h || PLAN_INFO?.h5 || 0;

  // Forecast: Projection und ETA bis Limit
  const projected5h = blockStart !== null
    ? Math.round(blockTokens + burnPerMin * blockRemainingMs / 60_000)
    : null;
  const etaMs = (limit: number, current: number) =>
    (limit > 0 && burnPerMin > 0)
      ? Math.max(0, (limit - current) / burnPerMin) * 60_000
      : null;
  const etaToLimit5h  = etaMs(dynLimit5h, out5h);
  const etaToLimit24h = etaMs(LIMIT_24H,  out24h);
  const etaToLimit7d  = etaMs(LIMIT_7D,   out7d);

  // Time-Pacing — Quelle: jens-duttke
  const timePct5h  = blockStart !== null
    ? Math.min(100, Math.round(blockElapsedMs / window5hMs * 100))
    : null;
  const usagePct5h = dynLimit5h > 0 ? Math.round(out5h / dynLimit5h * 100) : null;
  // Pacing-Warnung nur, wenn Block ≥ 10 % gelaufen UND Verbrauch > Zeit + 10 %
  const pacingWarn = (
    usagePct5h !== null &&
    timePct5h  !== null &&
    timePct5h  >= 10 &&
    usagePct5h >  timePct5h + 10
  );

  return {
    window5h: {
      outputTokens: out5h,
      resetInMs,
      blockStart,
      blockEndTs,
      projected:    projected5h,
      timePct:      timePct5h,
      usagePct:     usagePct5h,
      pacingWarn,
      etaToLimitMs: etaToLimit5h,
    },
    daily:    { outputTokens: out24h, date: dailyDate, etaToLimitMs: etaToLimit24h },
    weekly:   { outputTokens: out7d,                   etaToLimitMs: etaToLimit7d  },
    burn:     { perMin: burnPerMin, perHour: burnPerMin * 60, windowMs: burnWindowMs },
    plan: {
      source: PLAN_INFO ? 'env' : (LIMIT_5H ? 'limit-env' : 'none'),
      name:   PLAN_INFO ? CLAUDE_PLAN : null,
      h5:     EFF_LIMIT_5H || null,
    },
    limits:  { h5: LIMIT_5H, h24: LIMIT_24H, d7: LIMIT_7D },
    context: { peak5h, dailyAvg, activeDays },
    extraUsage: {
      limited:   extraLimited,
      resetTs:   extraResetTs,
      lastHitTs: lastExtraHitTs,
      message:   lastExtraHitMsg || null,
    },
    learned: {
      limit5h:    learnedLimit5h,
      dynLimit5h: dynLimit5h || null,
      eventCount: pastEvents.length,
      events:     pastEvents.slice(-5).map(e => ({ ts: e.ts, out5hAtHit: e.out5hAtHit })),
    },
    netWindows: {
      // net = output + input + cacheCreate (= alle Tokens außer Cache-Reads)
      // Spiegelt die echte Rechenarbeit, da Cache-Reads günstige KV-Lookups sind.
      w5h: {
        net: out5h + input5h + cacheCreate5h,
        output: out5h, input: input5h, cacheCreate: cacheCreate5h, cacheRead: cacheRead5h,
      },
      daily: {
        net: out24h + input24h + cacheCreate24h,
        output: out24h, input: input24h, cacheCreate: cacheCreate24h, cacheRead: cacheRead24h, date: dailyDate,
      },
      weekly: {
        net: out7d + input7d + cacheCreate7d,
        output: out7d, input: input7d, cacheCreate: cacheCreate7d, cacheRead: cacheRead7d,
      },
    },
  };
}

// ─── Token metrics ───────────────────────────────────────────────────────────

interface TokenUsage {
  input: number; output: number; cacheRead: number; cacheCreate: number;
}

function parseJsonlTokens(filePath: string): { turns: TokenUsage[]; lastTs: string } {
  const turns: TokenUsage[] = [];
  let lastTs = '';
  try {
    const lines = readFileSync(filePath, 'utf-8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (e.type === 'assistant' && e.message?.usage) {
          const u = e.message.usage;
          turns.push({
            input:       u.input_tokens                || 0,
            output:      u.output_tokens               || 0,
            cacheRead:   u.cache_read_input_tokens     || 0,
            cacheCreate: u.cache_creation_input_tokens || 0,
          });
          if (e.timestamp) lastTs = e.timestamp;
        }
      } catch {}
    }
  } catch {}
  return { turns, lastTs };
}

function summariseSession(filePath: string, label: string, kind: 'agent' | 'cli'): Record<string, unknown> | null {
  const { turns, lastTs } = parseJsonlTokens(filePath);
  if (!turns.length) return null;

  let totalInput = 0, totalOutput = 0, totalCacheRead = 0, totalCacheCreate = 0;
  for (const t of turns) {
    totalInput      += t.input;
    totalOutput     += t.output;
    totalCacheRead  += t.cacheRead;
    totalCacheCreate+= t.cacheCreate;
  }

  const last = turns[turns.length - 1];
  const contextTokens = last.input + last.cacheRead + last.cacheCreate;
  const allInput = totalInput + totalCacheRead + totalCacheCreate;
  const cacheHitPct = allInput > 0 ? Math.round(totalCacheRead / allInput * 100) : 0;

  return {
    label, kind,
    agentGroupId: kind === 'agent' ? label : null,
    sessionId:    path.basename(filePath, '.jsonl'),
    turns:        turns.length,
    totalInput, totalOutput, totalCacheRead, totalCacheCreate,
    contextTokens,
    contextPct:   Math.round(contextTokens / COMPACT_THRESHOLD * 100),
    contextFill:  Math.round(contextTokens / CONTEXT_WINDOW    * 100),
    cacheHitPct,
    lastTs,
  };
}

function collectTokenMetrics() {
  const sessions: Record<string, unknown>[] = [];

  // NanoClaw agent sessions
  const sessDir = path.join(DATA_DIR, 'v2-sessions');
  if (existsSync(sessDir)) {
    let agDirs: string[] = [];
    try { agDirs = readdirSync(sessDir).filter(d => d.startsWith('ag-')); } catch {}
    for (const ag of agDirs) {
      const claudeDir = path.join(sessDir, ag, '.claude-shared/projects/-workspace-agent');
      if (!existsSync(claudeDir)) continue;
      let files: string[] = [];
      try { files = readdirSync(claudeDir).filter(f => f.endsWith('.jsonl')); } catch { continue; }
      // Only include files touched in the last 30 days
      const cutoff = Date.now() - 30 * 86400000;
      for (const f of files) {
        const fp = path.join(claudeDir, f);
        try { if (statSync(fp).mtimeMs < cutoff) continue; } catch { continue; }
        const s = summariseSession(fp, ag, 'agent');
        if (s) sessions.push(s);
      }
    }
  }

  // Claude Code CLI sessions (host ~/.claude/projects)
  if (existsSync(CLAUDE_PROJECTS)) {
    let projDirs: string[] = [];
    try { projDirs = readdirSync(CLAUDE_PROJECTS); } catch {}
    const cutoff = Date.now() - 30 * 86400000;
    for (const proj of projDirs) {
      const projPath = path.join(CLAUDE_PROJECTS, proj);
      let files: string[] = [];
      try { files = readdirSync(projPath).filter(f => f.endsWith('.jsonl')); } catch { continue; }
      for (const f of files) {
        const fp = path.join(projPath, f);
        try { if (statSync(fp).mtimeMs < cutoff) continue; } catch { continue; }
        const label = proj.replace(/^-/, '').replace(/-/g, '/').replace(/home\/[^/]+\//, '~/');
        const s = summariseSession(fp, label, 'cli');
        if (s) sessions.push(s);
      }
    }
  }

  // Sort by lastTs descending
  sessions.sort((a, b) => String(b.lastTs).localeCompare(String(a.lastTs)));

  // Aggregate totals
  let totalInput = 0, totalOutput = 0, totalCacheRead = 0, totalCacheCreate = 0;
  for (const s of sessions) {
    totalInput       += s.totalInput as number;
    totalOutput      += s.totalOutput as number;
    totalCacheRead   += s.totalCacheRead as number;
    totalCacheCreate += s.totalCacheCreate as number;
  }
  const allInput = totalInput + totalCacheRead + totalCacheCreate;
  const overallCacheHit = allInput > 0 ? Math.round(totalCacheRead / allInput * 100) : 0;

  return { sessions, totalInput, totalOutput, totalCacheRead, totalCacheCreate, overallCacheHit };
}

// ─── Message metrics ─────────────────────────────────────────────────────────

interface MsgMetrics {
  total:            number;
  today:            number;
  last7d:           number;
  pending:          number;
  byHour:           number[];          // [24] count per UTC hour, last 24h
  byKind:           Record<string, number>;
  medianResponseMs: number | null;
  deliveryErrors:   number;
  lastActivityMs:   number | null;
  recentMessages:   { timestamp: number; kind: string; text: string }[];
}

function extractText(content: string): string {
  if (!content) return '';
  try {
    const p = JSON.parse(content);
    if (typeof p === 'string') return p.slice(0, 80);
    if (p && typeof p.text === 'string') return p.text.slice(0, 80);
    if (Array.isArray(p)) {
      const texts = p.filter((x: unknown) => (x as Record<string, unknown>)?.type === 'text').map((x: unknown) => (x as Record<string, string>).text);
      if (texts.length) return texts.join(' ').slice(0, 80);
    }
    return JSON.stringify(p).slice(0, 80);
  } catch { return content.slice(0, 80); }
}

function computeMsgMetrics(inDbPath: string, outDbPath: string): MsgMetrics | null {
  try {
    // ISO strings for SQL comparisons (timestamps stored as TEXT ISO-8601)
    const now = new Date();
    const todayIso  = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
    const last7dIso = new Date(Date.now() - 7 * 86400000).toISOString();
    const last24hIso= new Date(Date.now() - 86400000).toISOString();

    let total = 0, today = 0, last7d = 0, pending = 0;
    const byHour: number[] = new Array(24).fill(0);
    const byKind: Record<string, number> = {};
    let lastInIso: string | null = null;
    let recentMessages: { timestamp: number; kind: string; text: string }[] = [];

    if (existsSync(inDbPath)) {
      let inDb: Database | null = null;
      try {
        inDb = new Database(inDbPath, { readonly: true });

        total   = (inDb.query<{ cnt: number }, []>("SELECT COUNT(*) AS cnt FROM messages_in WHERE kind != 'system'").get()?.cnt ?? 0);
        today   = (inDb.query<{ cnt: number }, [string]>("SELECT COUNT(*) AS cnt FROM messages_in WHERE kind != 'system' AND timestamp >= ?").get(todayIso)?.cnt ?? 0);
        last7d  = (inDb.query<{ cnt: number }, [string]>("SELECT COUNT(*) AS cnt FROM messages_in WHERE kind != 'system' AND timestamp >= ?").get(last7dIso)?.cnt ?? 0);
        pending = (inDb.query<{ cnt: number }, []>("SELECT COUNT(*) AS cnt FROM messages_in WHERE status = 'pending'").get()?.cnt ?? 0);

        // byHour using SQLite strftime to extract UTC hour from ISO string
        const hourRows = inDb.query<{ h: number }, [string]>(
          "SELECT CAST(strftime('%H', timestamp) AS INTEGER) AS h FROM messages_in WHERE timestamp >= ?"
        ).all(last24hIso);
        for (const row of hourRows) byHour[row.h] = (byHour[row.h] ?? 0) + 1;

        const kindRows = inDb.query<{ kind: string; cnt: number }, []>(
          "SELECT kind, COUNT(*) AS cnt FROM messages_in GROUP BY kind"
        ).all();
        for (const row of kindRows) byKind[row.kind] = row.cnt;

        lastInIso = inDb.query<{ mx: string | null }, []>("SELECT MAX(timestamp) AS mx FROM messages_in").get()?.mx ?? null;

        const recRows = inDb.query<{ timestamp: string; kind: string; content: string }, []>(
          "SELECT timestamp, kind, content FROM messages_in ORDER BY timestamp DESC LIMIT 5"
        ).all();
        recentMessages = recRows.map(r => ({
          timestamp: r.timestamp ? new Date(r.timestamp).getTime() : 0,
          kind:      r.kind ?? '',
          text:      extractText(r.content),
        }));
      } finally { try { inDb?.close(); } catch {} }
    }

    let lastOutIso: string | null = null;
    let medianResponseMs: number | null = null;

    if (existsSync(outDbPath)) {
      let outDb: Database | null = null;
      try {
        outDb = new Database(outDbPath, { readonly: true });
        lastOutIso = outDb.query<{ mx: string | null }, []>("SELECT MAX(timestamp) AS mx FROM messages_out").get()?.mx ?? null;

        // Response time via in_reply_to: join outbound replies with inbound originals
        if (existsSync(inDbPath)) {
          let inDb2: Database | null = null;
          try {
            inDb2 = new Database(inDbPath, { readonly: true });
            const inRows = inDb2.query<{ id: string; ts: string }, []>(
              "SELECT id, timestamp AS ts FROM messages_in WHERE kind != 'system' ORDER BY ts"
            ).all();
            const outRows = outDb.query<{ reply: string; ts: string }, []>(
              "SELECT in_reply_to AS reply, MIN(timestamp) AS ts FROM messages_out WHERE in_reply_to IS NOT NULL GROUP BY in_reply_to"
            ).all();
            const outMap = new Map(outRows.map(r => [r.reply, r.ts]));
            const deltas: number[] = [];
            for (const row of inRows) {
              const outTs = outMap.get(row.id);
              if (outTs && row.ts) {
                const delta = new Date(outTs).getTime() - new Date(row.ts).getTime();
                if (delta >= 0 && delta < 300000) deltas.push(delta);
              }
            }
            if (deltas.length > 0) {
              deltas.sort((a, b) => a - b);
              const mid = Math.floor(deltas.length / 2);
              medianResponseMs = deltas.length % 2 === 0
                ? Math.round((deltas[mid - 1] + deltas[mid]) / 2)
                : deltas[mid];
            }
          } finally { try { inDb2?.close(); } catch {} }
        }
      } finally { try { outDb?.close(); } catch {} }
    }

    const candidates = [lastInIso, lastOutIso].filter(Boolean).map(s => new Date(s!).getTime());
    const lastActivityMs = candidates.length ? Math.max(...candidates) : null;

    return { total, today, last7d, pending, byHour, byKind, medianResponseMs, deliveryErrors: 0, lastActivityMs, recentMessages };
  } catch { return null; }
}

// ─── Session data ────────────────────────────────────────────────────────────

function collectSessionData() {
  const sessionsDir = path.join(DATA_DIR, 'v2-sessions');
  if (!existsSync(sessionsDir)) return [];
  const results = [];
  let agDirs: string[] = [];
  try { agDirs = readdirSync(sessionsDir).filter(d => d.startsWith('ag-')); } catch { return []; }
  for (const agDir of agDirs) {
    const agPath = path.join(sessionsDir, agDir);
    let sessDirs: string[] = [];
    try { sessDirs = readdirSync(agPath).filter(d => d.startsWith('sess-')); } catch { continue; }
    for (const sessDir of sessDirs) {
      const sessPath = path.join(agPath, sessDir);
      const inDb = path.join(sessPath, 'inbound.db'), outDb = path.join(sessPath, 'outbound.db');
      const hbMs: number | null = (() => { try { return statSync(path.join(sessPath, '.heartbeat')).mtimeMs; } catch { return null; } })();
      results.push({
        agentGroupId: agDir, sessionId: sessDir,
        inbound:       (qSession(inDb,  'SELECT * FROM messages_in ORDER BY seq DESC LIMIT 30') as unknown[]).reverse(),
        outbound:      (qSession(outDb, 'SELECT * FROM messages_out ORDER BY seq DESC LIMIT 30') as unknown[]).reverse(),
        processingAck: qSession(outDb, 'SELECT * FROM processing_ack ORDER BY status_changed DESC LIMIT 20'),
        sessionState:  qSession(outDb, 'SELECT * FROM session_state'),
        destinations:  qSession(inDb,  'SELECT * FROM destinations'),
        heartbeatMs: hbMs,
        msgMetrics:  computeMsgMetrics(inDb, outDb),
      });
    }
  }
  return results;
}

// ─── Agent detail ────────────────────────────────────────────────────────────

interface AgentWiring {
  channelType: string; platformId: string; mgName: string;
  sessionMode: string; engageMode: string; pattern: string;
  unknownSenderPolicy: string; priority: number;
}
interface AgentDetail {
  id: string; name: string; folder: string; provider: string;
  wirings: AgentWiring[];
}

function collectAgentDetail(): AgentDetail[] {
  const db = openCentral();
  if (!db) return [];
  try {
    const rows = q<Record<string, unknown>>(db, `
      SELECT
        ag.id, ag.name, ag.folder, ag.agent_provider,
        mga.session_mode, mga.engage_mode, mga.engage_pattern,
        mga.sender_scope, mga.priority,
        mg.channel_type, mg.platform_id, mg.name as mg_name,
        mg.unknown_sender_policy
      FROM agent_groups ag
      LEFT JOIN messaging_group_agents mga ON mga.agent_group_id = ag.id
      LEFT JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
      ORDER BY ag.name, mg.channel_type
    `);
    const map = new Map<string, AgentDetail>();
    for (const row of rows) {
      const id = String(row.id ?? '');
      if (!map.has(id)) {
        map.set(id, {
          id,
          name:     String(row.name     ?? ''),
          folder:   String(row.folder   ?? ''),
          provider: String(row.agent_provider ?? 'claude'),
          wirings:  [],
        });
      }
      if (row.channel_type != null) {
        map.get(id)!.wirings.push({
          channelType:          String(row.channel_type          ?? ''),
          platformId:           String(row.platform_id           ?? ''),
          mgName:               String(row.mg_name               ?? ''),
          sessionMode:          String(row.session_mode          ?? ''),
          engageMode:           String(row.engage_mode           ?? ''),
          pattern:              String(row.engage_pattern        ?? ''),
          unknownSenderPolicy:  String(row.unknown_sender_policy ?? ''),
          priority:             Number(row.priority              ?? 0),
        });
      }
    }
    return Array.from(map.values());
  } finally {
    try { db.close(); } catch {}
  }
}

// ─── Main snapshot ───────────────────────────────────────────────────────────

async function buildSnapshot() {
  const db = openCentral();
  const snap: Record<string, unknown> = {
    timestamp: new Date().toISOString(), db_exists: db !== null,
    agent_groups:     db ? q(db, 'SELECT * FROM agent_groups ORDER BY name') : [],
    messaging_groups: db ? q(db, 'SELECT * FROM messaging_groups ORDER BY channel_type, name') : [],
    sessions: db ? q(db, `SELECT s.*, ag.name as agent_group_name, mg.channel_type, mg.platform_id, mg.name as mg_name
      FROM sessions s
      LEFT JOIN agent_groups ag ON ag.id = s.agent_group_id
      LEFT JOIN messaging_groups mg ON mg.id = s.messaging_group_id
      ORDER BY s.last_active DESC`) : [],
    users:      db ? q(db, 'SELECT * FROM users ORDER BY created_at') : [],
    user_roles: db ? q(db, 'SELECT * FROM user_roles') : [],
    wirings:    db ? q(db, `SELECT mga.*, ag.name as agent_group_name, mg.channel_type, mg.platform_id, mg.name as mg_name
      FROM messaging_group_agents mga
      JOIN agent_groups ag ON ag.id = mga.agent_group_id
      JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
      ORDER BY ag.name, mg.channel_type`) : [],
  };
  try { db?.close(); } catch {}

  const [containers, dockerInfo, dockerImages, dockerNetworks, dockerVolumes, disk, tailscale, snapUpdates, logMetrics] =
    await Promise.all([collectContainers(), getDockerInfo(), getDockerImages(), getDockerNetworks(), getDockerVolumes(), collectDisk(), collectTailscale(), collectSnapUpdates(), collectLogMetrics()]);
  const tokenMetrics = collectTokenMetrics();

  snap.rate_limits     = collectRateLimitMetrics();
  snap.agent_detail    = collectAgentDetail();
  snap.containers      = containers;
  snap.docker_info     = dockerInfo;
  snap.docker_images   = dockerImages;
  snap.docker_networks = dockerNetworks;
  snap.docker_volumes  = dockerVolumes;
  const sessionData    = collectSessionData();
  snap.session_data    = sessionData;
  // msg_metrics: keyed by sessionId for quick lookup in the frontend
  const msgMetricsMap: Record<string, unknown> = {};
  for (const sd of sessionData) {
    if ((sd as Record<string, unknown>).msgMetrics != null)
      msgMetricsMap[(sd as Record<string, unknown>).sessionId as string] = (sd as Record<string, unknown>).msgMetrics;
  }
  snap.msg_metrics = msgMetricsMap;
  snap.token_metrics   = tokenMetrics;
  snap.system = {
    memory:  collectMemory(),
    cpu:     collectCpu(),
    load:    collectLoadavg(),
    uptime:  collectUptime(),
    network: collectNetwork(),
    diskIo:  collectDiskIo(),
    os:      collectOsInfo(),
    disk,
    updates: { apt: collectAptUpdates(), snap: snapUpdates, brew: collectBrewUpdates() },
    tailscale,
    logMetrics,
  };
  return snap;
}

// ─── Log metrics ─────────────────────────────────────────────────────────────

function logLineLevel(line: string): 'fatal' | 'error' | 'warn' | null {
  const c = line.replace(/\x1b\[[0-9;]*m/g, '');
  if (/ FATAL | \[FATAL\]/.test(c)) return 'fatal';
  if (/ ERROR | \[ERROR\]/.test(c)) return 'error';
  if (/ WARN | \[WARN\]/.test(c))  return 'warn';
  return null;
}

function logLineTimeMs(line: string): number | null {
  const m = line.match(/^\[(\d{2}):(\d{2}):(\d{2})\.(\d{3})\]/);
  if (!m) return null;
  return +m[1] * 3600000 + +m[2] * 60000 + +m[3] * 1000 + +m[4];
}

async function collectLogMetrics() {
  const logFile = path.join(LOGS_DIR, 'nanoclaw.error.log');
  if (!existsSync(logFile)) return null;

  let lines: string[];
  try {
    const proc = Bun.spawn(['tail', '-n', '8000', logFile], { stdout: 'pipe' });
    lines = (await new Response(proc.stdout).text()).split('\n').filter(l => l.trim());
  } catch { return null; }
  if (!lines.length) return null;

  // Reconstruct absolute timestamps: walk backward from last line, detect midnight crossings
  const now = Date.now();
  const nowTod = now % 86400000;           // ms since midnight (UTC)
  const todayBase = now - nowTod;

  const lastTod = logLineTimeMs(lines[lines.length - 1]);
  // If last log entry is more than 1 min in the "future", the log was written before midnight
  let dayBase = (lastTod !== null && lastTod > nowTod + 60000) ? todayBase - 86400000 : todayBase;

  const absTs: number[] = new Array(lines.length).fill(0);
  let prevTod: number | null = null;

  for (let i = lines.length - 1; i >= 0; i--) {
    const tod = logLineTimeMs(lines[i]);
    if (tod === null) { absTs[i] = 0; continue; }
    // Going backward: if tod > prevTod we crossed midnight (day boundary)
    if (prevTod !== null && tod > prevTod + 3600000) dayBase -= 86400000;
    absTs[i] = dayBase + tod;
    prevTod = tod;
  }

  const cutoff24h = now - 86400000;
  const hourly = Array.from({ length: 24 }, (_, i) => ({
    hour: new Date(now - (23 - i) * 3600000).getUTCHours(),
    warn: 0, error: 0, fatal: 0,
  }));
  const totals = { warn: 0, error: 0, fatal: 0 };
  const p1h    = { warn: 0, error: 0 };
  const p6h    = { warn: 0, error: 0 };
  const recent: string[] = [];

  for (let i = lines.length - 1; i >= 0; i--) {
    const ts = absTs[i];
    if (!ts || ts < cutoff24h) continue;
    const lvl = logLineLevel(lines[i]);
    if (!lvl) continue;

    totals[lvl]++;
    const hoursAgo = Math.min(23, Math.floor((now - ts) / 3600000));
    const bucket = hourly[23 - hoursAgo];
    bucket[lvl]++;

    if (hoursAgo < 1) { if (lvl !== 'warn') p1h.error++; else p1h.warn++; }
    if (hoursAgo < 6) { if (lvl !== 'warn') p6h.error++; else p6h.warn++; }

    if (lvl !== 'warn' && recent.length < 6)
      recent.push(lines[i].replace(/\x1b\[[0-9;]*m/g, '').slice(0, 220));
  }

  return { totals, p1h, p6h, hourly, recentErrors: recent.reverse() };
}

// ─── Log streaming ───────────────────────────────────────────────────────────

const logSubs = new Set<(c: Uint8Array) => void>();
let logOffset = 0;
let errLogOffset = 0;
const enc = new TextEncoder();

function tailFile(filePath: string, offsetRef: { v: number }, onLines: (lines: string[]) => void) {
  if (!existsSync(filePath)) return;
  try { offsetRef.v = statSync(filePath).size; } catch { return; }
  setInterval(() => {
    try {
      const size = statSync(filePath).size;
      if (size < offsetRef.v) { offsetRef.v = size; return; }
      if (size === offsetRef.v) return;
      const buf = Buffer.alloc(size - offsetRef.v);
      const fd = openSync(filePath, 'r');
      readSync(fd, buf, 0, buf.length, offsetRef.v);
      closeSync(fd);
      offsetRef.v = size;
      const lines = buf.toString().split('\n').filter(l => l.trim()).map(l => l.replace(ANSI_RE, ''));
      if (lines.length) onLines(lines);
    } catch { /* skip */ }
  }, 2000);
}

function initLogTail() {
  const broadcast = (lines: string[]) => {
    if (!logSubs.size) return;
    const msg = enc.encode(`data: ${JSON.stringify(lines)}\n\n`);
    for (const sub of logSubs) { try { sub(msg); } catch { logSubs.delete(sub); } }
  };
  tailFile(path.join(LOGS_DIR, 'nanoclaw.log'),       { v: logOffset },    broadcast);
  tailFile(path.join(LOGS_DIR, 'nanoclaw.error.log'), { v: errLogOffset }, broadcast);
}

// ─── HTTP server ─────────────────────────────────────────────────────────────

const PUBLIC = path.join(import.meta.dir, 'public');
Bun.serve({
  port: PORT,
  idleTimeout: 30,
  async fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname === '/' || pathname === '/index.html')
      return new Response(Bun.file(path.join(PUBLIC, 'index.html')), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    if (pathname === '/api/data')
      return Response.json(await buildSnapshot());
    if (pathname === '/api/logs/history') {
      try {
        const readLog = (f: string) => existsSync(f)
          ? readFileSync(f, 'utf-8').split('\n').filter(l => l.trim()).map(l => l.replace(ANSI_RE, ''))
          : [];
        const main  = readLog(path.join(LOGS_DIR, 'nanoclaw.log'));
        const error = readLog(path.join(LOGS_DIR, 'nanoclaw.error.log'));
        // Merge and sort by line prefix (ISO timestamp), dedup exact duplicates
        const all = [...new Set([...main, ...error])].sort().slice(-500);
        return Response.json({ lines: all });
      } catch { return Response.json({ lines: [] }); }
    }
    if (pathname === '/api/logs/stream') {
      let sub: ((c: Uint8Array) => void) | null = null;
      const stream = new ReadableStream({
        start(ctrl) { sub = chunk => { try { ctrl.enqueue(chunk); } catch { if (sub) logSubs.delete(sub); } }; logSubs.add(sub); ctrl.enqueue(enc.encode(': connected\n\n')); },
        cancel() { if (sub) logSubs.delete(sub); },
      });
      return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' } });
    }
    if (pathname === '/docs')
      return new Response(Bun.file(path.join(PUBLIC, 'docs.html')), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    if (pathname === '/insights/latest') {
      const p = path.join(DATA_DIR, 'insights-latest.html');
      if (existsSync(p)) return new Response(Bun.file(p), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      return new Response('<p style="font-family:sans-serif;padding:2rem">Noch keine Insights generiert. Cron-Job ausführen: <code>scripts/claude-insights.sh</code></p>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    return new Response('Not found', { status: 404 });
  },
});
initLogTail();
console.log(`NanoClaw Dashboard → http://localhost:${PORT}`);
