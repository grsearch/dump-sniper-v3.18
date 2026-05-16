'use strict';

/**
 * JitoBundleClient — Jito Block Engine API 客户端
 *
 * v3.18 (Week 1): 为 atomic bundle 模式准备的独立模块
 *
 * 功能:
 *   1. sendBundle: 提交 bundle 到 Jito,多 region 并发竞速
 *   2. getBundleStatuses / getInflightBundleStatuses: 查 bundle 状态
 *   3. getTipFloor: 拉当前 Jito tip 拍卖 floor(75th percentile),用于动态调 tip
 *   4. getTipAccounts: 拉 Jito 官方 8 个 tip wallet(虽然写死了,提供 API 兜底)
 *
 * 关键事实(基于 Jito 官方文档):
 *   - Bundle 完全免费,无需 auth(default sends)
 *   - 5 region endpoints: frankfurt/amsterdam/ny/tokyo/slc
 *   - 单 bundle max 5 tx
 *   - 最低 tip 1000 lamports (0.000001 SOL),但实战 0.001-0.01 SOL
 *   - Bundle atomic: 任何一笔 tx 失败整个 bundle 不上链
 *   - 只在 Jito-Solana validator 出块时被处理(~30-40% 的 slot)
 *
 * 这个 client 与现有 Helius Sender / Slipstream 路径完全独立。
 * Executor 通过 side='BUY_BUNDLE' 走这条路径。
 */

const axios = require('axios');
const bs58 = require('bs58').default || require('bs58');

// Jito 官方 8 个 tip accounts (写死,getTipAccounts API 偶尔慢或挂)
const JITO_TIP_ACCOUNTS = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
];

// Jito 5 region block engines
const JITO_REGIONS = {
  global: 'https://mainnet.block-engine.jito.wtf',
  frankfurt: 'https://frankfurt.mainnet.block-engine.jito.wtf',
  amsterdam: 'https://amsterdam.mainnet.block-engine.jito.wtf',
  ny: 'https://ny.mainnet.block-engine.jito.wtf',
  tokyo: 'https://tokyo.mainnet.block-engine.jito.wtf',
  slc: 'https://slc.mainnet.block-engine.jito.wtf',
};

// Tip floor API (拉拍卖 percentile,用来动态调 tip)
const JITO_TIP_FLOOR_URL = 'https://bundles.jito.wtf/api/v1/bundles/tip_floor';

class JitoBundleClient {
  /**
   * @param {object} opts
   * @param {string[]} [opts.regions=['global','frankfurt']] 启用的 region 列表
   *        建议: 默认 global+frankfurt,后期根据服务器位置调
   * @param {number} [opts.requestTimeoutMs=3000] 单次 HTTP 请求超时
   * @param {boolean} [opts.dryRun=false] DRY_RUN 模式不真发,只 log
   * @param {object} [opts.monitor=null] HealthMonitor 实例,用于打 counter
   */
  constructor(opts = {}) {
    const requestedRegions = opts.regions || ['global', 'frankfurt'];
    this.regions = requestedRegions
      .map((r) => ({ name: r, url: JITO_REGIONS[r] }))
      .filter((r) => r.url);
    if (this.regions.length === 0) {
      throw new Error('JitoBundleClient: no valid regions configured');
    }

    this.requestTimeoutMs = opts.requestTimeoutMs ?? 3000;
    this.dryRun = !!opts.dryRun;
    this.monitor = opts.monitor || null;

    // Tip floor 缓存 (避免每次 BUY 都拉)
    this._tipFloorCache = null;
    this._tipFloorCacheAt = 0;
    this._tipFloorCacheMs = 5000; // 5 秒刷新一次

    // 后台 tip floor 预拉,首次 BUY 不阻塞
    this._tipFloorTimer = null;
  }

  _counterInc(name, by = 1) {
    if (this.monitor) this.monitor.inc(`JitoBundle.${name}`, by, 'JitoBundle');
  }

  _counterSet(name, value) {
    if (this.monitor) this.monitor.set(`JitoBundle.${name}`, value, 'JitoBundle');
  }

  /** 启动后台 tip floor 预拉 (避免 BUY 时阻塞)。在 Executor 启动时调用一次。 */
  startBackgroundTipPoll(intervalMs = 5000) {
    if (this._tipFloorTimer) return;
    const tick = async () => {
      try {
        await this._fetchTipFloor();
      } catch (_) { /* 忽略 */ }
    };
    tick(); // 立即拉一次
    this._tipFloorTimer = setInterval(tick, intervalMs);
  }

  stopBackgroundTipPoll() {
    if (this._tipFloorTimer) {
      clearInterval(this._tipFloorTimer);
      this._tipFloorTimer = null;
    }
  }

