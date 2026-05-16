'use strict';

/**
 * Executor (v3.1)
 * ===============
 * 直接调用 Pump.fun AMM (PumpSwap) 程序，不走 Jupiter aggregator。
 *
 * v3.1 vs v3.0 修复：
 *   - 修正 SDK API：旧的 swapAutocompleteBaseFromQuote/swapInstructions/Direction 已移除
 *     新 API: OnlinePumpAmmSdk.swapSolanaState(poolKey, user) + buyQuoteInput / sellBaseInput
 *   - 新增 blockhash 预缓存（每 5s 后台刷新），下单时直接用，省 ~30ms RPC
 *   - 新增 Sell 路径并发：链上余额查询 + swapSolanaState 并行
 *
 * SDK 调用流程：
 *   Buy:  OnlinePumpAmmSdk.swapSolanaState(poolKey, user) → state
 *         PumpAmmSdk.buyQuoteInput(state, quoteIn, slippagePct) → ix[]
 *   Sell: OnlinePumpAmmSdk.swapSolanaState(poolKey, user) → state
 *         PumpAmmSdk.sellBaseInput(state, baseIn, slippagePct) → ix[]
 */

const {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
  TransactionMessage,
  ComputeBudgetProgram,
  SystemProgram,
} = require('@solana/web3.js');
const bs58Lib = require('bs58');
const bs58 = bs58Lib.default || bs58Lib;
const BN = require('bn.js');

const { config } = require('../config');
const { getMonitor } = require('../monitor/HealthMonitor');

// AllenHark Slipstream SDK (lazy load)
let SlipstreamClient = null;
let slipstreamConfigBuilder = null;
let slipstreamPriorityFeeSpeed = null;
let slipstreamPriorityFeeConfig = null;
try {
  const slipstreamModule = require('@allenhark/slipstream');
  SlipstreamClient = slipstreamModule.SlipstreamClient;
  slipstreamConfigBuilder = slipstreamModule.configBuilder;
  const types = slipstreamModule;
  slipstreamPriorityFeeSpeed = types.PriorityFeeSpeed || null;
  slipstreamPriorityFeeConfig = types.PriorityFeeConfig || null;
} catch (_) {
  // @allenhark/slipstream not installed — Slipstream disabled
}

const monitor = getMonitor();
monitor.registerModule('Executor', { staleMs: 24 * 60 * 60_000, label: 'Trade Executor' });

class Executor {
  constructor() {
    this.dryRun = config.DRY_RUN;
    this._latestBuySlot = 0;  // BUY 提交时的链上 slot
    // v3.15 通道分流（Openclaw 发现：staked RPC 限流严格，70 token 刷新会打爆）
    //   - this.rpc：普通公共 RPC（用于 PoolStateCache 后台刷新 + getTransaction / getSignatureStatuses 等查询）
    //   - this.stakedRpc：staked 端点，**只用于 sendTransaction**（不参与缓存刷新）
    //   - this.senderEndpoint：Helius Sender（带 Jito 通道）
    this.rpc = new Connection(config.helius.rpcUrl, 'confirmed');
    this.stakedRpc = config.helius.stakedRpcUrl
      ? new Connection(config.helius.stakedRpcUrl, 'confirmed')
      : this.rpc;
    // v3.17: 多 region Sender — config.helius.senderEndpoints 已统一为数组
    //   单 endpoint 配置也会被收进数组（向后兼容）
    //   _submitTx 用 Promise.race 取最快返回，其余 region 会被忽略
    this.senderEndpoints = (config.helius.senderEndpoints || []).slice();
    // 保留 senderEndpoint 字段兼容老代码引用（取数组第一个）
    this.senderEndpoint = this.senderEndpoints[0] || config.helius.senderEndpoint || null;
    if (this.senderEndpoints.length > 1) {
      console.log(
        `[Executor] Helius Sender multi-region enabled: ${this.senderEndpoints.length} endpoints`,
      );
      this.senderEndpoints.forEach((ep) => console.log(`  - ${ep}`));
    } else if (this.senderEndpoint) {
      console.log(`[Executor] Helius Sender single endpoint: ${this.senderEndpoint}`);
    }

    if (!this.dryRun && config.wallet.privateKeyBs58) {
      const secret = bs58.decode(config.wallet.privateKeyBs58);
      this.keypair = Keypair.fromSecretKey(secret);
      console.log(`[Executor] wallet loaded: ${this.keypair.publicKey.toBase58()}`);
    } else {
      this.keypair = null;
    }

    // SDK 在 LIVE 模式才需要
    this.pumpSdk = null;       // PumpAmmSdk（指令构造）
    this.onlineSdk = null;     // OnlinePumpAmmSdk（state 拉取） — 走普通 RPC
    this.cacheSdk = null;      // v3.15 给 PoolStateCache 用，走普通 RPC（与 onlineSdk 实例分开避免共享 socket pool 限流）
    if (!this.dryRun) {
      try {
        const pumpModule = require('@pump-fun/pump-swap-sdk');
        const { PumpAmmSdk, OnlinePumpAmmSdk } = pumpModule;
        if (!PumpAmmSdk || !OnlinePumpAmmSdk) {
          throw new Error('SDK exports missing PumpAmmSdk / OnlinePumpAmmSdk');
        }
        this.pumpSdk = new PumpAmmSdk();
        // v3.15: onlineSdk 改用 this.rpc（普通节点），不再走 stakedRpc
        // 原因：stakedRpc（你的 donetta 专属端点）限流严格，70 token 刷新会打爆
        this.onlineSdk = new OnlinePumpAmmSdk(this.rpc);
        // v3.15: cacheSdk 独立实例，专给 PoolStateCache 用
        // 即使 onlineSdk 因 BUY 短时占用也不影响后台刷新
        this.cacheSdk = new OnlinePumpAmmSdk(this.rpc);
        console.log('[Executor] Pump AMM SDK loaded (onlineSdk + cacheSdk 都走普通 RPC，stakedRpc 仅用于 sendTx)');
      } catch (err) {
        console.error(`[Executor] failed to load @pump-fun/pump-swap-sdk: ${err.message}`);
      }
    }

    this.maxPriorityFeeLamports = config.maxPriorityFeeLamports;
    // v3.17.9 实战校正:CU limit 111K → 250K
    //   背景:v3.17.8 把 CU 降到 111K(对标 BABYTROLL slot 排名1的 93kgxYKe)
    //         但 openclaw 实战 5 笔 BUY 全部 ProgramFailedToComplete:
    //           Nigga:    CU limit 150K, consumed 150K → 爆
    //           GKC #1:   CU limit 150K, consumed 150K → 爆
    //           GKC #2:   CU limit 170K, consumed 170K → 爆
    //           CROWDCAM: CU limit 150K, consumed 149,403 → 99.6% 差点爆
    //           BABYTROLL: CU limit 150K, consumed 144,912 → 96.6% 差点爆
    //         总损失:5 × 0.04 SOL priority fee = 0.2 SOL 白花,token 没买到
    //   真相:Pump swap 实际 CU 消耗有很大方差(137K-200K+),不是固定 111K-150K
    //         BABYTROLL slot 那一次 93kgxYKe 用 111K 成功只是巧合(那笔 swap 状态简单)
    //         实战必须设到 250K 给足余量,避免 BUY_CHAIN_FAILED
    //   代价:CU 250K 后 μL/CU 排名会下降 → 需要拉高 priority fee 补偿
    //         配合 BUY_MIN_PRIORITY_FEE 0.04 → 0.067 SOL,μL/CU 仍为 267M
    //   ROI 算法:每笔多花 0.027 SOL priority fee 比每笔白花 0.04 fee 又没买到划算太多
    //   未来优化:不同代币不同 CU(根据历史消耗自动调) — 复杂度高,暂不做
    this.computeUnitLimit = parseInt(process.env.COMPUTE_UNIT_LIMIT || '250000', 10);

    // v3.5: 通过 setPoolStateCache 由外部注入（避免循环依赖 TokenRegistry）
    this.poolStateCache = null;

    // v3.17.8 实战调优:Jito tip 0 → 0.003 SOL(3M lamports)
    //   背景:BABYTROLL 数据显示 leader 排序看 μL/CU,Jito tip 不算其中
    //         顶级对手 93kgxYKe / 3fZftz6m 都没用 tip
    //   但保留 0.003 作为 Jito 通道最低兜底:
    //     - Helius Sender 走 Jito 通道需要 tip ≥ 0.001 SOL(实际推荐 0.003 更稳)
    //     - 不配 → tx 只走 staked validator 通道,错过 Jito 单 tx 拍卖机会
    //     - 配低 → 双通道(staked + Jito),0.003 SOL = 微小成本但保留可能性
    //   不再加大 tip:因为 leader 排序看 μL/CU,加大 tip 不提升 slot 内排名
    //   随机选 tip 账户(避免账户写锁竞争)
    this.jitoTipLamports = parseInt(process.env.JITO_TIP_LAMPORTS || '3000000', 10);

    // v3.16: Helius Sender 官方 tip 账户列表（10 个）—— 用于 Helius Sender 路径
    // ⚠️ 之前用的 Jito 官方 8 个账户是错的 — Helius Sender 拒绝它们
    // 来源: https://www.helius.dev/docs/sending-transactions/sender (2026)
    // 错误信息: "transaction must send a tip of at least 200000 lamports to one of
    //          the following Helius wallets"
    this.senderTipAccounts = [
      '4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE',
      'D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ',
      '9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta',
      '5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn',
      '2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD',
      '2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ',
      'wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF',
      '3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT',
      '4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey',
      '4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or',
    ];
    // 向后兼容(老代码引用)
    this.jitoTipAccounts = this.senderTipAccounts;

    // v3.18: Jito Bundle 官方 8 个 tip accounts —— 用于 Jito Bundle 路径
    // 来源: Jito getTipAccounts API
    // ⚠️ 跟 Helius Sender 的 10 个完全不同
    this.bundleTipAccounts = [
      '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
      'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
      'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
      'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
      'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
      'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
      'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
      '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
    ];

    // v3.18: Jito Bundle client — lazy init,只有启用 bundle 模式时才创建
    this.jitoBundleClient = null;
    this.bundleMode = config.execution?.useBundleMode === true;

    // ============ Priority fee oracle ============
    const PriorityFeeOracle = require('../utils/priorityFeeOracle');
    this.feeOracle = new PriorityFeeOracle();
    if (config.priorityFee.dynamic) {
      console.log(
        `[Executor] priority fee: dynamic (BUY=${config.priorityFee.buyLevel}, SELL=${config.priorityFee.sellLevel})`
      );
      console.log(
        `[Executor] BUY range: [${config.priorityFee.buyMinLamports} - ${config.priorityFee.buyCapLamports}] lamports`
      );
      console.log(
        `[Executor] SELL range: [${config.priorityFee.sellMinLamports} - ${config.priorityFee.sellCapLamports}] lamports`
      );
    } else {
      console.log(
        `[Executor] priority fee: static (BUY=${config.priorityFee.buyMaxLamports}, SELL=${config.priorityFee.sellMaxLamports})`
      );
    }

    // ============ Blockhash 预缓存 ============
    // 每 5s 后台拉一次 latestBlockhash，下单时直接用，省 ~30ms RPC
    // Solana blockhash 有效期 ~150 个 slot ≈ 60s，5s 缓存非常安全
    this._cachedBlockhash = null;
    this._cachedBlockhashAt = 0;
    this._blockhashTimer = null;
    if (!this.dryRun) {
      this._startBlockhashCache();
    }

    // ============ AllenHark Slipstream ============
    // leader-proximity-aware 交易中继，自动路由到离当前 leader 最近的 sender
    // BUY 时优先走 Slipstream（多 region + 多 sender 竞争），失败 fallback Helius Sender + staked RPC
    // SELL 仍走 staked RPC（不需要抢 slot）
    this.slipstreamClient = null;
    this._slipstreamReady = false;
    this._slipstreamInitAttempted = false;
    if (!this.dryRun && config.allenhark.slipstreamEnabled && config.allenhark.slipstreamApiKey) {
      // 延迟初始化 Slipstream：等 main 启动完成后再连
      // SDK 可能在 connect 过程中就触发 error event 导致未捕获异常
      // 延迟 + 临时 uncaught handler 保护
      setTimeout(() => this._initSlipstream(), 5000);
    } else if (!this.dryRun && config.allenhark.slipstreamEnabled) {
      console.warn('[Executor] Slipstream enabled but no API key (ALLENHARK_SLIPSTREAM_API_KEY) — disabled');
    }
  }

