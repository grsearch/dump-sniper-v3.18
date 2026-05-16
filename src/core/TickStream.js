'use strict';

/**
 * TickStream (v3.17: 多 region 订阅)
 * ===================================
 * 同时订阅多个 Helius LaserStream gRPC region（例如 FRA + AMS + EWR），
 * 谁先收到砸单 tx 就触发下游 — 用 signature LRU 去重。
 *
 * 为什么多 region：
 *   实测 LaserStream 推送延迟 116ms ~ 1528ms（13x 差异），其中 1.2~1.8s 的尾延迟主要来自
 *   "砸单方 tx 发到了离你订阅 region 远的 leader" → shred 传播 + Helius 节点接收都要时间。
 *   多 region 订阅取最快到达的那一份，能把那部分尾延迟压平。
 *
 * 关键设计：
 *   - 每个 region 独立一个 Client/stream，各自重连，互不影响
 *   - 监控列表变化时重建**所有** stream（保持简单，频次不高 — 一般添 token 是稀疏事件）
 *   - LRU signature 去重：最多 2000 项，5 分钟 TTL（覆盖最慢 region 的延迟范围）
 *   - 向后兼容：env 只配单一 endpoint 时退化成单 region 行为
 *
 * v1.1 历史修复保留：
 *   - 监控列表为空时不订阅（避免误订全网 Pump 流量）
 *   - accountInclude=[mints] + accountRequired=[PUMP_AMM_PROGRAM]
 *   - 监控列表变化时重建 stream
 *   - 自动重连 + 指数退避
 */

const Client = require('@triton-one/yellowstone-grpc').default;
const yellowstoneGrpc = require('@triton-one/yellowstone-grpc');
const { CommitmentLevel } = yellowstoneGrpc;
// v3.17.12: ShredStream UDP 数据源
let ShredListener;
try {
  ShredListener = require('shredstream').ShredListener;
} catch (_) {
  ShredListener = null; // SDK not installed → ShredStream disabled
}
// v3.17.6: @triton-one/yellowstone-grpc v1.4+ 要求 stream.write 收到 protobuf message
// 实例，而不是 plain JS object。新 napi-rs 路径下 plain object 会被静默拒收
// （TCP 连接 OK、subscribe 调用不报错、stream.write 不报错，但 server 端拒绝
//  序列化 → 永远收不到 data → "NEVER_BEAT" 告警）。
// SubscribeRequest.create() / SubscribeRequestFilterTransactions.create() 能把
// plain object 转成正确的 protobuf message。我们 defensive 导入：
//   - 优先用 .create()（新版 SDK）
//   - fallback 到 plain object（老版 SDK 兼容）
const SubscribeRequest = yellowstoneGrpc.SubscribeRequest || null;
const SubscribeRequestFilterTransactions =
  yellowstoneGrpc.SubscribeRequestFilterTransactions || null;
const EventEmitter = require('events');
const bs58Lib = require('bs58');
const bs58 = bs58Lib.default || bs58Lib;
const { config } = require('../config');
const { getMonitor } = require('../monitor/HealthMonitor');

const PUMP_AMM_PROGRAM_ID = config.programs.pumpAmm; // string

const monitor = getMonitor();
monitor.registerModule('TickStream', { staleMs: 90_000, label: 'LaserStream gRPC' });

// LRU + TTL signature 去重
// - 容量 2000：每秒砸盘信号数通常 < 10/s，5 分钟 = 300s → 最多 3000 项，2000 已经够
// - TTL 5 分钟：覆盖最慢 region 的尾延迟（实测 < 2s）+ 余量
const DEDUP_TTL_MS = 5 * 60_000;
const DEDUP_MAX = 2000;

class SignatureDedup {
  constructor() {
    this.map = new Map(); // signature → expireAt
  }
  /** 第一次见返回 true（应处理），重复返回 false（应丢弃） */
  shouldProcess(sig) {
    if (!sig) return true; // 没 signature 时不去重（保守）
    const now = Date.now();
    const existing = this.map.get(sig);
    if (existing && existing > now) {
      return false; // 重复
    }
    this.map.set(sig, now + DEDUP_TTL_MS);
    if (this.map.size > DEDUP_MAX) {
      this._evict(now);
    }
    return true;
  }
  _evict(now) {
    // 先清过期
    for (const [k, exp] of this.map) {
      if (exp <= now) this.map.delete(k);
      if (this.map.size <= DEDUP_MAX * 0.9) return;
    }
    // 还超容量 → 删最早写入的（Map 按插入顺序）
    while (this.map.size > DEDUP_MAX * 0.9) {
      const firstKey = this.map.keys().next().value;
      if (firstKey === undefined) break;
      this.map.delete(firstKey);
    }
  }
  size() {
    return this.map.size;
  }
}