  /**
   * 拉 Jito tip floor,缓存 5s
   * @returns {Promise<object>} { p25, p50, p75, p95, p99, ema50 } 单位 SOL
   */
  async _fetchTipFloor() {
    const now = Date.now();
    if (this._tipFloorCache && now - this._tipFloorCacheAt < this._tipFloorCacheMs) {
      return this._tipFloorCache;
    }
    try {
      const { data } = await axios.get(JITO_TIP_FLOOR_URL, { timeout: 2000 });
      // API 返回 [{ time, landed_tips_25th_percentile, ... }]
      const row = Array.isArray(data) ? data[0] : data;
      if (!row) throw new Error('empty tip floor response');
      const floor = {
        p25: row.landed_tips_25th_percentile || 0,
        p50: row.landed_tips_50th_percentile || 0,
        p75: row.landed_tips_75th_percentile || 0,
        p95: row.landed_tips_95th_percentile || 0,
        p99: row.landed_tips_99th_percentile || 0,
        ema50: row.ema_landed_tips_50th_percentile || 0,
      };
      this._tipFloorCache = floor;
      this._tipFloorCacheAt = now;
      this._counterSet('tipFloor_p75_lamports', Math.floor(floor.p75 * 1e9));
      this._counterSet('tipFloor_p95_lamports', Math.floor(floor.p95 * 1e9));
      return floor;
    } catch (err) {
      this._counterInc('tipFloorFetchFailed');
      // 失败时返回兜底值
      if (this._tipFloorCache) return this._tipFloorCache;
      return { p25: 0.000005, p50: 0.00001, p75: 0.00003, p95: 0.0015, p99: 0.01, ema50: 0.00001 };
    }
  }

  /**
   * 推荐的 tip 数额(lamports),基于当前 floor 动态计算
   *
   * 策略:
   *   - 取 p75 + safety buffer (确保进 top 25% bundle)
   *   - 加 1.5x buffer 防止 floor 短暂飙升
   *   - 设最低 1_000_000 lamports (0.001 SOL) 保底
   *   - 设最高 maxTipLamports 防止意外烧钱
   *
   * @param {object} opts
   * @param {number} [opts.minLamports=1000000] 最低 tip
   * @param {number} [opts.maxLamports=20000000] 最高 tip (0.02 SOL)
   * @param {string} [opts.percentile='p75'] 用哪个 percentile 做基线
   * @param {number} [opts.bufferMultiplier=1.5] 在 percentile 上乘以的安全系数
   */
  async getRecommendedTipLamports(opts = {}) {
    const floor = await this._fetchTipFloor();
    const percentileKey = opts.percentile || 'p75';
    const baseSol = floor[percentileKey] || floor.p75 || 0.00003;
    const bufferMultiplier = opts.bufferMultiplier ?? 1.5;
    const rawLamports = Math.floor(baseSol * 1e9 * bufferMultiplier);
    const minLamports = opts.minLamports ?? 1_000_000;
    const maxLamports = opts.maxLamports ?? 20_000_000;
    return Math.max(minLamports, Math.min(maxLamports, rawLamports));
  }