  _startBlockhashCache() {
    const refresh = async () => {
      try {
        const t0 = Date.now();
        const bh = await this.rpc.getLatestBlockhash('confirmed');
        this._cachedBlockhash = bh;
        this._cachedBlockhashAt = Date.now();
        monitor.set('Executor.blockhashAgeMs', 0, 'Executor');
        monitor.inc('Executor.blockhashRefreshOk', 1, 'Executor');
      } catch (err) {
        monitor.recordError('Executor', err, { phase: 'blockhash_refresh' });
      }
    };
    // 立即拉一次
    refresh();
    // 每 5s 刷新
    this._blockhashTimer = setInterval(refresh, 5000);
  }

  /**
   * 初始化 AllenHark Slipstream 客户端。
   *
   * Slipstream 特性：
   *   - 自动 discovery 找最近 worker（按延迟排名）
   *   - 协议 fallback: QUIC → gRPC → WebSocket → HTTP
   *   - leader-proximity 路由：实时 leader hint 指引 tx 到最近 sender
   *   - 每笔 tx 消耗 1 token (0.00005 SOL / 50K lamports)
   *   - 支持 broadcast_mode：同一笔 tx 同时发多个 region
   */
  async _initSlipstream() {
    if (this._slipstreamInitAttempted) return; // 防止并发初始化
    this._slipstreamInitAttempted = true;
    if (!SlipstreamClient || !slipstreamConfigBuilder) {
      console.error('[Executor:Slipstream] SDK not available — @allenhark/slipstream not installed or failed to load');
      return;
    }

    // 临时 uncaught exception handler：Slipstream SDK 在 connect() 过程中可能内部触发
    // 'error' event（例如 WS 认证失败），此时 client 还没返回，我们的 on('error') 来不及注册。
    // 这个临时 handler 会捕获这种情况，60s 后自动移除。
    let slipstreamInitError = null;
    const tempHandler = (err) => {
      if (err && err.message && (err.message.includes('API key') || err.message.includes('SlipstreamError'))) {
        slipstreamInitError = err;
        console.error(`[Executor:Slipstream] caught SDK error during init: ${err.message}`);
        return; // 吞掉，不让进程崩溃
      }
      // 其他 uncaught exception 不吞，让它走正常流程
      throw err;
    };
    process.on('uncaughtException', tempHandler);
    // 60s 后移除临时 handler
    const tempHandlerTimer = setTimeout(() => {
      process.off('uncaughtException', tempHandler);
    }, 60_000);

    try {
      const builder = slipstreamConfigBuilder()
        .apiKey(config.allenhark.slipstreamApiKey);

      // 首选 region
      if (config.allenhark.slipstreamRegion) {
        builder.region(config.allenhark.slipstreamRegion);
      }

      // Priority fee 优化（让 Slipstream 自动加 priority fee）
      if (slipstreamPriorityFeeConfig && slipstreamPriorityFeeSpeed) {
        const speedMap = {
          SLOW: slipstreamPriorityFeeSpeed.SLOW,
          FAST: slipstreamPriorityFeeSpeed.FAST,
          ULTRA_FAST: slipstreamPriorityFeeSpeed.ULTRA_FAST,
        };
        const speed = speedMap[config.allenhark.slipstreamFeeSpeed] || slipstreamPriorityFeeSpeed.ULTRA_FAST;
        const feeConfig = new slipstreamPriorityFeeConfig({
          enabled: true,
          speed,
          maxTip: config.allenhark.slipstreamMaxTipSol > 0 ? config.allenhark.slipstreamMaxTipSol : undefined,
        });
        builder.priorityFee(feeConfig);
      }

      // 订阅 leader hints（用于路由决策）
      builder.leaderHints(true);

      const cfg = builder.build();
      console.log('[Executor:Slipstream] connecting...');

      // 给 connect 加超时保护（30s）
      const connectPromise = SlipstreamClient.connect(cfg);
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('connect timeout (30s)')), 30_000),
      );
      this.slipstreamClient = await Promise.race([connectPromise, timeoutPromise]);

      // 立刻注册 error handler，防止后续 SDK 内部 error 事件崩溃进程
      // 注意：WS error 不影响 HTTP transport，不设置 _slipstreamReady=false
      // 因为 _submitViaSlipstream 用的是 client.http（独立于 WS）
      this.slipstreamClient.on('error', (err) => {
        monitor.recordError('Executor', err, { phase: 'slipstream_event' });
        console.error(`[Executor:Slipstream] event error (WS, non-fatal): ${err.message || err}`);
      });

      const info = this.slipstreamClient.connectionInfo();
      console.log(
        `[Executor:Slipstream] connected: region=${info.region}, protocol=${info.protocol}, ` +
          `session=${info.sessionId?.slice(0, 8) || 'n/a'}..`,
      );

      // v3.17.11: 移除 "0 senders → forcing HTTP fallback" 逻辑。
      // WS 模式下 senders 通过 leader hints 推送，初始时为空是正常的。
      // 强制 disconnect + reconnect 会导致 client 状态异常（http transport 丢失等）。
      // HTTP transport 在 _submitViaSlipstream 中直接使用，无需额外处理。
      if (info.protocol === 'websocket') {
        console.log('[Executor:Slipstream] WS mode — senders will populate via leader hints');
      }

      this._slipstreamReady = true;
      this._slipstreamErrorCount = 0; // 连接成功，重置错误计数

      // 连接/重连成功时重置错误计数
      this.slipstreamClient.on('connected', () => {
        this._slipstreamErrorCount = 0;
        this._slipstreamReady = true;
        console.log('[Executor:Slipstream] connected/reconnected — error count reset');
      });

      // 订阅 leader hints 用于日志/监控
      this.slipstreamClient.on('leaderHint', (hint) => {
        monitor.set('Executor.slipstreamLeaderRegion', hint.preferredRegion || '', 'Executor');
        monitor.set('Executor.slipstreamLeaderConfidence', hint.confidence || 0, 'Executor');
      });
      try {
        await this.slipstreamClient.subscribeLeaderHints();
      } catch(e) {
        console.warn(`[Executor:Slipstream] leader hints subscribe failed: ${e.message}`);
      }

      monitor.inc('Executor.slipstreamConnects', 1, 'Executor');
      monitor.beat('Executor', 'slipstream:connected');
      console.log('[Executor:Slipstream] ready — BUY transactions will route through Slipstream first');
    } catch (err) {
      this._slipstreamReady = false;
      this.slipstreamClient = null;
      monitor.recordError('Executor', err, { phase: 'slipstream_init' });
      console.error(`[Executor:Slipstream] init failed: ${err.message}`);
      if (err.message && err.message.includes('API key not found')) {
        console.error('[Executor:Slipstream] API key invalid — will NOT retry. Fix ALLENHARK_SLIPSTREAM_API_KEY and restart.');
      } else {
        this._slipstreamInitAttempted = false;
        setTimeout(() => this._initSlipstream(), 60_000);
      }
    } finally {
      clearTimeout(tempHandlerTimer);
      process.off('uncaughtException', tempHandler);
      if (slipstreamInitError) {
        this._slipstreamReady = false;
      }
    }
  }

  /**
   * 通过 AllenHark Slipstream 提交交易。
   *
   * @param {Buffer} serialized - 已签名的序列化交易
   * @param {'BUY'|'SELL'} side
   * @returns {string|null} signature 或 null（失败时）
   */
  async _submitViaSlipstream(serialized, side) {
    if (!this.slipstreamClient || !this.slipstreamClient.http) return null;
    try {
      const t0 = Date.now();
      const txBytes = new Uint8Array(serialized);

      // 关键：绕过 SDK 的 WS 提交通道（Senders=0 时 WS submit 会卡死），
      // 直接用 HTTP transport 提交。
      // SDK 内部优先级：QUIC → WS → HTTP，但 WS 认证/路由问题导致 submit 超时。
      // HTTP transport 更可靠，虽然延迟略高但不会卡死。
      const httpTransport = this.slipstreamClient.http;
      if (!httpTransport) {
        console.error('[Executor:Slipstream] no HTTP transport available — client.http is null');
        return null;
      }

      // BUY 用 broadcastMode：同时发多个 region，谁快谁赢
      // SELL 不需要抢，单 region 即可
      const options = {};
      if (side === 'BUY') {
        options.broadcastMode = true;
        options.timeoutMs = 10_000;
        options.maxRetries = 2;
      } else {
        options.timeoutMs = 15_000;
      }

      const result = await httpTransport.submitTransaction(txBytes, options);
      const elapsedMs = Date.now() - t0;

      if (result.status === 'confirmed') {
        monitor.inc('Executor.slipstreamSuccess', 1, 'Executor');
        monitor.set('Executor.slipstreamLatencyMs', elapsedMs, 'Executor');
        if (result.routing) {
          monitor.inc(`Executor.slipstreamRegion_${result.routing.region}`, 1, 'Executor');
        }
        console.log(
          `[Executor:Slipstream] ${side} confirmed: ${result.signature?.slice(0, 8) || 'n/a'}.. ` +
            `region=${result.routing?.region || '?'} sender=${result.routing?.sender || '?'} ` +
            `total=${elapsedMs}ms`,
        );
        return result.signature;
      }

      // 非 confirmed 状态
      if (result.status === 'pending' || result.status === 'processing' || result.status === 'sent') {
        monitor.inc('Executor.slipstreamSubmitted', 1, 'Executor');
        console.log(
          `[Executor:Slipstream] ${side} submitted (status=${result.status}): ` +
            `${result.signature?.slice(0, 8) || 'n/a'}.. total=${elapsedMs}ms`,
        );
        return result.signature;
      }

      // 失败状态
      monitor.inc('Executor.slipstreamFailed', 1, 'Executor');
      console.warn(
        `[Executor:Slipstream] ${side} failed: status=${result.status} ` +
          `error=${JSON.stringify(result.error)} total=${elapsedMs}ms`,
      );
      return null;
    } catch (err) {
      monitor.inc('Executor.slipstreamError', 1, 'Executor');
      monitor.recordError('Executor', err, { phase: 'slipstream_submit', side });
      console.error(`[Executor:Slipstream] ${side} error: ${err.message}`);
      return null;
    }
  }

  stop() {
    if (this._blockhashTimer) {
      clearInterval(this._blockhashTimer);
      this._blockhashTimer = null;
    }
    if (this.poolStateCache) {
      this.poolStateCache.stop();
    }
    if (this.feeOracle && this.feeOracle.stop) {
      this.feeOracle.stop();
    }
    if (this.slipstreamClient) {
      this.slipstreamClient.disconnect().catch(() => {});
      this.slipstreamClient = null;
    }
  }

  /**
   * v3.5: 注入 PoolStateCache，BUY/SELL 路径将优先读缓存
   */
  setPoolStateCache(cache) {
    this.poolStateCache = cache;
  }

  /** v3.17.11: 外部（main）在 BUY 前更新 latestSlot，
   *  Executor.buy() 返回时带上 buySlot 给 PositionManager
   */
  setLatestSlot(slot) {
    if (slot > 0) this._latestBuySlot = slot;
  }

  /**
   * 取缓存 blockhash；如果太旧（>30s）或没有，同步拉一次。
   */
  async _getBlockhash() {
    const age = Date.now() - this._cachedBlockhashAt;
    if (this._cachedBlockhash && age < 30_000) {
      monitor.set('Executor.blockhashAgeMs', age, 'Executor');
      return this._cachedBlockhash;
    }
    // 缓存过期或没有，同步拉
    monitor.inc('Executor.blockhashCacheMiss', 1, 'Executor');
    const bh = await this.rpc.getLatestBlockhash('confirmed');
    this._cachedBlockhash = bh;
    this._cachedBlockhashAt = Date.now();
    return bh;
  }

  /**
   * 用 Helius Sender (多 region 并发 race) 或 staked RPC 提交交易。
   *
   * v3.17 多 region 改造：
   *   - BUY 走 Sender：对 senderEndpoints 数组里所有 endpoint 并发发同一笔 tx，
   *     Promise.race 取第一个成功返回的（其它请求继续后台进行但结果被忽略）。
   *     Solana 节点会拒收重复 signature，所以重复提交是安全的。
   *   - 全部 Sender 失败才 fallback 到 staked RPC
   *   - SELL 直接走 staked RPC（SELL 不带 Jito tip，Sender 会拒收）
   *
   * @param {Buffer} serialized
   * @param {'BUY'|'SELL'} side
   */
  async _submitTx(serialized, side) {
    // v3.17.14: BUY 三路并发提交 (Slipstream + Helius Sender + Staked RPC)
    //           同时提交到三个通道，拿第一个返回的 signature
    //           其余请求被 Solana 节点的重复 sig 检测自动忽略
    //           SELL 仍走 staked RPC（不需要抢 slot）
    if (side === 'BUY') {
      // 首个成功的 racer 立即 resolve，全部失败才 reject
      const racers = [];

      // 1) Slipstream (leader-proximity routing + broadcast)
      if (this.slipstreamClient && this.slipstreamClient.http) {
        racers.push(
          this._submitViaSlipstream(serialized, side)
            .then(sig => ({ sig, channel: 'Slipstream' }))
            .catch(err => {
              monitor.inc('Executor.slipstreamFailed', 1, 'Executor');
              console.warn(`[Executor:race] Slipstream failed: ${err.message}`);
              return { sig: null, channel: 'Slipstream' };
            }),
        );
      }

      // 2) Helius Sender (多 region race)
      if (this.jitoTipLamports > 0 && this.senderEndpoints.length > 0) {
        racers.push(
          this._submitToSendersRace(serialized)
            .then(sig => ({ sig, channel: 'Sender' }))
            .catch(err => {
              monitor.inc('Executor.senderFailed', 1, 'Executor');
              console.warn(`[Executor:race] Helius Sender failed: ${err.message}`);
              return { sig: null, channel: 'Sender' };
            }),
        );
      }

      // 3) Staked RPC (直连)
      racers.push(
        this.stakedRpc.sendRawTransaction(serialized, { skipPreflight: true, maxRetries: 0 })
          .then(sig => ({ sig, channel: 'Staked' }))
          .catch(err => {
            monitor.inc('Executor.stakedFailed', 1, 'Executor');
            console.warn(`[Executor:race] Staked RPC failed: ${err.message}`);
            return { sig: null, channel: 'Staked' };
          }),
      );

      // Promise.race 立即返回第一个 settle 的结果
      // 如果是 null（失败），继续等下一个；首个非 null 即返回
      // v3.17.14 修复：'won' 日志只在真正 winner 时打（之前所有路径都会打）
      const firstSuccess = new Promise((resolve, reject) => {
        let resolved = false;
        let failed = 0;
        for (const racer of racers) {
          racer.then(result => {
            if (resolved) return; // 已经有人赢了，忽略后续 racer 结果
            if (result.sig) {
              resolved = true;
              console.log(`[Executor:race] ${result.channel} won`);
              monitor.inc(`Executor.raceWon_${result.channel}`, 1, 'Executor');
              resolve(result.sig);
            } else {
              failed++;
              if (failed === racers.length) {
                reject(new Error('All BUY submission channels failed (Slipstream + Sender + Staked)'));
              }
            }
          });
        }
      });

      return await firstSuccess;
    }

    // SELL — 直接走 staked RPC
    return await this.stakedRpc.sendRawTransaction(serialized, {
      skipPreflight: true,
      maxRetries: 0,
    });
  }

  /**
   * v3.17: 并发提交到多个 Sender region，Promise.race 取最快的成功响应。
   *
   * 设计要点：
   *   - 同时发同一笔 tx 到所有 region — 网络节点会基于 signature 去重，不会重复落链
   *   - 用 Promise.race 包装：第一个成功就 resolve，其它 promise 继续完成但结果忽略
   *   - 如果第一个返回的是 error，要等其它的 — 实现"全部失败才失败"，但又不阻塞最快成功的
   *   - 每个请求 5s 超时
   *
   * 实现：基于 Promise.allSettled 但带"首个成功立即返回"短路
   */
  async _submitToSendersRace(serialized) {
    const axios = require('axios');
    const body = {
      jsonrpc: '2.0',
      id: 1,
      method: 'sendTransaction',
      params: [
        Buffer.from(serialized).toString('base64'),
        { encoding: 'base64', skipPreflight: true, maxRetries: 0 },
      ],
    };

    const startTs = Date.now();
    const submitOne = async (endpoint) => {
      const t0 = Date.now();
      try {
        const { data } = await axios.post(endpoint, body, { timeout: 5000 });
        if (data.error) {
          throw new Error(`${endpoint} -> ${JSON.stringify(data.error)}`);
        }
        return { endpoint, signature: data.result, elapsedMs: Date.now() - t0 };
      } catch (err) {
        throw new Error(`${endpoint} (${Date.now() - t0}ms): ${err.message}`);
      }
    };

    // 用 "any-success" 模式：包装每个 promise，第一个成功 resolve，全失败 reject
    return new Promise((resolve, reject) => {
      let pending = this.senderEndpoints.length;
      const errors = [];
      let resolved = false;
      this.senderEndpoints.forEach((endpoint) => {
        submitOne(endpoint)
          .then((res) => {
            if (resolved) return;
            resolved = true;
            const totalMs = Date.now() - startTs;
            monitor.inc('Executor.senderRaceWon', 1, 'Executor');
            monitor.inc(`Executor.senderRaceWonBy_${this._endpointLabel(res.endpoint)}`, 1, 'Executor');
            monitor.set('Executor.lastSenderRaceMs', totalMs, 'Executor');
            console.log(
              `[Executor] Sender race won by ${this._endpointLabel(res.endpoint)} ` +
                `in ${res.elapsedMs}ms (total ${totalMs}ms), sig=${res.signature?.slice(0, 8) || 'n/a'}..`,
            );
            resolve(res.signature);
          })
          .catch((err) => {
            errors.push(err.message);
          })
          .finally(() => {
            pending -= 1;
            if (pending === 0 && !resolved) {
              reject(new Error(`all senders failed: ${errors.join(' | ')}`));
            }
          });
      });
    });
  }

  /** 从 Sender endpoint 字符串解出 region 标签，用于 metrics/日志 */
  _endpointLabel(endpoint) {
    if (!endpoint) return 'unknown';
    const m = endpoint.match(/(?:^|[\.\/\:])(fra|ams|ewr|slc|tyo|sg|lax|lon|pitt)\b/i);
    if (m) return m[1].toUpperCase();
    try {
      const host = endpoint.replace(/^https?:\/\//, '').split(/[:/]/)[0];
      return host.split('.')[0].toUpperCase().slice(0, 6);
    } catch (_) {
      return 'unknown';
    }
  }

  /**
   * 等待 tx 落链确认。返回 { confirmed: bool, error?: string, slot?: number }
   * - confirmed=true 表示链上落链且无 err（等同 SUCCESS）
   * - confirmed=false 且 error='not_landed' 表示超时未找到 tx（被丢弃）
   * - confirmed=false 且 error 是错误原因 表示 tx 落链但执行报错
   *
   * 用 polling getSignatureStatuses，比 confirmTransaction 更快、更可控。
   */
  async confirmTx(signature, { timeoutMs = 12_000, pollIntervalMs = 800 } = {}) {
    if (!signature || signature.startsWith('DRYRUN')) {
      return { confirmed: true, slot: null }; // DRY_RUN 自动算成功
    }
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try {
        const { value } = await this.rpc.getSignatureStatuses([signature], {
          searchTransactionHistory: false,
        });
        const status = value?.[0];
        if (status) {
          if (status.err) {
            return {
              confirmed: false,
              error: typeof status.err === 'string' ? status.err : JSON.stringify(status.err),
              slot: status.slot,
            };
          }
          // confirmationStatus: 'processed' | 'confirmed' | 'finalized'
          if (status.confirmationStatus === 'confirmed' ||
              status.confirmationStatus === 'finalized' ||
              status.confirmations !== null) {
            return { confirmed: true, slot: status.slot };
          }
          // status='processed' 还需要再等等
        }
      } catch (err) {
        // 单次查询失败不要紧，继续 poll
      }
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
    return { confirmed: false, error: 'not_landed' };
  }

  /**
   * 查询钱包对某 mint 的实际持币（uiAmount）。给 reconciliation 用。
   */
  async getWalletTokenBalance(mint) {
    if (!this.keypair) return 0;
    try {
      return await this._getRealOnchainTokenAmount(mint, 6);
    } catch (_) {
      return 0;
    }
  }

  /**
   * v3.6: 解析已落链 tx 的真实成交结果。
   * 用于 BUY 后回写 position 的真实 entrySol（避免 sizeSol vs 实际花费的差异）。
   *
   * 返回 { realSolDelta, realTokenDelta, fee, success } 或 null（tx 未找到）
   *   realSolDelta:  钱包 SOL 净变化（负数 = 花了多少 SOL，含 priority fee）
   *   realTokenDelta: 钱包对应 mint 净变化（正数 = 收到多少 token UI amount）
   *   fee:            tx 的 base fee（lamports）
   */
  async fetchTxSwapResult(signature, mint) {
    if (!signature || signature.startsWith('DRYRUN')) return null;
    if (!this.keypair) return null;
    try {
      const tx = await this.rpc.getTransaction(signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });
      if (!tx || !tx.meta) return null;

      const owner = this.keypair.publicKey.toBase58();

      // SOL 净变化
      // accountKeys 顺序与 preBalances/postBalances 一致
      const keys = tx.transaction.message.accountKeys || tx.transaction.message.staticAccountKeys || [];
      const ownerIdx = keys.findIndex((k) => {
        const s = typeof k === 'string' ? k : k.pubkey || k.toString?.();
        return s === owner;
      });
      let realSolDelta = 0;
      if (ownerIdx >= 0) {
        const pre = tx.meta.preBalances[ownerIdx] || 0;
        const post = tx.meta.postBalances[ownerIdx] || 0;
        realSolDelta = (post - pre) / 1e9; // SOL
      }

      // Token 净变化（对应 mint）
      let realTokenDelta = 0;
      const preTok = tx.meta.preTokenBalances || [];
      const postTok = tx.meta.postTokenBalances || [];
      for (const post of postTok) {
        if (post.owner !== owner || post.mint !== mint) continue;
        const pre = preTok.find((p) => p.accountIndex === post.accountIndex);
        const preUi = pre?.uiTokenAmount?.uiAmount || 0;
        const postUi = post.uiTokenAmount?.uiAmount || 0;
        realTokenDelta += postUi - preUi;
      }
      // 也要检查 pre 里有但 post 里没有的（账户被关闭的场景）
      for (const pre of preTok) {
        if (pre.owner !== owner || pre.mint !== mint) continue;
        const inPost = postTok.find((p) => p.accountIndex === pre.accountIndex);
        if (!inPost) {
          const preUi = pre.uiTokenAmount?.uiAmount || 0;
          realTokenDelta -= preUi;
        }
      }

      return {
        realSolDelta,
        realTokenDelta,
        fee: tx.meta.fee || 0,
        computeUnitsConsumed: tx.meta.computeUnitsConsumed || 0,
        success: !tx.meta.err,
      };
    } catch (err) {
      monitor.recordError('Executor', err, { phase: 'fetchTxSwapResult', signature });
      return null;
    }
  }

  /**
   * 构造、签名 tx。Side ('BUY' or 'SELL') 决定使用哪个 priority fee 等级。
   *
   * v3.13: BUY 自动注入 Jito tip 指令（如果配置了 JITO_TIP_LAMPORTS）
   * v3.18: 新增 bundleMode 参数
   *   - bundleMode=false(默认): tip 给 Helius Sender 10 个 wallet, 走 Sender 路径
   *   - bundleMode=true: tip 给 Jito 官方 8 个 wallet, 走 Jito Bundle 路径
   *
   * @param {Array} swapInstructions 指令数组
   * @param {'BUY'|'SELL'} side
   * @param {object} [opts]
   * @param {boolean} [opts.bundleMode=false] true=tip 给 Jito 官方 8 个 wallet
   * @param {number} [opts.tipLamportsOverride] 覆盖默认 jitoTipLamports
   */
  async _buildAndSignTx(swapInstructions, side, opts = {}) {
    const blockhash = await this._getBlockhash();

    // v3.8: oracle.estimate 现在是同步调用（内存读，永不阻塞）
    const fee = this.feeOracle.estimate(side);
    monitor.set(`Executor.last${side}FeeLamports`, fee.totalLamports, 'Executor');

    const ixs = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: this.computeUnitLimit }),
    ];
    if (fee.microLamportsPerCu > 0) {
      ixs.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: fee.microLamportsPerCu }));
    }

    // v3.13 / v3.18: BUY 注入 tip 指令
    //   bundleMode=false → Helius Sender tip (10 个 wallet 之一)
    //   bundleMode=true  → Jito Bundle tip (8 个 wallet 之一)
    if (side === 'BUY') {
      const bundleMode = !!opts.bundleMode;
      const tipLamports = opts.tipLamportsOverride || this.jitoTipLamports;

      let tipAccounts = null;
      let shouldAddTip = false;

      if (bundleMode) {
        // Jito Bundle 路径: 必须有 tip (tip 是 bundle 进 Jito 拍卖的入场券)
        tipAccounts = this.bundleTipAccounts;
        shouldAddTip = tipLamports > 0;
      } else if (this.senderEndpoints.length > 0 && tipLamports > 0) {
        // Helius Sender 路径: 有 sender 配置且配了 tip 才加
        tipAccounts = this.senderTipAccounts;
        shouldAddTip = true;
      }

      if (shouldAddTip && tipAccounts) {
        const tipAccount = tipAccounts[Math.floor(Math.random() * tipAccounts.length)];
        ixs.push(
          SystemProgram.transfer({
            fromPubkey: this.keypair.publicKey,
            toPubkey: new PublicKey(tipAccount),
            lamports: tipLamports,
          }),
        );
        monitor.inc(bundleMode ? 'Executor.bundleTipsSent' : 'Executor.senderTipsSent', 1, 'Executor');
      }
    }

    for (const ix of swapInstructions) ixs.push(ix);

    const message = new TransactionMessage({
      payerKey: this.keypair.publicKey,
      recentBlockhash: blockhash.blockhash,
      instructions: ixs,
    }).compileToV0Message();

    const tx = new VersionedTransaction(message);
    tx.sign([this.keypair]);
    return { serialized: tx.serialize(), feeInfo: fee };
  }

  /**
   * 买入：SOL → token，固定 SOL 输入。
   */
  async buy(order) {
    const t0 = Date.now();
    monitor.inc('Executor.buyAttempts', 1, 'Executor');
    monitor.beat('Executor', `buy:${(order.mint || '').slice(0, 6)}`);

    const sizeSol = order.sizeSol || config.strategy.positionSizeSol;
    const baseDecimals = order.baseDecimals ?? 6;

    // ============ DRY_RUN ============
    if (this.dryRun) {
      const fillPrice = (order.priceAfter || 0) * 1.005;
      if (fillPrice <= 0) {
        monitor.inc('Executor.buyFail', 1, 'Executor');
        return {
          success: false,
          error: 'invalid priceAfter for DRY_RUN',
          latencyMs: Date.now() - t0,
        };
      }
      const tokenAmount = sizeSol / fillPrice;
      console.log(
        `[Executor:DRY_RUN] BUY ${order.symbol || order.mint.slice(0, 6)}: ` +
          `${sizeSol} SOL → ${tokenAmount.toFixed(2)} tokens @ ${fillPrice.toExponential(4)}`,
      );
      monitor.inc('Executor.buySuccess', 1, 'Executor');
      return {
        success: true,
        signature: `DRYRUN_BUY_${Date.now()}`,
        tokenAmount,
        solIn: sizeSol,
        price: fillPrice,
        latencyMs: Date.now() - t0,
        dryRun: true,
      };
    }

    // ============ LIVE ============
    if (!this.keypair) {
      monitor.inc('Executor.buyFail', 1, 'Executor');
      monitor.recordError('Executor', new Error('wallet not loaded'), {
        side: 'BUY',
        mint: order.mint,
      });
      return { success: false, error: 'wallet not loaded', latencyMs: Date.now() - t0 };
    }
    if (!this.pumpSdk || !this.onlineSdk) {
      monitor.inc('Executor.buyFail', 1, 'Executor');
      return {
        success: false,
        error: '@pump-fun/pump-swap-sdk not loaded',
        latencyMs: Date.now() - t0,
      };
    }
    if (!order.poolAddress) {
      monitor.inc('Executor.buyFail', 1, 'Executor');
      return {
        success: false,
        error: 'poolAddress missing — run fill-pools',
        latencyMs: Date.now() - t0,
      };
    }

    try {
      const poolKey = new PublicKey(order.poolAddress);
      const sizeLamportsBN = new BN(Math.floor(sizeSol * 1e9));
      // SDK 接受 slippage 作为 percent 数（1% 写 1，不是 0.01）
      const slippagePct = config.strategy.buySlippageBps / 100;

      // 1. 拉 pool state — v3.5 优先读缓存（PoolStateCache 后台预热）
      const tS0 = Date.now();
      let swapState = null;
      let stateSource = 'rpc';
      if (this.poolStateCache) {
        swapState = this.poolStateCache.get(order.poolAddress);
        if (swapState) {
          stateSource = 'cache';
          const age = this.poolStateCache.getAge(order.poolAddress);
          monitor.set('Executor.lastCacheAgeMs', age || 0, 'Executor');
        }
      }
      if (!swapState) {
        // cache miss：第一次抓取或 cache 失效；走同步 RPC
        swapState = await this.onlineSdk.swapSolanaState(poolKey, this.keypair.publicKey);
        monitor.inc('Executor.cacheMiss', 1, 'Executor');
      } else {
        monitor.inc('Executor.cacheHit', 1, 'Executor');
      }
      const stateLatencyMs = Date.now() - tS0;
      monitor.inc('Executor.stateOk', 1, 'Executor');
      monitor.set('Executor.lastStateLatencyMs', stateLatencyMs, 'Executor');

      // 2. 构造 buy 指令（quote→base 方向）
      const tB0 = Date.now();
      const buyResult = await this.pumpSdk.buyQuoteInput(swapState, sizeLamportsBN, slippagePct);
      const buildLatencyMs = Date.now() - tB0;

      const swapIxs = this._extractInstructions(buyResult);
      if (!swapIxs || swapIxs.length === 0) {
        throw new Error('SDK buyQuoteInput returned no instructions');
      }

      // 估算 token 数量（用 SDK 的内部算法）
      const baseRaw = this._extractBaseAmount(buyResult, swapState, sizeLamportsBN, 'buy');
      const tokenAmount = Number(baseRaw) / Math.pow(10, baseDecimals);
      const realPrice = tokenAmount > 0 ? sizeSol / tokenAmount : 0;

      // 3. 构造、签名、提交
      const { serialized, feeInfo } = await this._buildAndSignTx(swapIxs, 'BUY');

      const tSend0 = Date.now();
      const sig = await this._submitTx(serialized, 'BUY');
      const sendLatencyMs = Date.now() - tSend0;
      monitor.inc('Executor.buySuccess', 1, 'Executor');

      console.log(
        `[Executor:LIVE] BUY submitted: ${(sig || '').slice(0, 8)}.. ` +
          `(state=${stateLatencyMs}ms[${stateSource}] build=${buildLatencyMs}ms send=${sendLatencyMs}ms total=${
            Date.now() - t0
          }ms, fee=${feeInfo.totalLamports}L ${feeInfo.source})`,
      );

      return {
        success: true,
        signature: sig,
        tokenAmount,
        solIn: sizeSol,
        price: realPrice,
        latencyMs: Date.now() - t0,
        stateLatencyMs,
        buildLatencyMs,
        priorityFeeLamports: feeInfo.totalLamports,
        priorityFeeSource: feeInfo.source,
        sendLatencyMs,
        buySlot: this._latestBuySlot || null,  // 提交时的链上 slot
      };
    } catch (err) {
      monitor.inc('Executor.buyFail', 1, 'Executor');
      monitor.recordError('Executor', err, {
        side: 'BUY',
        mint: order.mint,
        symbol: order.symbol,
        sizeSol,
      });
      console.error(`[Executor:LIVE] BUY failed: ${err.message}`);
      return { success: false, error: err.message, latencyMs: Date.now() - t0 };
    }
  }

  /**
   * v3.18: atomic Bundle BUY — 把砸盘 tx 和我们的 BUY tx 打包成 Jito Bundle 提交
   *
   * 这是为了跟 hnu5/3fZftz6m/MRiY 这类 atomic bundle 玩家正面竞争而设计的路径。
   *
   * 设计思路：
   *   1. 接收砸盘 tx 的完整 raw bytes (从 ShredStream/Deshred 拿到的未落链 tx)
   *   2. 构造我们的 BUY tx (流程跟 buy() 类似,但 tip 给 Jito 8 个 wallet)
   *   3. Bundle = [砸盘 tx, 我们的 BUY tx]
   *   4. Jito sendBundle API: 原子打包到同一个 slot
   *
   * 关键区别于 buy()：
   *   - tip 接收方:Jito 8 个 wallet (不是 Helius Sender 10 个)
   *   - 提交路径:Jito Bundle API (不是 sendTransaction/Sender)
   *   - bundle 失败 = 砸盘 tx 也不上链 (Jito 已上链的不会失败,主要是新 dump 才有用)
   *   - 同 slot 落链保证:bundle 内 tx 必同 slot
   *
   * @param {object} order 跟 buy() 同结构 (mint, symbol, poolAddress, priceAfter, sizeSol)
   * @param {Buffer|Uint8Array} dumpTxRaw 砸盘 tx 完整序列化后的 raw bytes
   *                                       从 ShredStream/Deshred 模块拿到
   * @returns {Promise<object>} { success, signature, bundleId, tokenAmount, solIn, price, latencyMs }
   */
  async buyBundle(order, dumpTxRaw) {
    const t0 = Date.now();
    monitor.inc('Executor.bundleBuyAttempts', 1, 'Executor');
    monitor.beat('Executor', `bundle_buy:${(order.mint || '').slice(0, 6)}`);

    const sizeSol = order.sizeSol || config.strategy.positionSizeSol;
    const baseDecimals = order.baseDecimals ?? 6;

    // 输入验证
    if (!dumpTxRaw || (!Buffer.isBuffer(dumpTxRaw) && !(dumpTxRaw instanceof Uint8Array))) {
      monitor.inc('Executor.bundleBuyFail', 1, 'Executor');
      return {
        success: false,
        error: 'buyBundle requires dumpTxRaw (Buffer or Uint8Array)',
        latencyMs: Date.now() - t0,
      };
    }
    if (dumpTxRaw.length > 1232) {
      monitor.inc('Executor.bundleBuyFail', 1, 'Executor');
      return {
        success: false,
        error: `dumpTxRaw too large (${dumpTxRaw.length} > 1232 bytes)`,
        latencyMs: Date.now() - t0,
      };
    }

    // ============ DRY_RUN ============
    if (this.dryRun) {
      const fillPrice = (order.priceAfter || 0) * 1.005;
      if (fillPrice <= 0) {
        monitor.inc('Executor.bundleBuyFail', 1, 'Executor');
        return {
          success: false,
          error: 'invalid priceAfter for DRY_RUN',
          latencyMs: Date.now() - t0,
        };
      }
      const tokenAmount = sizeSol / fillPrice;
      console.log(
        `[Executor:DRY_RUN] BUNDLE_BUY ${order.symbol || order.mint.slice(0, 6)}: ` +
          `${sizeSol} SOL → ${tokenAmount.toFixed(2)} tokens @ ${fillPrice.toExponential(4)} ` +
          `(would bundle with dump tx ${dumpTxRaw.length} bytes)`,
      );
      monitor.inc('Executor.bundleBuySuccess', 1, 'Executor');
      return {
        success: true,
        signature: `DRYRUN_BUNDLE_BUY_${Date.now()}`,
        bundleId: `DRY_BUNDLE_${Date.now()}`,
        tokenAmount,
        solIn: sizeSol,
        price: fillPrice,
        latencyMs: Date.now() - t0,
        dryRun: true,
      };
    }

    // ============ LIVE ============
    if (!this.keypair) {
      monitor.inc('Executor.bundleBuyFail', 1, 'Executor');
      return { success: false, error: 'wallet not loaded', latencyMs: Date.now() - t0 };
    }
    if (!this.pumpSdk || !this.onlineSdk) {
      monitor.inc('Executor.bundleBuyFail', 1, 'Executor');
      return {
        success: false,
        error: '@pump-fun/pump-swap-sdk not loaded',
        latencyMs: Date.now() - t0,
      };
    }
    if (!order.poolAddress) {
      monitor.inc('Executor.bundleBuyFail', 1, 'Executor');
      return {
        success: false,
        error: 'poolAddress missing — run fill-pools',
        latencyMs: Date.now() - t0,
      };
    }
    if (!this.jitoBundleClient) {
      monitor.inc('Executor.bundleBuyFail', 1, 'Executor');
      return {
        success: false,
        error: 'JitoBundleClient not initialized — call setJitoBundleClient first',
        latencyMs: Date.now() - t0,
      };
    }

    try {
      const poolKey = new PublicKey(order.poolAddress);
      const sizeLamportsBN = new BN(Math.floor(sizeSol * 1e9));
      const slippagePct = config.strategy.buySlippageBps / 100;

      // 1. 拉 pool state — 用缓存
      const tS0 = Date.now();
      let swapState = null;
      let stateSource = 'rpc';
      if (this.poolStateCache) {
        swapState = this.poolStateCache.get(order.poolAddress);
        if (swapState) {
          stateSource = 'cache';
          const age = this.poolStateCache.getAge(order.poolAddress);
          monitor.set('Executor.lastCacheAgeMs', age || 0, 'Executor');
        }
      }
      if (!swapState) {
        swapState = await this.onlineSdk.swapSolanaState(poolKey, this.keypair.publicKey);
        monitor.inc('Executor.cacheMiss', 1, 'Executor');
      } else {
        monitor.inc('Executor.cacheHit', 1, 'Executor');
      }
      const stateLatencyMs = Date.now() - tS0;
      monitor.set('Executor.lastBundleStateLatencyMs', stateLatencyMs, 'Executor');

      // 2. 构造 buy 指令
      const tB0 = Date.now();
      const buyResult = await this.pumpSdk.buyQuoteInput(swapState, sizeLamportsBN, slippagePct);
      const buildLatencyMs = Date.now() - tB0;

      const swapIxs = this._extractInstructions(buyResult);
      if (!swapIxs || swapIxs.length === 0) {
        throw new Error('SDK buyQuoteInput returned no instructions');
      }

      const baseRaw = this._extractBaseAmount(buyResult, swapState, sizeLamportsBN, 'buy');
      const tokenAmount = Number(baseRaw) / Math.pow(10, baseDecimals);
      const realPrice = tokenAmount > 0 ? sizeSol / tokenAmount : 0;

      // 3. 动态决定 tip 数额 (从 Jito tip floor API 拉,基于 p75 + buffer)
      // 如果 tip floor 缓存有,瞬间返回;没有用兜底值
      const recommendedTip = await this.jitoBundleClient.getRecommendedTipLamports({
        percentile: config.execution?.bundleTipPercentile || 'p75',
        bufferMultiplier: config.execution?.bundleTipBuffer || 1.5,
        minLamports: this.jitoTipLamports, // 至少要 JITO_TIP_LAMPORTS
        maxLamports: parseInt(process.env.BUNDLE_TIP_MAX_LAMPORTS || '20000000', 10), // 默认 0.02 SOL
      });

      // 4. 构造并签名我们的 BUY tx (bundleMode=true → tip 给 Jito 8 个 wallet)
      const { serialized: buyTxRaw, feeInfo } = await this._buildAndSignTx(swapIxs, 'BUY', {
        bundleMode: true,
        tipLamportsOverride: recommendedTip,
      });

      if (buyTxRaw.length > 1232) {
        throw new Error(`BUY tx too large (${buyTxRaw.length} > 1232 bytes) — bundle limit`);
      }

      // 5. 提交 bundle = [dump tx, your BUY]
      const tSend0 = Date.now();
      const { bundleId, winningRegion, elapsedMs: sendLatencyMs } =
        await this.jitoBundleClient.sendBundle([Buffer.from(dumpTxRaw), Buffer.from(buyTxRaw)]);
      const totalSendMs = Date.now() - tSend0;

      monitor.inc('Executor.bundleBuySuccess', 1, 'Executor');
      monitor.set('Executor.lastBundleSendMs', totalSendMs, 'Executor');

      // 从 BUY tx 提取 signature (用于后续 reconcile)
      // tx 第一笔 signature 就是这个 tx 的 sig
      const buyTxSig = this._extractTxSignature(buyTxRaw);

      console.log(
        `[Executor:BUNDLE_BUY] submitted: bundleId=${bundleId.slice(0, 12)}.. ` +
          `buySig=${(buyTxSig || '').slice(0, 8)}.. region=${winningRegion} ` +
          `tip=${recommendedTip}L ` +
          `(state=${stateLatencyMs}ms[${stateSource}] build=${buildLatencyMs}ms send=${sendLatencyMs}ms total=${
            Date.now() - t0
          }ms, fee=${feeInfo.totalLamports}L)`,
      );

      return {
        success: true,
        signature: buyTxSig,
        bundleId,
        tokenAmount,
        solIn: sizeSol,
        price: realPrice,
        latencyMs: Date.now() - t0,
        stateLatencyMs,
        buildLatencyMs,
        sendLatencyMs,
        priorityFeeLamports: feeInfo.totalLamports,
        priorityFeeSource: feeInfo.source,
        bundleTipLamports: recommendedTip,
        bundleRegion: winningRegion,
      };
    } catch (err) {
      monitor.inc('Executor.bundleBuyFail', 1, 'Executor');
      monitor.recordError('Executor', err, {
        side: 'BUNDLE_BUY',
        mint: order.mint,
        symbol: order.symbol,
        sizeSol,
      });
      console.error(`[Executor:BUNDLE_BUY] failed: ${err.message}`);
      return { success: false, error: err.message, latencyMs: Date.now() - t0 };
    }
  }

  /**
   * v3.18: 从已签名的 tx raw bytes 提取 signature (base58)
   * Solana tx 格式: 第一个 byte 是 sig 数量,后面跟着 64 bytes signature
   */
  _extractTxSignature(serializedTx) {
    try {
      const buf = Buffer.isBuffer(serializedTx) ? serializedTx : Buffer.from(serializedTx);
      // 跳过第一个 byte (sig count),取后续 64 bytes
      if (buf.length < 65) return null;
      const sigBytes = buf.slice(1, 65);
      return bs58.encode(sigBytes);
    } catch (err) {
      return null;
    }
  }

  /**
   * v3.18: 外部 main 在启动时设置 JitoBundleClient
   * @param {JitoBundleClient} client
   */
  setJitoBundleClient(client) {
    this.jitoBundleClient = client;
    if (client) {
      this.bundleMode = true;
      // 启动后台 tip floor 预拉,避免 BUY 时阻塞
      client.startBackgroundTipPoll(5000);
      console.log('[Executor] JitoBundleClient initialized, bundle mode enabled');
    }
  }

  /**
   * 卖出：token → SOL，固定 token 输入。
   */
  async sell(order) {
    const t0 = Date.now();
    monitor.inc('Executor.sellAttempts', 1, 'Executor');
    monitor.beat('Executor', `sell:${(order.mint || '').slice(0, 6)}`);

    const baseDecimals = order.baseDecimals ?? 6;
    const tokenAmount = order.tokenAmount;
    const currentPrice = order.currentPrice;

    if (!Number.isFinite(tokenAmount) || tokenAmount <= 0) {
      monitor.inc('Executor.sellFail', 1, 'Executor');
      monitor.recordError('Executor', new Error('invalid tokenAmount'), {
        side: 'SELL',
        mint: order.mint,
        tokenAmount,
      });
      return { success: false, error: 'invalid tokenAmount', latencyMs: Date.now() - t0 };
    }

    // ============ DRY_RUN ============
    if (this.dryRun) {
      const fillPrice = currentPrice * 0.995;
      const solOut = tokenAmount * fillPrice;
      console.log(
        `[Executor:DRY_RUN] SELL ${order.symbol || order.mint.slice(0, 6)}: ` +
          `${tokenAmount.toFixed(2)} tokens → ${solOut.toFixed(4)} SOL @ ${fillPrice.toExponential(4)}`,
      );
      monitor.inc('Executor.sellSuccess', 1, 'Executor');
      return {
        success: true,
        signature: `DRYRUN_SELL_${Date.now()}`,
        solOut,
        price: fillPrice,
        latencyMs: Date.now() - t0,
        dryRun: true,
      };
    }

    // ============ LIVE ============
    if (!this.keypair) {
      monitor.inc('Executor.sellFail', 1, 'Executor');
      return { success: false, error: 'wallet not loaded', latencyMs: Date.now() - t0 };
    }
    if (!this.pumpSdk || !this.onlineSdk) {
      monitor.inc('Executor.sellFail', 1, 'Executor');
      return {
        success: false,
        error: '@pump-fun/pump-swap-sdk not loaded',
        latencyMs: Date.now() - t0,
      };
    }
    if (!order.poolAddress) {
      monitor.inc('Executor.sellFail', 1, 'Executor');
      return {
        success: false,
        error: 'poolAddress missing',
        latencyMs: Date.now() - t0,
      };
    }

    try {
      const poolKey = new PublicKey(order.poolAddress);

      // 1. 并发拉链上余额 + pool state
      const tS0 = Date.now();
      const [onchainAmount, swapState] = await Promise.all([
        this._getRealOnchainTokenAmount(order.mint, baseDecimals),
        this.onlineSdk.swapSolanaState(poolKey, this.keypair.publicKey),
      ]);
      const stateLatencyMs = Date.now() - tS0;
      monitor.inc('Executor.stateOk', 1, 'Executor');
      monitor.set('Executor.lastStateLatencyMs', stateLatencyMs, 'Executor');

      const sellAmount = Math.min(tokenAmount, onchainAmount > 0 ? onchainAmount : tokenAmount);
      const sellAmountRaw = Math.floor(sellAmount * Math.pow(10, baseDecimals));
      if (sellAmountRaw <= 0) {
        monitor.inc('Executor.sellFail', 1, 'Executor');
        return {
          success: false,
          error: 'no on-chain balance to sell',
          latencyMs: Date.now() - t0,
        };
      }

      const sellAmountBN = new BN(sellAmountRaw);
      const slippagePct = config.strategy.sellSlippageBps / 100;

      // 2. 构造 sell 指令（base→quote 方向）
      const tB0 = Date.now();
      const sellResult = await this.pumpSdk.sellBaseInput(swapState, sellAmountBN, slippagePct);
      const buildLatencyMs = Date.now() - tB0;

      const swapIxs = this._extractInstructions(sellResult);
      if (!swapIxs || swapIxs.length === 0) {
        throw new Error('SDK sellBaseInput returned no instructions');
      }

      // 估算预期 SOL out
      const quoteRaw = this._extractQuoteAmount(sellResult, swapState, sellAmountBN, 'sell');
      const expectedSolOut = Number(quoteRaw) / 1e9;
      const realPrice = sellAmount > 0 ? expectedSolOut / sellAmount : 0;

      // 3. 构造、签名、提交
      const { serialized, feeInfo } = await this._buildAndSignTx(swapIxs, 'SELL');

      const tSend0 = Date.now();
      const sig = await this._submitTx(serialized, 'SELL');
      const sendLatencyMs = Date.now() - tSend0;
      monitor.inc('Executor.sellSuccess', 1, 'Executor');

      console.log(
        `[Executor:LIVE] SELL submitted: ${(sig || '').slice(0, 8)}.. ` +
          `(state=${stateLatencyMs}ms build=${buildLatencyMs}ms send=${sendLatencyMs}ms total=${
            Date.now() - t0
          }ms, fee=${feeInfo.totalLamports}L ${feeInfo.source})`,
      );

      return {
        success: true,
        signature: sig,
        solOut: expectedSolOut,
        price: realPrice,
        latencyMs: Date.now() - t0,
        stateLatencyMs,
        buildLatencyMs,
        sendLatencyMs,
        priorityFeeLamports: feeInfo.totalLamports,
        priorityFeeSource: feeInfo.source,
      };
    } catch (err) {
      monitor.inc('Executor.sellFail', 1, 'Executor');
      monitor.recordError('Executor', err, {
        side: 'SELL',
        mint: order.mint,
        symbol: order.symbol,
        tokenAmount,
      });
      console.error(`[Executor:LIVE] SELL failed: ${err.message}`);
      return { success: false, error: err.message, latencyMs: Date.now() - t0 };
    }
  }

  async _getRealOnchainTokenAmount(mint, decimals) {
    try {
      const owner = this.keypair.publicKey;
      const resp = await this.rpc.getParsedTokenAccountsByOwner(
        owner,
        { mint: new PublicKey(mint) },
        'confirmed',
      );
      let total = 0;
      for (const acc of resp.value) {
        const ui = acc.account.data.parsed?.info?.tokenAmount?.uiAmount;
        if (typeof ui === 'number') total += ui;
      }
      return total;
    } catch (err) {
      monitor.recordError('Executor', err, { phase: 'onchain_balance', mint });
      return 0;
    }
  }

  /**
   * SDK 不同版本返回结构不同。统一处理：
   *   - 数组 → 直接是 instructions
   *   - 对象有 .instructions → 取出
   *   - 对象有 .ixs → 取出
   *   - 单个 instruction 对象 → 包成数组
   */
  _extractInstructions(sdkResult) {
    if (!sdkResult) return null;
    if (Array.isArray(sdkResult)) return sdkResult;
    if (Array.isArray(sdkResult.instructions)) return sdkResult.instructions;
    if (Array.isArray(sdkResult.ixs)) return sdkResult.ixs;
    if (sdkResult.programId && sdkResult.keys) return [sdkResult];
    return null;
  }

  _extractBaseAmount(sdkResult, state, fallbackQuoteIn, side) {
    if (sdkResult && sdkResult.base) return BigInt(sdkResult.base.toString());
    if (sdkResult && sdkResult.baseAmount) return BigInt(sdkResult.baseAmount.toString());
    if (sdkResult && sdkResult.uiBase != null) {
      return BigInt(Math.floor(Number(sdkResult.uiBase) * 1e6));
    }
    // fallback：用 constant product 公式估算（不精确，仅用于显示）
    try {
      const baseReserve = BigInt(state.poolBaseAmount.toString());
      const quoteReserve = BigInt(state.poolQuoteAmount.toString());
      const quoteIn = BigInt(fallbackQuoteIn.toString());
      const k = baseReserve * quoteReserve;
      const newQuote = quoteReserve + quoteIn;
      const newBase = k / newQuote;
      const baseOut = baseReserve - newBase;
      return baseOut > 0n ? baseOut : 0n;
    } catch (_) {
      return 0n;
    }
  }

  _extractQuoteAmount(sdkResult, state, fallbackBaseIn, side) {
    if (sdkResult && sdkResult.quote) return BigInt(sdkResult.quote.toString());
    if (sdkResult && sdkResult.quoteAmount) return BigInt(sdkResult.quoteAmount.toString());
    if (sdkResult && sdkResult.uiQuote != null) {
      return BigInt(Math.floor(Number(sdkResult.uiQuote) * 1e9));
    }
    // fallback
    try {
      const baseReserve = BigInt(state.poolBaseAmount.toString());
      const quoteReserve = BigInt(state.poolQuoteAmount.toString());
      const baseIn = BigInt(fallbackBaseIn.toString());
      const k = baseReserve * quoteReserve;
      const newBase = baseReserve + baseIn;
      const newQuote = k / newBase;
      const quoteOut = quoteReserve - newQuote;
      return quoteOut > 0n ? quoteOut : 0n;
    } catch (_) {
      return 0n;
    }
  }
}

module.exports = Executor;