/**
 * 单个 region 的连接实例。
 * 内部管理重连、订阅、生命周期。tx 来了上抛给 TickStream 由 dedup 统一过滤。
 */
class RegionStream {
  constructor({ endpoint, token, label, onTx, onConnected }) {
    this.endpoint = endpoint;
    this.token = token;
    this.label = label;
    this.onTx = onTx;
    this.onConnected = onConnected;

    this.client = null;
    this.stream = null;
    this.connected = false;
    this.reconnectAttempts = 0;
    this.shouldRun = false;
    this._currentMints = [];
  }

  async start(mints) {
    this.shouldRun = true;
    this._currentMints = Array.from(mints);
    if (this._currentMints.length === 0) {
      console.log(`[TickStream:${this.label}] no mints to watch, idle`);
      return;
    }
    await this._connect();
  }

  async stop() {
    this.shouldRun = false;
    await this._closeStream();
  }

  async rebuild(mints) {
    this._currentMints = Array.from(mints);
    await this._closeStream();
    await new Promise((r) => setTimeout(r, 500));
    if (this.shouldRun && this._currentMints.length > 0) {
      await this._connect();
    }
  }

  async _closeStream() {
    console.log('[TickStream:undefined] _closeStream called, stream=false, client=false');
    if (this.stream) {
      try { this.stream.end(); } catch (_) { /* ignore */ }
      this.stream = null;
    }
    if (this.client) {
      try {
        // v5: try to close the underlying gRPC client
        if (typeof this.client._connectedGrpcClient === 'object' && this.client._connectedGrpcClient !== null) {
          const grpcClient = this.client._connectedGrpcClient;
          if (typeof grpcClient.close === 'function') grpcClient.close();
        }
      } catch (_) { /* ignore */ }
      this.client = null;
    }
    this.connected = false;
  }

  async _connect() {
    if (this._currentMints.length === 0) return;
    try {
      this.client = new Client(
        this.endpoint,
        this.token,
        { 'grpc.max_receive_message_length': 64 * 1024 * 1024 },
      );
      // v5 API: must call connect() before subscribe()
      if (typeof this.client.connect === 'function') {
        await this.client.connect();
      }
      console.log(`[TickStream:${this.label}] connect() done, calling subscribe()...`);
      this.stream = await this.client.subscribe();
      console.log(`[TickStream:${this.label}] subscribe() returned, setting up handlers...`);

      this.stream.on('data', (msg) => this._handleMessage(msg));
      this.stream.on('error', (err) => this._handleError(err));
      this.stream.on('end', () => this._handleEnd());
      this.stream.on('close', () => this._handleEnd());

      await this._sendSubscribeRequest();
      this.connected = true;
      this.reconnectAttempts = 0;
      monitor.inc(`TickStream.${this.label}.connectsTotal`, 1, 'TickStream');
      monitor.beat('TickStream', `${this.label}:connected:${this._currentMints.length}_mints`);
      console.log(
        `[TickStream:${this.label}] connected, watching ${this._currentMints.length} mints`,
      );
      if (this.onConnected) this.onConnected(this.label);
    } catch (err) {
      monitor.recordError('TickStream', err, { phase: 'connect', region: this.label });
      console.error(`[TickStream:${this.label}] connect failed: ${err.message}`);
      this._scheduleReconnect();
    }
  }