  /**
   * 提交 bundle 到多 region,Promise.race 取第一个成功的 bundleId
   *
   * @param {Buffer[]} serializedTxs 已签名的 tx 列表,Buffer[]。每个最大 1232 bytes。
   *                                 max 5 个 (Jito 限制)
   * @param {object} [opts]
   * @returns {Promise<{bundleId, winningRegion, elapsedMs}>}
   */
  async sendBundle(serializedTxs, opts = {}) {
    if (!Array.isArray(serializedTxs) || serializedTxs.length === 0) {
      throw new Error('sendBundle: serializedTxs required');
    }
    if (serializedTxs.length > 5) {
      throw new Error(`sendBundle: max 5 txs per bundle (got ${serializedTxs.length})`);
    }
    for (let i = 0; i < serializedTxs.length; i++) {
      const tx = serializedTxs[i];
      if (!Buffer.isBuffer(tx) && !(tx instanceof Uint8Array)) {
        throw new Error(`sendBundle: tx[${i}] must be Buffer/Uint8Array (got ${typeof tx})`);
      }
      if (tx.length > 1232) {
        throw new Error(`sendBundle: tx[${i}] too large (${tx.length} > 1232 bytes)`);
      }
    }

    // 编码为 base58 (Jito API 要求)
    const encodedTxs = serializedTxs.map((tx) => bs58.encode(Buffer.from(tx)));

    if (this.dryRun) {
      console.log(`[JitoBundle:DRY] would send bundle with ${encodedTxs.length} txs:`);
      encodedTxs.forEach((enc, i) => {
        console.log(`  [${i}] sig=${enc.slice(0, 16)}.. (${serializedTxs[i].length} bytes)`);
      });
      this._counterInc('dryRunSent');
      return { bundleId: 'DRY_' + Date.now(), winningRegion: 'dry', elapsedMs: 0 };
    }

    const body = {
      jsonrpc: '2.0',
      id: 1,
      method: 'sendBundle',
      params: [encodedTxs],
    };

    const startTs = Date.now();
    const submitOne = async (region) => {
      const t0 = Date.now();
      try {
        const url = `${region.url}/api/v1/bundles`;
        const { data } = await axios.post(url, body, {
          timeout: this.requestTimeoutMs,
          headers: { 'Content-Type': 'application/json' },
        });
        if (data.error) {
          throw new Error(`${region.name} -> ${JSON.stringify(data.error)}`);
        }
        if (!data.result) {
          throw new Error(`${region.name} -> empty result`);
        }
        return { bundleId: data.result, region: region.name, elapsedMs: Date.now() - t0 };
      } catch (err) {
        throw new Error(`${region.name} (${Date.now() - t0}ms): ${err.message}`);
      }
    };

    // any-success race
    return new Promise((resolve, reject) => {
      let pending = this.regions.length;
      const errors = [];
      let resolved = false;
      this.regions.forEach((region) => {
        submitOne(region)
          .then((res) => {
            if (resolved) return;
            resolved = true;
            const totalMs = Date.now() - startTs;
            this._counterInc('sendBundleWon');
            this._counterInc(`sendBundleWonBy_${res.region}`);
            this._counterSet('lastSendBundleRaceMs', totalMs);
            resolve({
              bundleId: res.bundleId,
              winningRegion: res.region,
              elapsedMs: totalMs,
            });
          })
          .catch((err) => {
            errors.push(err.message);
            if (resolved) return;
            if (--pending === 0) {
              this._counterInc('sendBundleAllFailed');
              reject(new Error(`all Jito regions failed: ${errors.join(' | ')}`));
            }
          });
      });
    });
  }

  /**
   * 查 inflight bundle 状态 (轻量,优先用这个)
   * 返回 status: "Invalid" | "Pending" | "Landed" | "Failed"
   */
  async getInflightBundleStatus(bundleId) {
    if (this.dryRun && bundleId.startsWith('DRY_')) {
      return { status: 'Landed', landed_slot: 0, dryRun: true };
    }
    const body = {
      jsonrpc: '2.0',
      id: 1,
      method: 'getInflightBundleStatuses',
      params: [[bundleId]],
    };
    const region = this.regions[0]; // 用第一个 region 查就够
    const url = `${region.url}/api/v1/bundles`;
    try {
      const { data } = await axios.post(url, body, { timeout: 2000 });
      const value = data?.result?.value;
      if (Array.isArray(value) && value[0]) {
        return value[0]; // { bundle_id, status, landed_slot }
      }
      return { status: 'Unknown', landed_slot: null };
    } catch (err) {
      this._counterInc('getStatusFailed');
      return { status: 'Unknown', error: err.message };
    }
  }

  /**
   * 查 bundle 完整状态 (含 tx signatures, slot, err) —— 较重
   */
  async getBundleStatuses(bundleIds) {
    if (this.dryRun) {
      return bundleIds.map((id) => ({ bundleId: id, dryRun: true }));
    }
    const body = {
      jsonrpc: '2.0',
      id: 1,
      method: 'getBundleStatuses',
      params: [Array.isArray(bundleIds) ? bundleIds : [bundleIds]],
    };
    const region = this.regions[0];
    const url = `${region.url}/api/v1/bundles`;
    try {
      const { data } = await axios.post(url, body, { timeout: 3000 });
      return data?.result?.value || [];
    } catch (err) {
      this._counterInc('getStatusesFailed');
      return [];
    }
  }

  /** 拉 Jito 官方 tip accounts (兜底,默认用本地写死的列表) */
  async getTipAccounts() {
    try {
      const body = { jsonrpc: '2.0', id: 1, method: 'getTipAccounts', params: [] };
      const region = this.regions[0];
      const { data } = await axios.post(`${region.url}/api/v1/bundles`, body, {
        timeout: 2000,
      });
      if (Array.isArray(data?.result) && data.result.length > 0) return data.result;
    } catch (_) { /* 静默 */ }
    return JITO_TIP_ACCOUNTS.slice();
  }

  /** 随机选一个 tip account (写死的 8 个) */
  pickRandomTipAccount() {
    return JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)];
  }

  /** 把 tip 转账指令 (SystemProgram.transfer) 加到一笔 tx 里 —— 由 Executor 调用 */
  static get TIP_ACCOUNTS() {
    return JITO_TIP_ACCOUNTS.slice();
  }

  static get REGIONS() {
    return { ...JITO_REGIONS };
  }
}

module.exports = JitoBundleClient;
