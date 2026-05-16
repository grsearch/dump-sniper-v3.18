'use strict';

const crypto = require('crypto');
const { config, validateConfig } = require('./config');
const TokenRegistry = require('./data/TokenRegistry');
const TradeLogger = require('./data/TradeLogger');
const TickStream = require('./core/TickStream');
const DumpDetector = require('./core/DumpDetector');
const PriceTracker = require('./core/PriceTracker');
const SignalEngine = require('./core/SignalEngine');
const Executor = require('./core/Executor');
const PositionManager = require('./core/PositionManager');
const DailyReport = require('./reports/DailyReport');
const Server = require('./server/server');
const PoolFinder = require('./utils/poolFinder');
const { getMonitor } = require('./monitor/HealthMonitor');
const AlertChecker = require('./monitor/AlertChecker');

const monitor = getMonitor();

async function main() {
  console.log('================================================');
  console.log('🎯 Dump Sniper V2 starting...');
  console.log(`Mode: ${config.DRY_RUN ? 'DRY_RUN' : '⚠️  LIVE TRADING ⚠️'}`);
  console.log(`Position: ${config.strategy.positionSizeSol} SOL`);
  console.log(`TP: +${config.strategy.takeProfitPct}% (need ${config.strategy.tpConfirmCount}x confirm)`);
  console.log(`Emergency stop: ${config.strategy.emergencyStopLossPct}%`);
  console.log(`Max hold: ${config.strategy.maxHoldMs}ms`);
  console.log(`Executor: Pump AMM SDK direct (no Jupiter)`);
  console.log(`Compute units: ${process.env.COMPUTE_UNIT_LIMIT || 200000}, max priority fee: ${config.maxPriorityFeeLamports} lamports`);
  console.log('================================================');

  const errors = validateConfig();
  if (errors.length) {
    console.error('Config errors:');
    errors.forEach((e) => console.error('  - ' + e));
    if (errors.some((e) => e.includes('LaserStream') || e.includes('HELIUS_API_KEY'))) {
      console.error('Critical config missing. Exiting.');
      process.exit(1);
    }
  }

  // ============ 数据层 ============
  const tokenRegistry = new TokenRegistry();
  const tradeLogger = new TradeLogger(tokenRegistry.db);

  // ============ 核心引擎 ============
  const priceTracker = new PriceTracker();
  const dumpDetector = new DumpDetector(tokenRegistry);
  const executor = new Executor();

  // v3.18: atomic Jito Bundle 路径
  //   仅当 USE_BUNDLE_MODE=true 时启用 (默认 false)
  //   启用后 Executor.buyBundle() 可用,如果 dumpSignal 携带 dumpTxRaw 会自动走 bundle 路径
  //   Week 2 接入 ShredStream 后 dumpTxRaw 才会被填充,在此之前 bundle 路径只是"待用"状态
  if (config.execution?.useBundleMode) {
    const JitoBundleClient = require('./core/JitoBundleClient');
    const jitoBundleClient = new JitoBundleClient({
      regions: config.execution.jitoRegions || ['global', 'frankfurt'],
      dryRun: config.DRY_RUN,
      monitor: require('./monitor/HealthMonitor').getMonitor(),
    });
    executor.setJitoBundleClient(jitoBundleClient);
    console.log(
      `[main] v3.18 Jito Bundle mode ENABLED. ` +
        `Regions: ${(config.execution.jitoRegions || ['global', 'frankfurt']).join(',')}, ` +
        `tip percentile: ${config.execution.bundleTipPercentile || 'p75'} × ${config.execution.bundleTipBuffer || 1.5}`,
    );
  }

  // v3.5: PoolStateCache - 后台预热所有监控代币的 Pump pool state
  // BUY 路径不再阻塞 swapSolanaState（80-150ms RPC），从内存读 0ms
  // v3.15: 用 executor.cacheSdk（独立实例，走普通 RPC），不占用 stakedRpc 通道
  if (!config.DRY_RUN && executor.cacheSdk && executor.keypair) {
    const PoolStateCache = require('./core/PoolStateCache');
    const poolStateCache = new PoolStateCache({
      onlineSdk: executor.cacheSdk,  // v3.15: 用 cacheSdk 而不是 onlineSdk
      user: executor.keypair.publicKey,
      getMintList: () => {
        return tokenRegistry.listActive()
          .filter((t) => t.pool_address)
          .map((t) => ({ mint: t.mint, poolAddress: t.pool_address }));
      },
    });
    executor.setPoolStateCache(poolStateCache);
    dumpDetector.setPoolStateCache(poolStateCache);
    poolStateCache.start();
  }

  const positionManager = new PositionManager({
    tradeLogger,
    executor,
    priceTracker,
    tokenRegistry,
  });
  // v3.17.7: tickStream 必须先于 signalEngine 创建（signalEngine 需要它的 latestSlot getter）
  const tickStream = new TickStream();
  // v3.17.11: PositionManager 需要 tickStream.latestSlot 来判断 SLOT_EXIT
  positionManager.tickStream = tickStream;
  // v3.17.12: DumpDetector 查询 sig 的首次来源（SS vs LS）
  dumpDetector._tickStream = tickStream;
  const signalEngine = new SignalEngine({ tradeLogger, positionManager, tickStream });

  // ============ v3.18 Week 2: ShredStream.com SDK 订阅 ============
  // 独立运行,提供砸盘 tx 的 raw wire bytes 给 Executor.buyBundle() 用
  // Week 3 会接入 DumpDetector, 这里只先把数据流接通
  //
  // ShredStream.com 跟 Jito 官方 ShredStream 不同:
  //   - 不需要本地 docker proxy
  //   - shredstream npm SDK 直接 UDP 接收 + 自动 deshred + 输出 wire-format tx
  //   - 你在 dashboard 配置目标 IP:port, 他们推 UDP shreds 给你
  //
  // 启用条件:
  //   - SHREDSTREAM_ENABLED=true
  //   - SHREDSTREAM_PORT 配置 (跟 ShredStream.com dashboard 一致)
  //   - npm install shredstream (Rust napi-rs 模块, 部署服务器才能装上)
  //   - 服务器 sysctl: net.core.rmem_max=67108864, net.core.busy_read=200
  //   - 防火墙 allow 入站 UDP
  let shredStreamSource = null;
  if ((process.env.SHREDSTREAM_ENABLED || '').toLowerCase() === 'true') {
    try {
      const ShredStreamSource = require('./data/ShredStreamSource');
      const port = parseInt(process.env.SHREDSTREAM_PORT || '8001', 10);
      const PUMP_AMM_PROGRAM = process.env.PUMP_AMM_PROGRAM_ID || 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';

      shredStreamSource = new ShredStreamSource({
        port,
        includePrograms: [PUMP_AMM_PROGRAM],
        recvBufBytes: parseInt(process.env.SHREDSTREAM_RECV_BUF_BYTES || '67108864', 10),
        busyPollUs: parseInt(process.env.SHREDSTREAM_BUSY_POLL_US || '200', 10),
      });

      let recentTxCount = 0;
      let recentTxLastReport = Date.now();
      shredStreamSource.on('transaction', (tx) => {
        recentTxCount++;
        // 每分钟报告一次(确认接入工作)
        const now = Date.now();
        if (now - recentTxLastReport > 60_000) {
          console.log(
            `[main] ShredStream: ${recentTxCount} Pump AMM tx received in last 60s ` +
              `(latest slot=${tx.slot})`,
          );
          recentTxCount = 0;
          recentTxLastReport = now;
        }
      });

      await shredStreamSource.start();
      console.log(
        `[main] ShredStream enabled, UDP port=${port}, program filter=${PUMP_AMM_PROGRAM.slice(0, 6)}..`,
      );
    } catch (err) {
      console.error(`[main] ShredStream setup failed: ${err.message}`);
      // 不致命 — 主路径继续工作
    }
  }

  // ============ 报告 ============
  const dailyReport = new DailyReport({ tradeLogger, tokenRegistry });
  dailyReport.start();

  // ============ 服务器 ============
  const server = new Server({
    tokenRegistry,
    tradeLogger,
    positionManager,
    signalEngine,
    dailyReport,
    onTokenListChanged: () => {
      const mints = tokenRegistry.listActive().map((t) => t.mint);
      tickStream.updateSubscription(mints);
    },
    onTokenAdded: async (token) => {
      // 新增代币 → 后台异步补 pool 信息
      if (config.autoFillPoolsOnStart) {
        fillPoolForToken(tokenRegistry, token.mint).catch(() => {});
      }
    },
  });

  // ============ 启动恢复未平仓持仓 ============
  const restored = positionManager.restoreFromDb();
  if (restored.length > 0) {
    console.log(`[main] restored ${restored.length} open position(s) from db`);
    monitor.inc('main.restoredPositions', restored.length, 'main');
  }

  // ============ 健康监控 / 告警 ============
  const alertChecker = new AlertChecker({
    monitor,
    tickStream,
    executor,
    positionManager,
    tokenRegistry,
    config,
  });
  alertChecker.start();

  monitor.on('alert', (alert) => {
    console.error(`[ALERT] [${alert.severity.toUpperCase()}] ${alert.name}: ${alert.message}`);
    server.broadcast({ type: 'alert', alert });
  });
  monitor.on('alertCleared', (alert) => {
    console.log(`[ALERT] cleared: ${alert.name}`);
    server.broadcast({ type: 'alertCleared', alert });
  });

  // ============ 事件连线 ============

  tickStream.on('transaction', (tx) => dumpDetector.handleTransaction(tx));

  dumpDetector.on('priceTick', ({ mint, price, ts, poolAddress }) => {
    priceTracker.update(mint, price, ts, poolAddress);
  });

  // sellAnalyzed: 只记录"接近触发"的（半阈值），避免写入风暴
  dumpDetector.on('sellAnalyzed', (info) => {
    if (info.passSize && info.passImpact && info.passLiquidity) return; // 已 dumpSignal
    const halfSize = config.strategy.minSellSol * 0.5;
    const halfImpact = config.strategy.minPriceImpactPct * 0.5;
    if (info.sellSol < halfSize || info.priceImpactPct < halfImpact) return;
    // 构造可读的拒绝原因
    const reasons = [];
    if (!info.passSize) reasons.push(`size:${info.sellSol.toFixed(1)}<${config.strategy.minSellSol}`);
    if (!info.passImpact) {
      if (info.priceImpactPct < config.strategy.minPriceImpactPct) {
        reasons.push(`impact:${info.priceImpactPct.toFixed(1)}%<${config.strategy.minPriceImpactPct}%`);
      } else {
        reasons.push(`impact:${info.priceImpactPct.toFixed(1)}%>${config.strategy.maxPriceImpactPct}% (pool dead?)`);
      }
    }
    if (!info.passLiquidity) {
      reasons.push(`liq:${(info.poolQuoteAfter ?? 0).toFixed(0)} SOL<${config.strategy.minPoolQuoteSol}`);
    }
    tradeLogger.logSignal({
      ts: info.ts,
      mint: info.mint,
      symbol: info.symbol,
      kind: 'DUMP_DETECTED',
      sellSol: info.sellSol,
      priceImpactPct: info.priceImpactPct,
      seller: info.seller,
      sellerTx: info.signature,
      notes: `near-miss: ${reasons.join(', ')}`,
      accepted: false,
      rejectReason: reasons.join('; '),
    });
  });

  dumpDetector.on('dumpSignal', (signal) => {
    // v3.8: 砸盘信号触发瞬间立即异步刷新该 token 的 pool state cache
    // 这样从 dumpSignal → SignalEngine.handleDumpSignal → emit buyOrder → executor.buy
    // 这条链路 (~5-20ms) 期间 pool state RPC 已经在并发拉取
    // 等 Executor.buy 读 cache 时，最坏也是非常新鲜的 state
    if (executor.poolStateCache && signal.poolAddress) {
      executor.poolStateCache.refreshOne(signal.poolAddress).catch(() => {});
    }
    signalEngine.handleDumpSignal(signal);
  });

  // ============ buyOrder → BUY → register position ============
  signalEngine.on('buyOrder', async (order) => {
    const tokenInfo = tokenRegistry.getToken(order.mint);

    // 用同一个 positionId 贯穿 BUY trade / position 表
    const positionId = crypto.randomUUID();

    // 标记此 mint 正在 buy 中，让后续并发 dumpSignal 看到这个槽位被占
    signalEngine.markBuyInflight(order.mint);

    // v3.17.11: BUY 前记录当前链上 slot，用于 SLOT_EXIT 策略
    executor.setLatestSlot(tickStream.latestSlot || 0);

    // v3.18: 判断走 atomic Bundle 路径还是普通 BUY 路径
    //   bundle 路径必须满足:
    //     1. config 启用 useBundleMode
    //     2. Executor 已注入 JitoBundleClient
    //     3. order.dumpTxRaw 存在 (Week 2 ShredStream 接入后才有)
    //   任何条件不满足 → fallback 到普通 BUY (保证向后兼容)
    const canUseBundle =
      config.execution?.useBundleMode &&
      executor.jitoBundleClient &&
      order.dumpTxRaw;

    let buyResult;
    try {
      const buyOrderParams = {
        mint: order.mint,
        symbol: order.symbol,
        sizeSol: order.sizeSol,
        priceAfter: order.priceAfter, // 用于 DRY_RUN 模拟
        baseDecimals: order.baseDecimals ?? tokenInfo?.decimals ?? 6,
        poolAddress: tokenInfo?.pool_address, // Pump SDK 需要 pool address
      };

      if (canUseBundle) {
        // v3.18: atomic Jito Bundle 路径
        console.log(
          `[main] BUY via Jito Bundle: ${order.symbol || order.mint.slice(0, 6)} ` +
            `(dump tx ${order.dumpTxRaw.length} bytes)`,
        );
        buyResult = await executor.buyBundle(buyOrderParams, order.dumpTxRaw);

        // bundle 失败时,可选地 fallback 到普通 BUY
        // 但通常不 fallback —— bundle 失败说明 dump tx 已落链或 bundle 网络出问题,
        // 这时普通 BUY 也是 +1 slot,没意义。所以默认不 fallback。
        // 如果想开启 fallback,加 BUNDLE_FALLBACK_TO_NORMAL=true env
        if (!buyResult.success && (process.env.BUNDLE_FALLBACK_TO_NORMAL || '').toLowerCase() === 'true') {
          console.warn(`[main] Bundle BUY failed, fallback to normal BUY: ${buyResult.error}`);
          buyResult = await executor.buy(buyOrderParams);
        }
      } else {
        // 普通 BUY 路径(向后兼容,目前主路径)
        buyResult = await executor.buy(buyOrderParams);
      }
    } finally {
      signalEngine.markBuyDone(order.mint);
    }

    // 记录 BUY trade（用同一 positionId）
    tradeLogger.logTrade({
      positionId,
      ts: Date.now(),
      mint: order.mint,
      symbol: order.symbol,
      side: 'BUY',
      solAmount: buyResult.solIn ?? order.sizeSol,
      tokenAmount: buyResult.tokenAmount,
      price: buyResult.price,
      signature: buyResult.signature,
      success: buyResult.success,
      dryRun: config.DRY_RUN,
      reason: order.reason,
      latencyMs: buyResult.latencyMs,
      error: buyResult.error,
    });

    if (!buyResult.success) {
      console.error(
        `[main] BUY failed for ${order.symbol || order.mint.slice(0, 6)}: ${buyResult.error}`,
      );
      return;
    }

    // 用真实成交价初始化 entry_price（关键修复 v1 bug：之前用 trigger 价）
    positionManager.registerOpen({
      positionId,
      mint: order.mint,
      symbol: order.symbol,
      entrySol: buyResult.solIn ?? order.sizeSol,
      entryPrice: buyResult.price,         // 真实成交价
      tokenAmount: buyResult.tokenAmount,  // 真实买到的数量
      dryRun: config.DRY_RUN,
      signature: buyResult.signature,
      buyFeeLamports: buyResult.priorityFeeLamports || 0,  // v3.4: 用于真实 PnL
      buySlot: buyResult.buySlot || 0,  // v3.17.11: BUY 时的链上 slot
      // v3.18: bundle 模式字段(仅 bundle 路径有)
      bundleId: buyResult.bundleId,
      bundleTipLamports: buyResult.bundleTipLamports,
      bundleRegion: buyResult.bundleRegion,
    });

    // 立即同步 PriceTracker，用真实成交价做 entry baseline
    // （避免下一笔 LaserStream tx 推一个旧价格触发假 TP）
    priceTracker.forceSet(order.mint, buyResult.price);

    if (buyResult.signature) signalEngine.registerOurSignature(buyResult.signature);
  });

  positionManager.on('opened', (pos) =>
    server.broadcast({ type: 'positionOpened', position: pos }),
  );
  positionManager.on('closed', (pos) =>
    server.broadcast({ type: 'positionClosed', position: pos }),
  );

  // ============ 启动服务器 ============
  server.start();

  // ============ 启动前补充 pool 信息（异步后台） ============
  if (config.autoFillPoolsOnStart) {
    backgroundFillPools(tokenRegistry).catch((err) =>
      console.error(`[main] backgroundFillPools error: ${err.message}`),
    );
  }

  // ============ 启动数据流 ============
  const initialMints = tokenRegistry.listActive().map((t) => t.mint);
  console.log(`[main] starting LaserStream with ${initialMints.length} initial tokens`);
  await tickStream.start(initialMints);

  // ============ 优雅退出 ============
  const shutdown = async (signal) => {
    console.log(`\n[main] ${signal} received, shutting down gracefully...`);
    try {
      if (shredStreamSource) shredStreamSource.stop();
      await tickStream.stop();
      positionManager.stop();
      alertChecker.stop();
      monitor.stop();
      executor.stop && executor.stop();
      await new Promise((r) => setTimeout(r, 200));
    } catch (err) {
      console.error(`[main] shutdown error: ${err.message}`);
    }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('uncaughtException', (err) => {
    monitor.recordError('main', err, { phase: 'uncaughtException' });
    monitor.inc('main.uncaughtExceptions', 1, 'main');
    console.error('[main] uncaughtException:', err);
  });
  process.on('unhandledRejection', (reason) => {
    monitor.recordError('main', reason instanceof Error ? reason : new Error(String(reason)), {
      phase: 'unhandledRejection',
    });
    monitor.inc('main.unhandledRejections', 1, 'main');
    console.error('[main] unhandledRejection:', reason);
  });

  console.log('[main] startup complete');
}

/**
 * 后台扫描所有缺失 pool 信息的代币，逐个补上。
 * 节流：每个 250ms。
 */
async function backgroundFillPools(tokenRegistry) {
  const targets = tokenRegistry
    .listAll()
    .filter((t) => t.is_active && (!t.pool_address || !t.pool_base_vault || !t.pool_quote_vault));

  if (targets.length === 0) return;
  console.log(`[main] auto-fill pool for ${targets.length} tokens (background)`);

  const finder = new PoolFinder({});
  let ok = 0;
  let fail = 0;

  for (const t of targets) {
    try {
      const result = await finder.findPoolForMint(t.mint);
      if (result) {
        tokenRegistry.setPoolInfo(t.mint, result);
        ok += 1;
      } else {
        fail += 1;
      }
    } catch (err) {
      fail += 1;
      console.warn(`[fill-pools] ${t.symbol || t.mint.slice(0, 6)}: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  console.log(`[main] auto-fill pool done: ${ok} OK, ${fail} failed`);
}

async function fillPoolForToken(tokenRegistry, mint) {
  try {
    const finder = new PoolFinder({});
    const result = await finder.findPoolForMint(mint);
    if (result) {
      tokenRegistry.setPoolInfo(mint, result);
      console.log(
        `[fill-pools] ${mint.slice(0, 6)}: pool=${result.poolAddress.slice(0, 6)}..`,
      );
    }
  } catch (err) {
    console.warn(`[fill-pools] ${mint.slice(0, 6)}: ${err.message}`);
  }
}

main().catch((err) => {
  console.error('[main] fatal error:', err);
  process.exit(1);
});