  async _sendSubscribeRequest() {
    const mints = this._currentMints;
    if (mints.length === 0) return;

    // v3.17.6 兼容修复：新版 SDK 要求 protobuf message 实例
    // 先建 filter，再建 request；如果 .create 可用就用，否则 fallback plain object
    const filterPlain = {
      vote: false,
      failed: false,
      accountInclude: mints,
      accountExclude: [],
      accountRequired: [PUMP_AMM_PROGRAM_ID],
    };
    const filter = SubscribeRequestFilterTransactions
      ? SubscribeRequestFilterTransactions.create(filterPlain)
      : filterPlain;

    const requestPlain = {
      transactions: { pumpAmmTrades: filter },
      slots: {},
      accounts: {},
      blocks: {},
      blocksMeta: {},
      entry: {},
      transactionsStatus: {},
      accountsDataSlice: [],
      commitment: CommitmentLevel.PROCESSED,
    };
    const request = SubscribeRequest
      ? SubscribeRequest.create(requestPlain)
      : requestPlain;

    return new Promise((resolve, reject) => {
      this.stream.write(request, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  _handleMessage(msg) {
    if (!msg.transaction) return;
    monitor.inc(`TickStream.${this.label}.txReceived`, 1, 'TickStream');
    monitor.beat('TickStream', `${this.label}:tx`);
    this.onTx(msg.transaction, this.label);
  }

  _handleError(err) {
    monitor.inc(`TickStream.${this.label}.streamErrors`, 1, 'TickStream');
    monitor.recordError('TickStream', err, { phase: 'stream', region: this.label });
    console.error(`[TickStream:${this.label}] stream error: ${err.message || err}`);
    this.connected = false;
    this._scheduleReconnect();
  }

  _handleEnd() {
    if (!this.shouldRun) return;
    monitor.inc(`TickStream.${this.label}.streamEnded`, 1, 'TickStream');
    console.warn(`[TickStream:${this.label}] stream ended`);
    this.connected = false;
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (!this.shouldRun || this._currentMints.length === 0) return;
    monitor.inc(`TickStream.${this.label}.reconnects`, 1, 'TickStream');
    const delay = Math.min(30_000, 1000 * Math.pow(2, this.reconnectAttempts));
    this.reconnectAttempts += 1;
    console.log(
      `[TickStream:${this.label}] reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`,
    );
    setTimeout(() => {
      if (!this.shouldRun) return;
      this._connect();
    }, delay);
  }
}

/** 提取 tx signature（base58）—— 用于多 region 去重。 */
function extractSignature(txMessage) {
  try {
    // LaserStream gRPC: txMessage = {transaction: {signature, isVote, transaction, meta, index}, slot}
    // ShredStream: txMessage = {slot, transaction: {signatures: [Buffer]}}
    // 优先从 LaserStream 的 transaction.signature 取，然后 fallback 到 transaction.signatures[0]
    let sig = txMessage?.transaction?.signature;
    if (!sig) sig = txMessage?.transaction?.signatures?.[0];
    if (!sig) sig = txMessage?.signature; // 兜底
    if (!sig) return null;
    if (typeof sig === 'string') return sig;
    if (Buffer.isBuffer(sig)) return bs58.encode(sig);
    if (sig instanceof Uint8Array) return bs58.encode(Buffer.from(sig));
    // protobuf 对象兜底
    try {
      const buf = Buffer.from(sig);
      if (buf.length > 0) return bs58.encode(buf);
    } catch (_) {}
    return null;
  } catch (_) {
    return null;
  }
}

class TickStream extends EventEmitter {
  constructor() {
    super();
    this.watchedMints = new Set();
    this.shouldRun = false;
    // v3.17.7: 最新观察到的 slot（任何 region 都更新，dedup 去重不影响）
    //   用于 SignalEngine 判断"砸盘信号 vs 当前最新 slot"差距，过滤陈旧信号
    this._latestSlot = 0;

    this.regions = [];
    this.dedup = new SignatureDedup();
    this._sigFirstRegion = new Map(); // v3.17.12: sig → { region, ts }
    this._rebuildTimer = null;
    this._rebuildInProgress = false;
    this._rebuildQueued = false;

    // v3.17.13: SS 领先速度统计
    this._ssLeadSamples = []; // 最近 N 个样本 (ms, 正数=SS 快)
    this._ssLeadCounters = {
      ssFirstCount: 0,
      lsFirstCount: 0,
      ahFirstCount: 0,
      ssMatchedCount: 0,
      ssOrphanCount: 0,
    };
    this._ssLeadStatsTimer = null;

    // ---- Helius LaserStream regions ----
    const laserEndpoints = config.helius.laserstreamEndpoints || [];
    if (laserEndpoints.length === 0) {
      throw new Error(
        '[TickStream] no LaserStream endpoints configured. ' +
          'Set HELIUS_LASERSTREAM_ENDPOINTS (comma-separated) or HELIUS_LASERSTREAM_ENDPOINT.',
      );
    }
    laserEndpoints.forEach((ep, idx) => {
      const label = this._labelForEndpoint(ep, idx, 'LS');
      this.regions.push(
        new RegionStream({
          endpoint: ep,
          token: config.helius.laserstreamToken,
          label,
          onTx: (txMessage, region) => this._handleRegionTx(txMessage, region),
          onConnected: (region) => this.emit('regionConnected', region),
        }),
      );
    });

    // ---- AllenHark gRPC regions ----
    // AllenHark 也用 Yellowstone Geyser 协议，同 @triton-one/yellowstone-grpc 客户端
    // 作为额外数据源，IP 白名单制（无需 token 或用单独 token）
    const ahEndpoints = config.allenhark.grpcEndpoints || [];
    ahEndpoints.forEach((ep, idx) => {
      const label = this._labelForEndpoint(ep, idx, 'AH');
      this.regions.push(
        new RegionStream({
          endpoint: ep,
          token: config.allenhark.grpcToken || undefined,
          label,
          onTx: (txMessage, region) => this._handleRegionTx(txMessage, region),
          onConnected: (region) => this.emit('regionConnected', region),
        }),
      );
    });

    console.log(
      `[TickStream] initialized with ${this.regions.length} region(s): ` +
        this.regions.map((r) => r.label).join(', '),
    );

    // ---- v3.17.12: ShredStream UDP ----
    // ShredStream 推送的是已解码的完整交易，不经过 gRPC
    // 和 LaserStream 并行跑，谁先到用谁（同 signature dedup）
    this.shredStreamPort = parseInt(process.env.SHREDSTREAM_PORT || '0', 10);
    this._shredListener = null;
    this._shredStreamRunning = false;
    if (this.shredStreamPort > 0 && ShredListener) {
      console.log(`[TickStream:SS] ShredStream enabled on UDP port ${this.shredStreamPort}`);
    } else if (this.shredStreamPort > 0 && !ShredListener) {
      console.warn('[TickStream:SS] SHREDSTREAM_PORT set but shredstream SDK not installed');
    }
  }

  _labelForEndpoint(endpoint, idx, prefix = '') {
    const m = endpoint.match(/(?:^|[\.\/\:\-])(fra|ams|ewr|slc|tyo|sgp|lax|lon|pitt)\b/i);
    if (m) return (prefix ? prefix + '-' : '') + m[1].toUpperCase();
    try {
      const host = endpoint.replace(/^https?:\/\//, '').split(/[:/]/)[0];
      const first = host.split('.')[0];
      return (prefix ? prefix + '-' : '') + (first || `R${idx}`).toUpperCase().slice(0, 6);
    } catch (_) {
      return (prefix ? prefix + '-' : '') + `R${idx}`;
    }
  }

  async start(initialMints = []) {
    this.shouldRun = true;
    initialMints.forEach((m) => this.watchedMints.add(m));
    if (this.watchedMints.size === 0) {
      console.log('[TickStream] no tokens to watch yet, idle');
      return;
    }
    await Promise.all(this.regions.map((r) => r.start(this.watchedMints)));
    // v3.17.12: Start ShredStream
    this._startShredStream();
    // v3.17.13: 启动 SS lead stats 定时打印（每 60s）+ sigFirstRegion 清理
    this._ssLeadStatsTimer = setInterval(() => {
      this._cleanupSigFirstRegion();
      this._printSsLeadStats();
    }, 60_000);
  }

  async stop() {
    this.shouldRun = false;
    this._stopShredStream();
    if (this._ssLeadStatsTimer) {
      clearInterval(this._ssLeadStatsTimer);
      this._ssLeadStatsTimer = null;
    }
    await Promise.all(this.regions.map((r) => r.stop()));
  }

  async updateSubscription(mints) {
    this.watchedMints = new Set(mints);
    if (this._rebuildTimer) clearTimeout(this._rebuildTimer);
    this._rebuildTimer = setTimeout(() => {
      this._rebuildTimer = null;
      this._performRebuild().catch((err) => {
        monitor.recordError('TickStream', err, { phase: 'rebuild' });
        console.error(`[TickStream] rebuild failed: ${err.message}`);
      });
    }, 2000);
  }

  async _performRebuild() {
    if (this._rebuildInProgress) {
      this._rebuildQueued = true;
      return;
    }
    this._rebuildInProgress = true;
    try {
      do {
        this._rebuildQueued = false;
        const targetMints = new Set(this.watchedMints);
        console.log(
          `[TickStream] subscription change → rebuilding all ${this.regions.length} region(s) ` +
            `(${targetMints.size} mints)`,
        );
        await Promise.all(this.regions.map((r) => r.rebuild(targetMints)));
      } while (this._rebuildQueued);
    } finally {
      this._rebuildInProgress = false;
    }
  }

  /** 任一 region 收到 tx 时调用。signature 去重后才 emit 给下游。 */
  _handleRegionTx(txMessage, region) {
    const sig = extractSignature(txMessage);
    const isFirst = this.dedup.shouldProcess(sig);

    // v3.17.7: 跟踪最新 slot
    const slotRaw = txMessage?.slot;
    if (slotRaw != null) {
      const slot = typeof slotRaw === 'string' ? Number(slotRaw) : slotRaw;
      if (Number.isFinite(slot) && slot > this._latestSlot) {
        this._latestSlot = slot;
      }
    }

    if (!isFirst) {
      monitor.inc(`TickStream.${region}.dedup_dup`, 1, 'TickStream');
      monitor.inc('TickStream.dedupDups', 1, 'TickStream');
      // v3.17.13: dedup 命中,说明这个 sig 之前已经被另一个 region 看到了
      if (sig) {
        const firstInfo = this._sigFirstRegion.get(sig);
        if (firstInfo) {
          const leadMs = Date.now() - firstInfo.ts;
          this._recordRegionPair(firstInfo.region, region, leadMs);
          this._sigFirstRegion.delete(sig);
        }
      }
      return;
    }
    monitor.inc(`TickStream.${region}.dedup_first`, 1, 'TickStream');
    monitor.inc('TickStream.txReceived', 1, 'TickStream');
    monitor.beat('TickStream', `tx_first:${region}`);
    monitor.set('TickStream.dedupSize', this.dedup.size(), 'TickStream');
    monitor.set('TickStream.latestSlot', this._latestSlot, 'TickStream');
    if (sig) {
      this._sigFirstRegion.set(sig, { region, ts: Date.now() });
      if (region === 'SS') this._ssLeadCounters.ssFirstCount++;
      else if (region.startsWith('AH')) this._ssLeadCounters.ahFirstCount++;
      else this._ssLeadCounters.lsFirstCount++;
    } else {
      // sig is null — could not extract signature
    }
    this.emit('transaction', txMessage, { firstRegion: region });
  }

  /**
   * v3.17.13: 记录两个 region 之间的到达时间差
   */
  _recordRegionPair(firstRegion, secondRegion, leadMs) {
    let signedLead = null;
    if (firstRegion === 'SS' && !secondRegion.startsWith('AH') && secondRegion !== 'SS') {
      signedLead = leadMs;
      this._ssLeadCounters.ssMatchedCount++;
    } else if (secondRegion === 'SS' && !firstRegion.startsWith('AH') && firstRegion !== 'SS') {
      signedLead = -leadMs;
      this._ssLeadCounters.ssMatchedCount++;
    }
    if (signedLead !== null) {
      this._ssLeadSamples.push(signedLead);
      if (this._ssLeadSamples.length > 500) {
        this._ssLeadSamples.splice(0, this._ssLeadSamples.length - 500);
      }
      monitor.inc('TickStream.SS_LS_pairs', 1, 'TickStream');
    }
  }

  /**
   * v3.17.13: 清理过老的 _sigFirstRegion 条目
   */
  _cleanupSigFirstRegion() {
    const now = Date.now();
    const cutoff = now - 30_000;
    let orphanCount = 0;
    let ssOrphan = 0;
    for (const [sig, info] of this._sigFirstRegion) {
      if (info.ts < cutoff) {
        if (info.region === 'SS') ssOrphan++;
        this._sigFirstRegion.delete(sig);
        orphanCount++;
      }
    }
    if (ssOrphan > 0) this._ssLeadCounters.ssOrphanCount += ssOrphan;
    if (orphanCount > 0) {
      monitor.inc('TickStream.sigFirstRegion_cleaned', orphanCount, 'TickStream');
    }
  }

  /**
   * v3.17.13: 每 60 秒打印一次 SS lead 统计
   */
  _printSsLeadStats() {
    const samples = this._ssLeadSamples.slice();
    const c = this._ssLeadCounters;
    const totalFirst = c.ssFirstCount + c.lsFirstCount + c.ahFirstCount;

    if (samples.length === 0 && totalFirst === 0) {
      return;
    }

    const sorted = samples.slice().sort((a, b) => a - b);
    const n = sorted.length;
    const median = n > 0 ? sorted[Math.floor(n / 2)] : 0;
    const p95 = n > 0 ? sorted[Math.min(n - 1, Math.floor(n * 0.95))] : 0;
    const p05 = n > 0 ? sorted[Math.max(0, Math.floor(n * 0.05))] : 0;
    const mean = n > 0 ? Math.round(samples.reduce((s, v) => s + v, 0) / n) : 0;
    const ssWinCount = samples.filter((v) => v > 0).length;
    const lsWinCount = samples.filter((v) => v < 0).length;
    const ssWinPct = n > 0 ? Math.round((ssWinCount / n) * 100) : 0;

    monitor.set('TickStream.SS_lead_median_ms', median, 'TickStream');
    monitor.set('TickStream.SS_lead_p95_ms', p95, 'TickStream');
    monitor.set('TickStream.SS_lead_mean_ms', mean, 'TickStream');
    monitor.set('TickStream.SS_win_pct', ssWinPct, 'TickStream');
    monitor.set('TickStream.SS_samples', n, 'TickStream');
    monitor.set('TickStream.SS_first_count', c.ssFirstCount, 'TickStream');
    monitor.set('TickStream.LS_first_count', c.lsFirstCount, 'TickStream');
    monitor.set('TickStream.SS_orphan_count', c.ssOrphanCount, 'TickStream');

    console.log(
      `[TickStream:SS_STATS] over last hour (n=${n}): ` +
      `SS 领先 median=${median}ms p95=${p95}ms p05=${p05}ms mean=${mean}ms | ` +
      `SS 先到=${ssWinCount}/${n} (${ssWinPct}%) | ` +
      `LS 反而先到=${lsWinCount}/${n} | ` +
      `first 计数 SS=${c.ssFirstCount} LS=${c.lsFirstCount} AH=${c.ahFirstCount} | ` +
      `SS 孤儿(LS 漏掉)=${c.ssOrphanCount}`,
    );
  }

  // ─── v3.17.12: ShredStream UDP 数据源 ───────────────────────
  // ShredStream 推送原始交易（serialized VersionedTransaction），
  // 我们需要从中提取 Pump AMM 相关交易，构造和 LaserStream 兼容的 txMessage。
  // 关键：ShredStream 不做 gRPC 过滤，需要我们自己匹配 mint。

  _startShredStream() {
    if (this.shredStreamPort <= 0 || !ShredListener) return;
    if (this._shredStreamRunning) return;

    try {
      this._shredListener = ShredListener.bind(this.shredStreamPort);
      this._shredStreamRunning = true;
      console.log(`[TickStream:SS] bound to UDP ${this.shredStreamPort}`);

      // 启动异步消费循环
      this._shredLoop().catch((err) => {
        if (this._shredStreamRunning) {
          console.error(`[TickStream:SS] loop error: ${err.message}`);
          monitor.recordError('TickStream', err, { phase: 'shredstream_loop' });
        }
      });
    } catch (err) {
      console.error(`[TickStream:SS] bind failed: ${err.message}`);
      monitor.recordError('TickStream', err, { phase: 'shredstream_bind' });
    }
  }

  _stopShredStream() {
    this._shredStreamRunning = false;
    if (this._shredListener) {
      try {
        this._shredListener.close();
      } catch (_) {}
      this._shredListener = null;
    }
  }

  async _shredLoop() {
    const { VersionedTransaction, PublicKey } = require('@solana/web3.js');
    const PUMP_AMM = new Set([PUMP_AMM_PROGRAM_ID]);

    // v3.17.12: byte scan 预过滤 — 跳过 95%+ 无关交易，省掉昂贵的 deserialize
    const PUMP_AMM_BYTES = new PublicKey(PUMP_AMM_PROGRAM_ID).toBuffer();

    for await (const batch of this._shredListener) {
      if (!this._shredStreamRunning) break;

      const slot = Number(batch.slot);
      if (Number.isFinite(slot) && slot > this._latestSlot) {
        this._latestSlot = slot;
      }

      if (!batch.transactions || batch.transactions.length === 0) continue;

      let ssMatch = 0;
      for (const rawTx of batch.transactions) {
        try {
          // 快速 byte scan：检查 raw tx 是否包含 Pump AMM program ID
          const buf = Buffer.isBuffer(rawTx) ? rawTx : Buffer.from(rawTx);
          if (!buf.includes(PUMP_AMM_BYTES)) continue;

          const tx = VersionedTransaction.deserialize(new Uint8Array(rawTx));

          // v3.17.12: 快速 mint 过滤 — 跳过不涉及我们监控 mint 的交易
          // 只需检查 accountKeys 是否包含任何 watchedMint
          const accountKeys = tx.message.staticAccountKeys || [];
          let hasWatchedMint = false;
          for (const key of accountKeys) {
            if (this.watchedMints.has(key.toBase58())) {
              hasWatchedMint = true;
              break;
            }
          }
          if (!hasWatchedMint) continue;

          // 二次确认 Pump AMM（防误判）
          let hasPumpAmm = false;
          for (const key of accountKeys) {
            if (PUMP_AMM.has(key.toBase58())) {
              hasPumpAmm = true;
              break;
            }
          }
          if (!hasPumpAmm) continue;

          // 提取 signature
          const sigBytes = tx.signatures[0];
          const sig = sigBytes ? bs58.encode(Buffer.from(sigBytes)) : null;
          const isFirst = this.dedup.shouldProcess(sig);

          if (!isFirst) {
            monitor.inc('TickStream.SS.dedup_dup', 1, 'TickStream');
            // v3.17.13: SS 后到,前面有别的 region 先到了。算 lead time
            if (sig) {
              const firstInfo = this._sigFirstRegion.get(sig);
              if (firstInfo) {
                const leadMs = Date.now() - firstInfo.ts;
                this._recordRegionPair(firstInfo.region, 'SS', leadMs);
                this._sigFirstRegion.delete(sig);
              }
            }
            continue;
          }

          ssMatch++;
          monitor.inc('TickStream.SS.dedup_first', 1, 'TickStream');
          this._ssLeadCounters.ssFirstCount++;

          // 构造和 LaserStream 兼容的 txMessage
          const signatureBuffers = tx.signatures.map((s) => Buffer.from(s));
          const accountKeyBuffers = accountKeys.map((k) => k.toBuffer());

          const txMessage = {
            slot,
            transaction: {
              signatures: signatureBuffers,
              message: {
                accountKeys: accountKeyBuffers,
                instructions: tx.message.compiledInstructions?.map((ix) => ({
                  programIdIndex: ix.programIdIndex,
                  accounts: Array.from(ix.accountKeyIndexes),
                  data: Buffer.from(ix.data),
                })) || [],
              },
            },
            meta: {
              err: null,
              logMessages: null,
            },
          };

          monitor.inc('TickStream.txReceived', 1, 'TickStream');
          monitor.beat('TickStream', 'tx_first:SS');
          monitor.set('TickStream.dedupSize', this.dedup.size(), 'TickStream');
          monitor.set('TickStream.latestSlot', this._latestSlot, 'TickStream');
          if (sig) this._sigFirstRegion.set(sig, { region: 'SS', ts: Date.now() });
          this.emit('transaction', txMessage, { firstRegion: 'SS' });
        } catch (_) {
          // deserialize 失败（shred 可能不完整），跳过
        }
      }

      if (ssMatch > 0) {
        monitor.inc('TickStream.SS.pumpTxs', ssMatch, 'TickStream');
      }
    }
  }

  /** v3.17.7: 暴露 latestSlot 给 SignalEngine 做过期判断 */
  get latestSlot() {
    return this._latestSlot;
  }
}

module.exports = TickStream;
