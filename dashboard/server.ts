import { Database } from 'bun:sqlite';
import { existsSync, readdirSync, readFileSync, openSync, readSync, closeSync, statSync } from 'fs';
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
  let extraOut = 0;

  // Oldest token timestamp inside 5h window — used to compute resetInMs
  let oldest5hTs: number | null = null;

  function scanFile(filePath: string) {
    try {
      const lines = readFileSync(filePath, 'utf-8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line);
          if (e.type !== 'assistant' || !e.message?.usage || !e.timestamp) continue;
          const ts = new Date(e.timestamp).getTime();
          if (isNaN(ts)) continue;
          const outputTokens: number = e.message.usage.output_tokens || 0;
          const tier: string = e.message.usage.service_tier || 'standard';
          const age = now - ts;

          if (age <= window7dMs) {
            out7d += outputTokens;
            if (age <= window24hMs) {
              out24h += outputTokens;
              if (age <= window5hMs) {
                out5h += outputTokens;
                if (oldest5hTs === null || ts < oldest5hTs) oldest5hTs = ts;
              }
            }
          }
          if (tier !== 'standard') extraOut += outputTokens;
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

  return {
    window5h:    { outputTokens: out5h,  resetInMs },
    daily:       { outputTokens: out24h, date: dailyDate },
    weekly:      { outputTokens: out7d },
    extraOutput: extraOut,
    limits:      { h5: LIMIT_5H, h24: LIMIT_24H, d7: LIMIT_7D },
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
    const now = Date.now();
    const todayUtcMs = now - (now % 86400000);
    const last7dMs   = now - 7 * 86400000;
    const last24hMs  = now - 86400000;

    // ── inbound queries ──────────────────────────────────────────────────────
    let inDb: Database | null = null;
    let total = 0, today = 0, last7d = 0, pending = 0;
    const byHour: number[] = new Array(24).fill(0);
    const byKind: Record<string, number> = {};
    let lastInMs: number | null = null;
    let recentMessages: { timestamp: number; kind: string; text: string }[] = [];

    if (existsSync(inDbPath)) {
      try {
        inDb = new Database(inDbPath, { readonly: true });

        // Total (excluding system)
        const totRow = inDb.query<{ cnt: number }, []>(
          "SELECT COUNT(*) AS cnt FROM messages_in WHERE kind != 'system'"
        ).get();
        total = totRow?.cnt ?? 0;

        // Today
        const todayRow = inDb.query<{ cnt: number }, [number]>(
          "SELECT COUNT(*) AS cnt FROM messages_in WHERE kind != 'system' AND timestamp >= ?"
        ).get(todayUtcMs);
        today = todayRow?.cnt ?? 0;

        // Last 7 days
        const last7Row = inDb.query<{ cnt: number }, [number]>(
          "SELECT COUNT(*) AS cnt FROM messages_in WHERE kind != 'system' AND timestamp >= ?"
        ).get(last7dMs);
        last7d = last7Row?.cnt ?? 0;

        // Pending
        const pendRow = inDb.query<{ cnt: number }, []>(
          "SELECT COUNT(*) AS cnt FROM messages_in WHERE status = 'pending'"
        ).get();
        pending = pendRow?.cnt ?? 0;

        // byHour — last 24h
        const hourRows = inDb.query<{ ts: number }, [number]>(
          "SELECT timestamp AS ts FROM messages_in WHERE timestamp >= ?"
        ).all(last24hMs);
        for (const row of hourRows) {
          const hourIdx = new Date(row.ts).getUTCHours();
          byHour[hourIdx] = (byHour[hourIdx] ?? 0) + 1;
        }

        // byKind
        const kindRows = inDb.query<{ kind: string; cnt: number }, []>(
          "SELECT kind, COUNT(*) AS cnt FROM messages_in GROUP BY kind"
        ).all();
        for (const row of kindRows) { byKind[row.kind] = row.cnt; }

        // lastActivityMs
        const lastInRow = inDb.query<{ mx: number | null }, []>(
          "SELECT MAX(timestamp) AS mx FROM messages_in"
        ).get();
        lastInMs = lastInRow?.mx ?? null;

        // recentMessages
        const recRows = inDb.query<{ timestamp: number; kind: string; content: string }, []>(
          "SELECT timestamp, kind, content FROM messages_in ORDER BY timestamp DESC LIMIT 5"
        ).all();
        recentMessages = recRows.map(r => ({
          timestamp: r.timestamp,
          kind:      r.kind ?? '',
          text:      extractText(r.content),
        }));
      } finally {
        try { inDb?.close(); } catch {}
      }
    }

    // ── outbound queries ─────────────────────────────────────────────────────
    let outDb: Database | null = null;
    let deliveryErrors = 0;
    let lastOutMs: number | null = null;
    let outTimestamps: number[] = [];

    if (existsSync(outDbPath)) {
      try {
        outDb = new Database(outDbPath, { readonly: true });

        // deliveryErrors
        const deRow = outDb.query<{ cnt: number }, []>(
          "SELECT COUNT(*) AS cnt FROM messages_out WHERE delivered IS NOT NULL AND json_extract(delivered, '$.status') != 'delivered'"
        ).get();
        deliveryErrors = deRow?.cnt ?? 0;

        // lastActivityMs for outbound
        const lastOutRow = outDb.query<{ mx: number | null }, []>(
          "SELECT MAX(timestamp) AS mx FROM messages_out"
        ).get();
        lastOutMs = lastOutRow?.mx ?? null;

        // outbound timestamps for median response time
        const outRows = outDb.query<{ ts: number }, []>(
          "SELECT timestamp AS ts FROM messages_out ORDER BY timestamp ASC"
        ).all();
        outTimestamps = outRows.map(r => r.ts);
      } finally {
        try { outDb?.close(); } catch {}
      }
    }

    // ── medianResponseMs ─────────────────────────────────────────────────────
    let medianResponseMs: number | null = null;
    if (existsSync(inDbPath) && outTimestamps.length > 0) {
      let inDb2: Database | null = null;
      try {
        inDb2 = new Database(inDbPath, { readonly: true });
        const inRows = inDb2.query<{ ts: number }, []>(
          "SELECT timestamp AS ts FROM messages_in WHERE kind != 'system' ORDER BY timestamp ASC"
        ).all();
        const inTs = inRows.map(r => r.ts);

        // Pair each inbound message with the first outbound message that comes after it
        const deltas: number[] = [];
        let outIdx = 0;
        for (const its of inTs) {
          while (outIdx < outTimestamps.length && outTimestamps[outIdx] <= its) outIdx++;
          if (outIdx < outTimestamps.length) {
            deltas.push(outTimestamps[outIdx] - its);
          }
        }
        if (deltas.length > 0) {
          deltas.sort((a, b) => a - b);
          const mid = Math.floor(deltas.length / 2);
          medianResponseMs = deltas.length % 2 === 0
            ? Math.round((deltas[mid - 1] + deltas[mid]) / 2)
            : deltas[mid];
        }
      } finally {
        try { inDb2?.close(); } catch {}
      }
    }

    // ── lastActivityMs ───────────────────────────────────────────────────────
    let lastActivityMs: number | null = null;
    if (lastInMs !== null && lastOutMs !== null) lastActivityMs = Math.max(lastInMs, lastOutMs);
    else if (lastInMs !== null) lastActivityMs = lastInMs;
    else if (lastOutMs !== null) lastActivityMs = lastOutMs;

    return { total, today, last7d, pending, byHour, byKind, medianResponseMs, deliveryErrors, lastActivityMs, recentMessages };
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
        mga.session_mode, mga.engage_mode, mga.pattern,
        mga.unknown_sender_policy, mga.priority,
        mg.channel_type, mg.platform_id, mg.name as mg_name
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
          pattern:              String(row.pattern               ?? ''),
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
    updates: { apt: collectAptUpdates(), snap: snapUpdates },
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
const enc = new TextEncoder();

function initLogTail() {
  const logFile = path.join(LOGS_DIR, 'nanoclaw.log');
  if (!existsSync(logFile)) return;
  try { logOffset = statSync(logFile).size; } catch { return; }
  setInterval(() => {
    if (logSubs.size === 0) return;
    try {
      const size = statSync(logFile).size;
      if (size < logOffset) { logOffset = size; return; }
      if (size === logOffset) return;
      const buf = Buffer.alloc(size - logOffset);
      const fd = openSync(logFile, 'r');
      readSync(fd, buf, 0, buf.length, logOffset);
      closeSync(fd);
      logOffset = size;
      const lines = buf.toString().split('\n').filter(l => l.trim()).map(l => l.replace(ANSI_RE, ''));
      if (!lines.length) return;
      const msg = enc.encode(`data: ${JSON.stringify(lines)}\n\n`);
      for (const sub of logSubs) { try { sub(msg); } catch { logSubs.delete(sub); } }
    } catch { /* skip */ }
  }, 2000);
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
      const logFile = path.join(LOGS_DIR, 'nanoclaw.log');
      if (!existsSync(logFile)) return Response.json({ lines: [] });
      try { return Response.json({ lines: readFileSync(logFile, 'utf-8').split('\n').filter(l => l.trim()).slice(-400).map(l => l.replace(ANSI_RE, '')) }); }
      catch { return Response.json({ lines: [] }); }
    }
    if (pathname === '/api/logs/stream') {
      let sub: ((c: Uint8Array) => void) | null = null;
      const stream = new ReadableStream({
        start(ctrl) { sub = chunk => { try { ctrl.enqueue(chunk); } catch { if (sub) logSubs.delete(sub); } }; logSubs.add(sub); ctrl.enqueue(enc.encode(': connected\n\n')); },
        cancel() { if (sub) logSubs.delete(sub); },
      });
      return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' } });
    }
    return new Response('Not found', { status: 404 });
  },
});
initLogTail();
console.log(`NanoClaw Dashboard → http://localhost:${PORT}`);
