'use strict';

/**
 * PositionManager (v2)
 * ====================
 * 维护当前持仓。每次 PriceTracker 更新价格时检查是否止盈/紧急止损/超时。
 * 100ms tick 兜底，防止价格不更新时无法触发超时退出。
 *
 * 关键修复（v2）：
 *
 * 1. 双确认止盈：连续 N 次（默认 2）满足 TP 条件，且首次和最近一次间隔
 *    >= tpConfirmMinGapMs（默认 300ms），才真正触发卖出。挡住单次价格污染。
 *
 * 2. 紧急止损：跌幅 <= emergencyStopLossPct（默认 -15%）立即出场。
 *    防止 PRATT/Goblin/COMPUTA 那种 -97% 灾难。
 *
 * 3. PnL 用真实成交价计算：sellResult.solOut 来自钱包真实余额变化（LIVE）
 *    或 Jupiter quote 的 outAmount。entry_price 来自 BUY 真实成交比率。
 *    不再用"trigger 时的 price tracker 价格"做 PnL 分母。
 *
 * 4. SELL 失败按指数退避重试，且重试时使用最新价格做 sanity 检查
 *
 * 5. registerOpen 接受外部 positionId（与 BUY trade 配对）
 *
 * 6. restoreFromDb 启动时恢复未平仓持仓
 */

const EventEmitter = require('events');
const crypto = require('crypto');
const { config } = require('../config');
const { getMonitor } = require('../monitor/HealthMonitor');

const monitor = getMonitor();
monitor.registerModule('PositionManager', { staleMs: 10_000, label: 'Position Manager' });

const SELL_RETRY_DELAYS_MS = [500, 1500, 3000, 5000, 10_000, 20_000]; // 之后保持 30s

class PositionManager extends EventEmitter {
  constructor({ tradeLogger, executor, priceTracker, tokenRegistry, tickStream }) {
    super();
    this.tradeLogger = tradeLogger;
    this.executor = executor;
    this.priceTracker = priceTracker;
    this.tokenRegistry = tokenRegistry;
    this.tickStream = tickStream;  // v3.17.11: 用于读 latestSlot

    this.positions = new Map(); // positionId → position obj
    this.byMint = new Map();    // mint → positionId

    this.tickTimer = setInterval(() => {
      monitor.beat('PositionManager', 'tick');
      monitor.inc('PositionManager.ticks', 1, 'PositionManager');
      this._tick();
    }, 100);

    // v3.3: 重试 reconciler — 每 5 秒扫描 DB 找到期的 pending sell 和 stuck position
    // 处理重启场景（setTimeout 丢失）+ 长时间错过的重试
    this.reconcilerTimer = setInterval(() => {
      this._reconcileRetries().catch((err) => {
        monitor.recordError('PositionManager', err, { phase: 'reconciler' });
      });
    }, 5000);

    // v3.4: 主动池子轮询 — 持仓期间每 500ms 拉一次每个 token 的 pool state 算价格
    // 修复：原来 PriceTracker 只在外部砸盘交易触发时更新；微盘币 15s 内可能没有任何 swap
    // → 价格永远是 entryPrice → 永远不止盈也不止损 → 全部 TIMEOUT 出场
    this.poolPollIntervalMs = parseInt(process.env.POOL_POLL_INTERVAL_MS || '500', 10);
    this.poolPollTimer = setInterval(() => {
      this._pollPoolPrices().catch((err) => {
        monitor.recordError('PositionManager', err, { phase: 'pool_poll' });
      });
    }, this.poolPollIntervalMs);

    this.priceTracker.on('update', ({ mint, price }) => {
      const pid = this.byMint.get(mint);
      if (!pid) return;
      this._checkExit(pid, price);
    });
  }

  stop() {
    clearInterval(this.tickTimer);
    clearInterval(this.reconcilerTimer);
    clearInterval(this.poolPollTimer);
  }

  hasOpenPosition(mint) {
    return this.byMint.has(mint);
  }

  openPositionCount() {
    return this.positions.size;
  }

  listOpen() {
    return Array.from(this.positions.values());
  }

  /**
   * 启动时从 DB 恢复未平仓的持仓。
   * 对每个恢复的持仓：
   *   - 如果 openedAt + maxHoldMs 已过：立即触发 SELL（exitReason=TIMEOUT_RESTORED）
   *   - 否则：正常进入 _tick 循环
   */
  restoreFromDb() {
    const open = this.tradeLogger.getOpenPositions();
    if (open.length === 0) return [];

    const restored = [];
    for (const row of open) {
      const pos = {
        positionId: row.position_id,
        mint: row.mint,
        symbol: row.symbol,
        entrySol: row.entry_sol,
        entryPrice: row.entry_price,
        tokenAmount: row.token_amount,
        openedAt: row.opened_at,
        dryRun: !!row.dry_run,
        buySignature: row.buy_signature,
        buySlot: row.buy_slot || 0,  // v3.17.11: 恢复时可能没有 buySlot
        exiting: false,
        sellAttempts: row.sell_attempts || 0,
        // 双确认状态
        _tpConfirmCount: 0,
        _tpFirstTriggerTs: null,
        // v3.3: 重试相关
        status: row.status || 'open',
        exitReason: row.exit_intent || row.exit_reason || null,
        nextRetryAt: row.next_retry_at || null,
        _lastSellSignature: row.pending_sell_signature || null,
        // v3.17: trailing 字段（DB 未持久化，重启后保守地从 entryPrice 重新追踪）
        //   缺点：如果重启时价格已经远高于 entryPrice，trailing 会"重置" highWaterMark
        //         相当于重启后让出一次本可以触发的 trailing。这是为了简化 DB schema 而做的取舍。
        highWaterMark: row.entry_price,
        highWaterMarkTs: Date.now(),
        trailingArmed: false,
        // v3.17.6: 重启时也进入 stabilization 期
        //   避免重启后第一个 tick 拿到的剧烈波动价格污染 HWM
        stabilizing: true,
        reconciledAt: Date.now(),
        _stabilizeSamples: [],
        // 恢复时已经 reconciled（DB 里的 entryPrice 已经是真实成交价）
        reconciled: true,
      };
      // 已经在 sell flow 中：标记 exiting=true 防止重新触发 _exit
      if (pos.status === 'sell_pending' || pos.status === 'sell_confirming') {
        pos.exiting = true;
      }
      this.positions.set(pos.positionId, pos);
      this.byMint.set(pos.mint, pos.positionId);
      restored.push(pos);
      const statusBadge = pos.status === 'open' ? '' : ` [status=${pos.status}, attempts=${pos.sellAttempts}]`;
      console.log(
        `[PositionManager] 🔄 RESTORED ${pos.symbol || pos.mint.slice(0, 6)} ` +
          `opened ${Math.round((Date.now() - pos.openedAt) / 1000)}s ago, ` +
          `${(pos.tokenAmount ?? 0).toFixed(2)} tokens${statusBadge}`,
      );
    }
    monitor.set('PositionManager.openCount', this.positions.size, 'PositionManager');
    return restored;
  }

  /**
   * BUY 成功后由 main 流程调用。
   * @param {object} p
   * @param {string} [p.positionId] - 必须传，与 BUY trade 同 ID
   * @param {string} p.mint
   * @param {string} p.symbol
   * @param {number} p.entrySol - 真实付出的 SOL（含滑点和 fee 损耗）
   * @param {number} p.entryPrice - 真实成交价 = entrySol / tokenAmount
   * @param {number} p.tokenAmount - 真实买到的 token UI amount
   * @param {boolean} p.dryRun
   * @param {string} p.signature
   * @param {number} [p.buyFeeLamports] - BUY tx 的 priority fee + base fee (lamports)
   * @param {number} [p.buySlot] - BUY 时的链上 slot
   * @param {string} [p.bundleId] - v3.18 (atomic bundle 模式): Jito bundle ID
   * @param {number} [p.bundleTipLamports] - v3.18: bundle 提交时的 Jito tip
   * @param {string} [p.bundleRegion] - v3.18: 哪个 Jito region 赢了竞速
   */
  registerOpen({ positionId, mint, symbol, entrySol, entryPrice, tokenAmount, dryRun, signature, buyFeeLamports, buySlot, bundleId, bundleTipLamports, bundleRegion }) {
    const pid = positionId || crypto.randomUUID();
    const isBundleMode = !!bundleId;
    const pos = {
      positionId: pid,
      mint,
      symbol,
      entrySol,
      entryPrice,
      tokenAmount,
      openedAt: Date.now(),
      dryRun: !!dryRun,
      buySignature: signature,
      buyFeeLamports: buyFeeLamports || 0,  // v3.4: 真实成本
      sellFeeLamports: 0,                    // 卖出时累加（包括所有重试的 fee）
      buySlot: buySlot || 0,                // v3.17.11: BUY 时的链上 slot
      // v3.18: bundle 模式字段
      bundleMode: isBundleMode,
      bundleId: bundleId || null,
      bundleTipLamports: bundleTipLamports || 0,
      bundleRegion: bundleRegion || null,
      exiting: false,
      sellAttempts: 0,
      _tpConfirmCount: 0,
      _tpFirstTriggerTs: null,
      // v3.12: 等 _reconcileBuyAsync 完成才允许触发 exit；防止用错的 entryPrice 误判 PnL
      // DRY_RUN 不走 reconcile，直接标 true
      reconciled: !!dryRun,
      // v3.17: 移动止盈追踪
      highWaterMark: entryPrice,
      highWaterMarkTs: Date.now(),
      trailingArmed: false,
      // v3.17.6: stabilization 期
      //   DRY_RUN：开仓即进入 stabilization(用估算价格作起点)
      //   LIVE：reconcile 完成时进入 stabilization
      stabilizing: !!dryRun,
      reconciledAt: dryRun ? Date.now() : null,
      _stabilizeSamples: dryRun ? [] : null,
    };
    this.positions.set(pid, pos);
    this.byMint.set(mint, pid);

    this.tradeLogger.openPosition({
      positionId: pid,
      mint,
      symbol,
      openedAt: pos.openedAt,
      entrySol,
      entryPrice,
      tokenAmount,
      dryRun: !!dryRun,
      buySignature: signature,
      buyFeeLamports: pos.buyFeeLamports,
    });

    console.log(
      `[PositionManager] 📈 OPEN ${isBundleMode ? '[BUNDLE]' : ''} ${symbol || mint.slice(0, 6)} @ ${entryPrice.toExponential(4)}, ` +
        `${tokenAmount.toFixed(2)} tokens, ${entrySol.toFixed(4)} SOL` +
        (isBundleMode ? ` bundle=${bundleId.slice(0, 12)}.. region=${bundleRegion} tip=${bundleTipLamports}L` : ''),
    );

    monitor.inc('PositionManager.opened', 1, 'PositionManager');
    if (isBundleMode) {
      monitor.inc('PositionManager.openedBundle', 1, 'PositionManager');
    }
    monitor.set('PositionManager.openCount', this.positions.size, 'PositionManager');
    this.emit('opened', pos);

    // v3.6: 异步等链上确认并用真实数据修正 position
    // 这是关键 PnL 准确性修复：sizeSol 是配置值（如 3.0），但实际链上花费可能是 2.6
    // SDK 的 buyQuoteInput 把 quote 当 max；slippage 让链上以更优价格成交，少花一些 SOL
    if (!dryRun && signature && !signature.startsWith('DRYRUN')) {
      this._reconcileBuyAsync(pid, mint, signature).catch((err) => {
        monitor.recordError('PositionManager', err, {
          phase: 'reconcile_buy',
          mint,
          signature,
        });
      });

      // v3.17.9: reconcile watchdog —— 兜底机制
      //   背景:openclaw 实战发现 1 笔 BUY 链上 ProgramFailedToComplete,
      //         token 没到账,但 status 一直停在 open(认为买成功)。
      //         理论上 _reconcileBuyAsync 应该检测到 confirmed=false 并关闭 position,
      //         但实战中存在异常路径导致 reconcile 没正常工作:
      //           - setImmediate / Promise 异常被吞(已 catch 但实际可能没触发)
      //           - confirmTx 内部 RPC 长期阻塞(>60s)
      //           - getSignatureStatuses 对失败 tx 返回 null,poll 到超时(8s)然后正常关闭
      //             但极端情况下 poll 异常 → reconcile 退出但没标记
      //   兜底:开仓后 60 秒 watchdog
      //         如果 position 仍存在 AND reconciled=false → 强制按"BUY chain failed"处理
      //         (60s 远大于正常 reconcile 完成时间 1-3s,正常路径不会触发)
      const watchdogTimer = setTimeout(() => {
        const p = this.positions.get(pid);
        if (p && !p.reconciled && !p.exiting) {
          console.error(
            `[PositionManager] ⚠️ reconcile watchdog: ${p.symbol || mint.slice(0, 6)} ` +
              `still un-reconciled after 60s → forcing BUY_CHAIN_FAILED`,
          );
          monitor.inc('PositionManager.reconcileWatchdog', 1, 'PositionManager');
          const feeSol = ((p.buyFeeLamports || 0) + 5000) / 1e9;
          try {
            this.tradeLogger.closePosition(pid, {
              closedAt: Date.now(),
              exitPrice: p.entryPrice,
              exitSol: 0,
              pnlSol: -feeSol,
              pnlPct: -100,
              exitReason: 'BUY_RECONCILE_TIMEOUT',
              sellSignature: null,
            });
          } catch (err) {
            monitor.recordError('PositionManager', err, { phase: 'watchdog_close' });
          }
          this.positions.delete(pid);
          this.byMint.delete(mint);
          monitor.set('PositionManager.openCount', this.positions.size, 'PositionManager');
        }
      }, 60_000);
      if (watchdogTimer.unref) watchdogTimer.unref();
      pos._reconcileWatchdog = watchdogTimer;
    }
    return pos;
  }

  /**
   * v3.6: BUY 提交后异步等链上确认，用真实 SOL 出账 / 真实 token 入账 修正 position
   * 解决 BUY 实际花费 ≠ 配置 sizeSol 的问题（典型偏差 5-15%）
   */
  async _reconcileBuyAsync(positionId, mint, signature) {
    // v3.7: 等 1 秒让 tx 落链（BUY 通常 400-800ms 落链，1s 是合理初始延迟）
    await new Promise((r) => setTimeout(r, 1000));

    // 短超时确认（confirmTx 内部 poll，最多 8 秒）
    const result = await this.executor.confirmTx(signature, {
      timeoutMs: 8_000,
      pollIntervalMs: 500,
    });

    const pos = this.positions.get(positionId);
    if (!pos) return; // position 已被外部清理

    // ============ 分支 A: BUY tx 链上失败 ============
    // 这是 Openclaw 截图描述的关键 bug：BUY 提交成功但链上失败
    // → program 以为买到了 → 拼命 SELL 不存在的 token → 28 笔 3012 错误烧 fee
    // 修复：检测到 BUY 链上失败 → 强制关闭 position（PnL 标记真实损失：仅 fee）
    if (!result.confirmed) {
      monitor.inc('PositionManager.buyChainFail', 1, 'PositionManager');
      const errMsg = result.error || 'not_landed';
      console.error(
        `[PositionManager] ⚠️ BUY tx FAILED on chain: ${pos.symbol || mint.slice(0, 6)} ` +
          `sig=${signature.slice(0, 8)}.. error=${errMsg}`,
      );

      // 真实损失 = 已付 priority fee + base fee（链上 tx 失败也扣 fee）
      // 没买到 token，所以 exitSol = 0, tokenAmount 应该是 0
      const feeSol = ((pos.buyFeeLamports || 0) + 5000) / 1e9;

      this.tradeLogger.closePosition(positionId, {
        closedAt: Date.now(),
        exitPrice: pos.entryPrice,
        exitSol: 0,
        pnlSol: -feeSol, // 仅损失 fee
        pnlPct: -100,
        exitReason: 'BUY_CHAIN_FAILED',
        sellSignature: null,
      });

      this.positions.delete(positionId);
      this.byMint.delete(mint);
      monitor.inc('PositionManager.buyFailedClosed', 1, 'PositionManager');
      monitor.set('PositionManager.openCount', this.positions.size, 'PositionManager');
      monitor.recordError('PositionManager', new Error('BUY chain failed'), {
        mint,
        symbol: pos.symbol,
        signature,
        error: errMsg,
      });
      // v3.17.9: 清 watchdog
      if (pos._reconcileWatchdog) {
        clearTimeout(pos._reconcileWatchdog);
        pos._reconcileWatchdog = null;
      }
      this.emit('buyChainFailed', { positionId, mint, symbol: pos.symbol, signature, error: errMsg });
      return;
    }

    // ============ 分支 B: BUY 链上成功，但解析失败 ============
    const swap = await this.executor.fetchTxSwapResult(signature, mint);
    if (!swap || !swap.success) {
      // confirmTx 说成功但 fetchTxSwapResult 说 success=false → tx 落链但执行失败
      // 等价于 BUY 失败
      monitor.inc('PositionManager.buyReconcileFetchFail', 1, 'PositionManager');
      console.error(
        `[PositionManager] ⚠️ BUY confirmed but tx parse failed: ${pos.symbol || mint.slice(0, 6)} ` +
          `sig=${signature.slice(0, 8)}..`,
      );
      // 同样按链上失败处理（保险起见）
      const feeSol = ((pos.buyFeeLamports || 0) + 5000) / 1e9;
      this.tradeLogger.closePosition(positionId, {
        closedAt: Date.now(),
        exitPrice: pos.entryPrice,
        exitSol: 0,
        pnlSol: -feeSol,
        pnlPct: -100,
        exitReason: 'BUY_PARSE_FAILED',
        sellSignature: null,
      });
      this.positions.delete(positionId);
      this.byMint.delete(mint);
      monitor.inc('PositionManager.buyFailedClosed', 1, 'PositionManager');
      monitor.set('PositionManager.openCount', this.positions.size, 'PositionManager');
      // v3.17.9: 清 watchdog
      if (pos._reconcileWatchdog) {
        clearTimeout(pos._reconcileWatchdog);
        pos._reconcileWatchdog = null;
      }
      return;
    }

    // ============ 分支 C: BUY 成功，回写真实数据 ============
    // realSolDelta 是负数（出账）。priority fee + base fee 也含在内
    const realSolSpent = -swap.realSolDelta;
    const realTokenReceived = swap.realTokenDelta;

    if (realSolSpent <= 0 || realTokenReceived <= 0) {
      monitor.recordError('PositionManager', new Error('reconcile: invalid swap deltas'), {
        signature,
        realSolSpent,
        realTokenReceived,
      });
      return;
    }

    const oldEntrySol = pos.entrySol;
    const oldEntryPrice = pos.entryPrice;
    const oldTokenAmount = pos.tokenAmount;

    // 修正：扣掉 priority fee + base fee，剩下的才是真正花在 swap 上
    // 但对策略判断来说，"我亏了多少 SOL" 用 realSolSpent 全口径比较合理
    pos.entrySol = realSolSpent;
    pos.tokenAmount = realTokenReceived;
    pos.entryPrice = realSolSpent / realTokenReceived;
    // realSolSpent 已含 priority fee 与 base fee；为避免双重扣减，把 buyFeeLamports 清零
    pos.buyFeeLamports = 0;

    // v3.17.6 关键修复（基于实战数据三个 bug 的根治方案）：
    //
    // Bug #1 修复：OPEN 时 highWaterMark = 估算 entryPrice（高估 5-15%）
    //              reconcile 后真实 entryPrice 更低 → 旧 HWM 变成"虚假高点"
    //              → 紧接着的真实价格被误判为"从 peak 大幅回撤" → trailing 误杀
    //              修复：reconcile 完成时重置 HWM 到真实 entryPrice
    //
    // Bug #3 修复：reconcile 完成那一刻，砸盘后价格还在剧烈波动 + 我们自买入
    //              推高了 AMM 池子价格 5-10%。第一个 priceTick 拿到的就是这个
    //              虚高瞬态值 → trailing 立刻 armed → 真实价格回归被误判为
    //              "回撤" → trailing 误杀
    //              修复：进入 stabilization 期（默认 5 秒），期间：
    //                - 不更新 highWaterMark（让 _checkExit 跳过 trailing 流程）
    //                - 收集所有 priceTick 到 _stabilizeSamples
    //                - emergency_stop 正常工作（救命路径不能屏蔽）
    //              stabilization 期结束时，取中位数作为 stabilizedBaseline，
    //              作为 trailing 的新起点。
    pos.highWaterMark = pos.entryPrice;
    pos.highWaterMarkTs = Date.now();
    pos.trailingArmed = false;
    pos._tpConfirmCount = 0;
    pos._tpFirstTriggerTs = null;

    // 进入 stabilization 期
    pos.reconciledAt = Date.now();
    pos.stabilizing = true;
    pos._stabilizeSamples = []; // 期间收到的所有价格

    // v3.12: 标记 reconciled，解除 _checkExit 的"完全跳过"锁定
    //        进入 stabilization 模式（_checkExit 内部判断 stabilizing 时只跑 emergency）
    pos.reconciled = true;

    // v3.17.9: reconcile 正常完成,清掉 watchdog 避免 60s 后误触发
    if (pos._reconcileWatchdog) {
      clearTimeout(pos._reconcileWatchdog);
      pos._reconcileWatchdog = null;
    }

    // 同步到 DB
    this.tradeLogger.updatePositionEntry(positionId, {
      entrySol: pos.entrySol,
      entryPrice: pos.entryPrice,
      tokenAmount: pos.tokenAmount,
      buyFeeLamports: 0,
    });

    monitor.inc('PositionManager.buyReconciled', 1, 'PositionManager');
    const drift = ((realSolSpent - oldEntrySol) / oldEntrySol) * 100;
    console.log(
      `[PositionManager] 🔧 BUY reconciled ${pos.symbol || mint.slice(0, 6)}: ` +
        `entrySol ${oldEntrySol.toFixed(4)}→${realSolSpent.toFixed(4)} (${drift.toFixed(2)}%), ` +
        `tokens ${oldTokenAmount.toFixed(2)}→${realTokenReceived.toFixed(2)}, ` +
        `entryPrice ${oldEntryPrice.toExponential(4)}→${pos.entryPrice.toExponential(4)}`,
    );

    // v3.9: 监控真实 CU 消耗，逼近 limit 时告警
    const cuConsumed = swap.computeUnitsConsumed || 0;
    const cuLimit = this.executor.computeUnitLimit || 200000;
    if (cuConsumed > 0) {
      monitor.set('PositionManager.lastBuyCuConsumed', cuConsumed, 'PositionManager');
      const cuUtilPct = (cuConsumed / cuLimit) * 100;
      monitor.set('PositionManager.lastBuyCuUtilPct', Math.round(cuUtilPct), 'PositionManager');

      if (cuUtilPct >= 90) {
        monitor.inc('PositionManager.cuNearLimit', 1, 'PositionManager');
        console.warn(
          `[PositionManager] ⚠️ ${pos.symbol || mint.slice(0, 6)} CU 消耗 ${cuConsumed} / ${cuLimit} ` +
            `(${cuUtilPct.toFixed(0)}%) — 接近上限，建议调高 COMPUTE_UNIT_LIMIT 或观察是否有 BUY_CHAIN_FAILED`,
        );
      }
    }
  }

  _tick() {
    const now = Date.now();
    const currentSlot = this.tickStream ? this.tickStream.latestSlot : 0;

    for (const pos of this.positions.values()) {
      if (pos.exiting) continue;

      // v3.17.11: SLOT_EXIT — 买入后 N 个 slot 全部卖出
      // 优先级最高，不受 reconciled/stabilizing 限制
      const slotExitGap = config.strategy.slotExitGap;
      if (slotExitGap > 0 && pos.buySlot > 0 && currentSlot > 0) {
        const slotsSinceBuy = currentSlot - pos.buySlot;
        if (slotsSinceBuy >= slotExitGap) {
          const lastPrice = this.priceTracker.getPrice(pos.mint) || pos.entryPrice;
          console.log(
            `[PositionManager] ⚡ SLOT_EXIT ${pos.symbol || pos.mint.slice(0, 6)} ` +
              `buySlot=${pos.buySlot} currentSlot=${currentSlot} gap=${slotsSinceBuy} (>=${slotExitGap})`,
          );
          this._exit(pos, lastPrice, 'SLOT_EXIT');
          continue;
        }
      }

      const age = now - pos.openedAt;
      if (age >= config.strategy.maxHoldMs) {
        const lastPrice = this.priceTracker.getPrice(pos.mint) || pos.entryPrice;
        this._exit(pos, lastPrice, 'TIMEOUT');
      }
    }
  }

  _checkExit(positionId, price) {
    const pos = this.positions.get(positionId);
    if (!pos || pos.exiting) return;

    // v3.17.11: SLOT_EXIT — 最高优先级，不受 reconciled/stabilizing 限制
    const slotExitGap = config.strategy.slotExitGap;
    const currentSlot = this.tickStream ? this.tickStream.latestSlot : 0;
    if (slotExitGap > 0 && pos.buySlot > 0 && currentSlot > 0) {
      const slotsSinceBuy = currentSlot - pos.buySlot;
      if (slotsSinceBuy >= slotExitGap) {
        console.log(
          `[PositionManager] ⚡ SLOT_EXIT ${pos.symbol || pos.mint.slice(0, 6)} ` +
            `buySlot=${pos.buySlot} currentSlot=${currentSlot} gap=${slotsSinceBuy} (>=${slotExitGap})`,
        );
        this._exit(pos, price, 'SLOT_EXIT');
        return;
      }
    }

    // v3.12: reconcile 完成前完全跳过（entryPrice 是估算值，所有 exit 检查都不可靠）
    //        例外：MAX_HOLD_MS 超时由 _tick 那条路径触发
    if (!pos.reconciled && !pos.dryRun) {
      return;
    }

    const pnlPct = ((price - pos.entryPrice) / pos.entryPrice) * 100;

    // ============ v3.17.7 stabilization 期处理 ============
    // 期间只收集价格样本，不更新 HWM，不武装 trailing，不检查 TP
    // 期满时取样本中位数作为 stabilizedBaseline，过滤砸盘瞬态 + 自买入推高
    if (pos.stabilizing) {
      pos._stabilizeSamples.push(price);

      // ============ stabilization 期内的紧急止损 ============
      //
      // 设计动机：
      //   实战发现 stabilization 期内直接用"相对 entryPrice"的 -15% 阈值会误杀。
      //   根因：3 SOL 买入推高 30 SOL 池子 ~10%，然后价格回归，第一个 tick 就是
      //         "相对 entryPrice -15%" 的假信号。但这是自买入造成的虚高回归，
      //         不是市场灾难。
      //
      //   openclaw 的修复：stabilization 期 emergency 阈值放宽到 -30%
      //     问题：拍脑袋的数字。如果真的暴跌 -25%，会被放过 5 秒。
      //
      //   我的方案：stabilization 期改用"相对样本最高价的回撤"判断 emergency
      //     - max(samples) ≈ 自买入推高的峰值
      //     - 从这个峰值真的跌 stabilizationEmergencyDrawdownPct%（默认 20%）才认作灾难
      //     - 这样能区分"AMM 自然回归" vs "真实大跌"
      //     - 例：entryPrice 估算 8.2e-6，buy 后样本 [7.5, 7.3, 7.1]，max=7.5
      //           当前 6.8 → 回撤 9.3%，不触发（这正是 openclaw 想避免的误杀场景）
      //           若当前 5.8 → 回撤 22.7%，触发 emergency（真灾难）
      const sampleMax = pos._stabilizeSamples.reduce(
        (m, p) => (p > m ? p : m),
        pos.entryPrice,
      );
      const drawdownFromMax = ((sampleMax - price) / sampleMax) * 100;
      const stabEmergencyDD = config.strategy.stabilizationEmergencyDrawdownPct;
      if (stabEmergencyDD > 0 && drawdownFromMax >= stabEmergencyDD) {
        console.warn(
          `[PositionManager] 🚨 EMERGENCY_STOP (stabilization) ${pos.symbol || pos.mint.slice(0, 6)} ` +
            `drawdown ${drawdownFromMax.toFixed(2)}% from stabilization peak ` +
            `(sampleMax=${sampleMax.toExponential(3)}, current=${price.toExponential(3)}, pnl=${pnlPct.toFixed(2)}%)`,
        );
        this._exit(pos, price, 'EMERGENCY_STOP');
        return;
      }

      const elapsed = Date.now() - pos.reconciledAt;
      const stabilizeMs = config.strategy.stabilizationMs;
      if (elapsed >= stabilizeMs) {
        // stabilization 结束 — 计算中位数 baseline
        const samples = pos._stabilizeSamples.slice().sort((a, b) => a - b);
        let baseline;
        if (samples.length === 0) {
          baseline = pos.entryPrice; // 期内没收到任何 tick（罕见）
        } else {
          const mid = Math.floor(samples.length / 2);
          baseline = samples.length % 2 === 0
            ? (samples[mid - 1] + samples[mid]) / 2
            : samples[mid];
        }
        // HWM 取 baseline 和 entryPrice 的较大值（保守：避免 baseline 比 entry 低
        // 导致后续小幅上涨就立刻 trailing armed）
        pos.highWaterMark = Math.max(baseline, pos.entryPrice);
        pos.highWaterMarkTs = Date.now();
        pos.stabilizing = false;
        pos._stabilizeSamples = null; // 释放内存

        const baselinePnlPct = ((baseline - pos.entryPrice) / pos.entryPrice) * 100;
        console.log(
          `[PositionManager] ✅ stabilization done ${pos.symbol || pos.mint.slice(0, 6)}: ` +
            `samples=${samples.length}, baseline=${baseline.toExponential(4)} (${baselinePnlPct.toFixed(2)}%), ` +
            `HWM set to ${pos.highWaterMark.toExponential(4)}`,
        );
        monitor.inc('PositionManager.stabilizationDone', 1, 'PositionManager');
        monitor.set('PositionManager.lastStabilizeSamples', samples.length, 'PositionManager');
      }
      // stabilizing 期内不进入 TP / trailing 流程，直接 return
      return;
    }

    // ============ 1. 紧急止损（非 stabilization 期）：救命路径，不双确认 ============
    const emergencyPct = config.strategy.emergencyStopLossPct;
    if (emergencyPct < 0 && pnlPct <= emergencyPct) {
      console.warn(
        `[PositionManager] 🚨 EMERGENCY_STOP ${pos.symbol || pos.mint.slice(0, 6)} ` +
          `pnl=${pnlPct.toFixed(2)}%`,
      );
      this._exit(pos, price, 'EMERGENCY_STOP');
      return;
    }

    // ============ 2. 更新 highWaterMark（仅 stabilization 结束后） ============
    if (price > pos.highWaterMark) {
      pos.highWaterMark = price;
      pos.highWaterMarkTs = Date.now();
    }
    const peakPnlPct = ((pos.highWaterMark - pos.entryPrice) / pos.entryPrice) * 100;

    // ============ 3. 主止盈：+50% 双确认 ============
    // 双确认机制保留：单次价格污染冲到 +50% 概率很大，双确认保护
    const tpPct = config.strategy.takeProfitPct;
    if (pnlPct >= tpPct) {
      const now = Date.now();
      pos._tpConfirmCount += 1;
      if (!pos._tpFirstTriggerTs) pos._tpFirstTriggerTs = now;

      const need = config.strategy.tpConfirmCount;
      const minGap = config.strategy.tpConfirmMinGapMs;
      const elapsed = now - pos._tpFirstTriggerTs;

      if (pos._tpConfirmCount >= need && elapsed >= minGap) {
        console.log(
          `[PositionManager] ✅ TAKE_PROFIT confirmed ${pos.symbol || pos.mint.slice(0, 6)} ` +
            `pnl=${pnlPct.toFixed(2)}% after ${pos._tpConfirmCount} ticks ${elapsed}ms`,
        );
        this._exit(pos, price, 'TAKE_PROFIT');
        return;
      }
      monitor.inc('PositionManager.tpPending', 1, 'PositionManager');
      // 不 return — 继续走 trailing 检查（理论上 +50% 通常也会触发 trailing，但顺序无所谓）
    } else if (pos._tpConfirmCount > 0) {
      // 价格回落到 TP 阈值以下：清掉双确认状态（重新计数）
      pos._tpConfirmCount = 0;
      pos._tpFirstTriggerTs = null;
    }

    // ============ 4. 移动止盈（trailing stop） ============
    // 两条件 AND：
    //   a. highWaterMark 已经涨过 entryPrice × (1 + trailingActivatePct/100)
    //      —— 一旦满足就 armed=true，即使后面 highWaterMark 不变（价格回落），trailing 保持激活
    //   b. 当前价格相对 highWaterMark 回撤 ≥ trailingDrawdownPct
    //
    // 稳定性保护：highWaterMark 必须稳定至少 trailingMinHwmAgeMs（默认 100ms）
    //             防止单一个污染 tick 创出虚假高点然后下一 tick "回撤" 触发误卖
    const trailingActivatePct = config.strategy.trailingActivatePct;
    const trailingDrawdownPct = config.strategy.trailingDrawdownPct;
    const trailingMinHwmAgeMs = config.strategy.trailingMinHwmAgeMs;

    if (trailingActivatePct > 0 && trailingDrawdownPct > 0) {
      // 一次性 arm：peakPnl ≥ +trailingActivatePct
      if (!pos.trailingArmed && peakPnlPct >= trailingActivatePct) {
        pos.trailingArmed = true;
        console.log(
          `[PositionManager] 🎯 TRAILING_ARMED ${pos.symbol || pos.mint.slice(0, 6)} ` +
            `peakPnl=${peakPnlPct.toFixed(2)}%, highWaterMark=${pos.highWaterMark.toExponential(4)}`,
        );
        monitor.inc('PositionManager.trailingArmed', 1, 'PositionManager');
      }

      if (pos.trailingArmed) {
        // 当前价相对 highWaterMark 的回撤百分比（正数）
        const drawdownPct = ((pos.highWaterMark - price) / pos.highWaterMark) * 100;
        const hwmAge = Date.now() - pos.highWaterMarkTs;

        if (drawdownPct >= trailingDrawdownPct && hwmAge >= trailingMinHwmAgeMs) {
          console.log(
            `[PositionManager] 📉 TRAILING_STOP ${pos.symbol || pos.mint.slice(0, 6)} ` +
              `peakPnl=${peakPnlPct.toFixed(2)}% → currentPnl=${pnlPct.toFixed(2)}% ` +
              `(drawdown ${drawdownPct.toFixed(2)}% from peak, hwmAge=${hwmAge}ms)`,
          );
          this._exit(pos, price, 'TRAILING_STOP');
          return;
        }
      }
    }
  }

  async _exit(pos, exitPrice, reason) {
    if (pos.exiting) return;
    pos.exiting = true;
    pos.exitReason = reason;

    monitor.inc(`PositionManager.exitsBy_${reason}`, 1, 'PositionManager');

    console.log(
      `[PositionManager] 📉 EXIT ${pos.symbol || pos.mint.slice(0, 6)} reason=${reason} ` +
        `triggerPnl=${(((exitPrice - pos.entryPrice) / pos.entryPrice) * 100).toFixed(2)}%`,
    );

    await this._attemptSell(pos, exitPrice);
  }

  async _attemptSell(pos, triggerPrice) {
    const tokenInfo = this.tokenRegistry.getToken(pos.mint);

    let sellResult;
    try {
      sellResult = await this.executor.sell({
        mint: pos.mint,
        symbol: pos.symbol,
        poolAddress: tokenInfo?.pool_address,
        poolBaseVault: tokenInfo?.pool_base_vault,
        poolQuoteVault: tokenInfo?.pool_quote_vault,
        tokenAmount: pos.tokenAmount,
        baseDecimals: tokenInfo?.decimals ?? 6,
        currentPrice: triggerPrice,
      });
    } catch (err) {
      monitor.recordError('PositionManager', err, {
        phase: 'sell_throw',
        mint: pos.mint,
        symbol: pos.symbol,
      });
      sellResult = { success: false, error: err.message, latencyMs: 0 };
    }

    pos.sellAttempts = (pos.sellAttempts || 0) + 1;

    const realSolOut = sellResult.solOut ?? null;
    const realExitPrice = sellResult.price ?? triggerPrice;

    // v3.4: 累加每次 sell 尝试的 priority fee（含失败的，因为失败也消耗了 fee）
    if (sellResult.priorityFeeLamports) {
      pos.sellFeeLamports = (pos.sellFeeLamports || 0) + sellResult.priorityFeeLamports;
    }

    // 记录 trade 提交事件（成功/失败都记）
    this.tradeLogger.logTrade({
      positionId: pos.positionId,
      ts: Date.now(),
      mint: pos.mint,
      symbol: pos.symbol,
      side: 'SELL',
      solAmount: realSolOut,
      tokenAmount: pos.tokenAmount,
      price: realExitPrice,
      signature: sellResult.signature,
      success: sellResult.success,
      dryRun: pos.dryRun,
      reason: pos.exitReason + (pos.sellAttempts > 1 ? `_retry_${pos.sellAttempts}` : ''),
      latencyMs: sellResult.latencyMs,
      error: sellResult.error,
    });

    // ============ 分支 A：提交本身失败（拿不到 signature） ============
    if (!sellResult.success) {
      monitor.inc('PositionManager.sellSubmitFail', 1, 'PositionManager');
      this.tradeLogger.recordSellAttempt(pos.positionId, sellResult.error);

      if (pos.dryRun) {
        monitor.recordError('PositionManager', new Error('DRY_RUN sell unexpectedly failed'), {
          mint: pos.mint,
          symbol: pos.symbol,
          error: sellResult.error,
        });
        console.error(
          `[PositionManager] DRY_RUN sell unexpectedly failed for ${pos.mint}; abandoning`,
        );
        this.tradeLogger.closePosition(pos.positionId, {
          closedAt: Date.now(),
          exitPrice: triggerPrice,
          exitSol: 0,
          pnlSol: -pos.entrySol,
          pnlPct: -100,
          exitReason: pos.exitReason + '_FAILED',
          sellSignature: null,
        });
        this.positions.delete(pos.positionId);
        this.byMint.delete(pos.mint);
        monitor.set('PositionManager.openCount', this.positions.size, 'PositionManager');
        return;
      }

      this._scheduleRetryOrStuck(pos, triggerPrice, sellResult.error);
      return;
    }

    // ============ 分支 B：提交成功，但还需等链上确认 ============
    // 此时 ⚠️ 不能立即 closePosition！tx 可能在 mempool 被丢、滑点超限被 reject
    // 标记 sell_confirming 状态，启动后台确认
    this.tradeLogger.markSellPending(pos.positionId, sellResult.signature, pos.exitReason);
    pos._lastSellSignature = sellResult.signature;

    if (pos.dryRun) {
      // DRY_RUN 直接当成功
      this._finalizeSuccess(pos, realExitPrice, realSolOut, sellResult.signature);
      return;
    }

    // 异步确认（不 await，避免阻塞下一笔操作；失败会自己触发 retry）
    this._confirmSellAsync(pos, sellResult.signature, realExitPrice, realSolOut, triggerPrice).catch(
      (err) => {
        monitor.recordError('PositionManager', err, {
          phase: 'confirm_async_crash',
          mint: pos.mint,
          signature: sellResult.signature,
        });
      },
    );
  }

  /**
   * 异步等待 sell tx 落链确认。
   * 三种结果：
   *   1. 链上确认无 err  → fetchTxSwapResult 拉真实 solOut → finalizeSuccess
   *   2. 链上 tx 报错      → scheduleRetry
   *   3. 超时未找到 tx    → scheduleRetry（mempool 丢弃）
   *
   * v3.17.6 修复：SELL 也用链上真实值替代 SDK 估算
   *   - 之前 exitPrice/solOut 是 _attemptSell 里 SDK 报价的 expectedSolOut
   *   - SDK 估算可能偏低 3-10%（不含 priority fee 扣减、池子状态略滞后）
   *   - 实测：DB 记录 -0.012 SOL 亏损，链上真实 +0.091 SOL 盈利
   *   - 修复：落链确认后，调 fetchTxSwapResult 拿真实 realSolDelta，覆盖 SDK 估算
   */
  async _confirmSellAsync(pos, signature, exitPrice, solOut, triggerPrice) {
    const result = await this.executor.confirmTx(signature, { timeoutMs: 15_000 });

    if (!this.positions.has(pos.positionId)) return; // 期间被其他流程关掉

    if (result.confirmed) {
      monitor.inc('PositionManager.sellConfirmed', 1, 'PositionManager');

      // v3.17.6: 拉链上真实 SOL 增量
      let realExitPrice = exitPrice;
      let realSolOut = solOut;
      try {
        const swap = await this.executor.fetchTxSwapResult(signature, pos.mint);
        // SELL 的 realSolDelta 是正数（钱包 SOL 增加）
        if (swap && swap.realSolDelta > 0 && pos.tokenAmount > 0) {
          realSolOut = swap.realSolDelta;
          realExitPrice = realSolOut / pos.tokenAmount;
          monitor.inc('PositionManager.sellReconciled', 1, 'PositionManager');
          const drift = solOut ? ((realSolOut - solOut) / solOut) * 100 : 0;
          console.log(
            `[PositionManager] 🔧 SELL reconciled ${pos.symbol || pos.mint.slice(0, 6)}: ` +
              `SDK est ${(solOut ?? 0).toFixed(4)} → real ${realSolOut.toFixed(4)} SOL (${drift.toFixed(2)}%)`,
          );
        } else {
          // fetchTxSwapResult 失败：保留 SDK 估算（旧行为）
          monitor.inc('PositionManager.sellReconcileFallback', 1, 'PositionManager');
          console.warn(
            `[PositionManager] SELL reconcile fallback to SDK estimate: ${pos.symbol || pos.mint.slice(0, 6)} ` +
              `sig=${signature.slice(0, 8)}.. (fetch returned no realSolDelta)`,
          );
        }
      } catch (err) {
        monitor.recordError('PositionManager', err, {
          phase: 'sell_reconcile_fetch',
          mint: pos.mint,
          signature,
        });
        // 异常时也 fallback 到 SDK 估算
      }

      this._finalizeSuccess(pos, realExitPrice, realSolOut, signature);
      return;
    }

    monitor.inc('PositionManager.sellNotLanded', 1, 'PositionManager');
    const errMsg = `tx ${signature.slice(0, 8)}.. ${result.error || 'not_landed'}`;
    console.warn(
      `[PositionManager] SELL submitted but not confirmed: ${pos.symbol || pos.mint.slice(0, 6)}: ${errMsg}`,
    );

    // v3.17.8: 双保险 — confirmTx 超时(15s)不等于交易失败
    //   实战发现:10 笔 stuck position 链上 SELL 其实都成功了,只是 confirmTx 没等到
    //   原因:网络抖动 / RPC subscribeSignature 错过通知 / tx 实际在 18-30s 后才确认
    //   修复:confirm 失败后再直接拉一次链上 tx,如果 fetchTxSwapResult 成功 → 走 success 路径
    //   不能完全依赖这条路径 — 它可能也失败(tx 真的没落链),所以失败时仍走 retry
    try {
      const swap = await this.executor.fetchTxSwapResult(signature, pos.mint);
      if (swap && swap.realSolDelta > 0 && pos.tokenAmount > 0) {
        const realSolOut = swap.realSolDelta;
        const realExitPrice = realSolOut / pos.tokenAmount;
        monitor.inc('PositionManager.sellRecoveredFromTimeout', 1, 'PositionManager');
        console.log(
          `[PositionManager] ✅ SELL actually landed (recovered from confirm timeout) ` +
            `${pos.symbol || pos.mint.slice(0, 6)}: realSol=${realSolOut.toFixed(4)}`,
        );
        this._finalizeSuccess(pos, realExitPrice, realSolOut, signature);
        return;
      }
    } catch (err) {
      // fetchTxSwapResult 也失败 → 真的没落链或链上 tx 失败,继续 retry 流程
      monitor.recordError('PositionManager', err, {
        phase: 'sell_recovery_fetch',
        mint: pos.mint,
        signature,
      });
    }

    this._scheduleRetryOrStuck(pos, triggerPrice, errMsg);
  }

  _finalizeSuccess(pos, exitPrice, solOut, signature) {
    const exitSol = solOut ?? pos.tokenAmount * exitPrice;

    // v3.4: PnL 现在分两个口径：
    //   grossPnl = exitSol - entrySol（不含 fee；用于策略判断）
    //   netPnl   = exitSol - entrySol - feeSol（真实利润，含 priority fee）
    // closePosition 用 netPnl，因为这是用户真正赚到的
    const grossPnl = exitSol - pos.entrySol;
    const totalFeeLamports = (pos.buyFeeLamports || 0) + (pos.sellFeeLamports || 0);
    // 加上 base fee（每笔 5000 lamports × 2 笔 = 10000，约 0.00001 SOL，量小但加上更准）
    const baseFeeSol = 0.00001;
    const feeSol = totalFeeLamports / 1e9 + baseFeeSol;
    const pnlSol = grossPnl - feeSol;
    const pnlPct = (pnlSol / pos.entrySol) * 100;

    this.tradeLogger.closePosition(pos.positionId, {
      closedAt: Date.now(),
      exitPrice,
      exitSol,
      pnlSol,
      pnlPct,
      exitReason: pos.exitReason,
      sellSignature: signature,
    });

    this.positions.delete(pos.positionId);
    this.byMint.delete(pos.mint);
    monitor.inc('PositionManager.closed', 1, 'PositionManager');
    monitor.set('PositionManager.openCount', this.positions.size, 'PositionManager');
    if (pnlSol > 0) monitor.inc('PositionManager.winners', 1, 'PositionManager');
    else monitor.inc('PositionManager.losers', 1, 'PositionManager');

    console.log(
      `[PositionManager] 🏁 CLOSED ${pos.symbol || pos.mint.slice(0, 6)} ` +
        `gross=${grossPnl.toFixed(4)} fee=${feeSol.toFixed(4)} net=${pnlSol.toFixed(4)} SOL (${pnlPct.toFixed(2)}%)`,
    );

    this.emit('closed', {
      ...pos,
      exitPrice,
      exitSol,
      pnlSol,
      pnlPct,
      exitReason: pos.exitReason,
      grossPnlSol: grossPnl,
      feeSol,
    });
  }

  _scheduleRetryOrStuck(pos, triggerPrice, errMsg) {
    monitor.inc('PositionManager.sellRetries', 1, 'PositionManager');

    // 重试上限：默认 12 次（SELL_RETRY_DELAYS_MS × 2）。超过标 stuck
    const MAX_RETRIES = SELL_RETRY_DELAYS_MS.length * 2;
    if (pos.sellAttempts >= MAX_RETRIES) {
      monitor.inc('PositionManager.sellStuck', 1, 'PositionManager');
      this.tradeLogger.markStuck(
        pos.positionId,
        `gave up after ${pos.sellAttempts} attempts: ${errMsg}`,
      );
      console.error(
        `[PositionManager] ⚠️ STUCK ${pos.symbol || pos.mint.slice(0, 6)}: ` +
          `${pos.sellAttempts} 次重试均失败 — token 留在钱包中，需人工干预`,
      );
      // 关键：保持 exiting=true 防止 tick/priceUpdate 再次触发 _exit 进入无限循环
      // 也不从 this.positions 删除：保留以便 reconciler 监控、dashboard 显示警告
      pos.exiting = true;
      pos.status = 'stuck';
      return;
    }

    const delayIdx = Math.min(pos.sellAttempts - 1, SELL_RETRY_DELAYS_MS.length - 1);
    const delay = SELL_RETRY_DELAYS_MS[delayIdx] || 30_000;
    const nextRetryAt = Date.now() + delay;

    // 持久化下次重试时间，重启后 reconciler 会按时唤醒
    this.tradeLogger.markSellFailedPendingRetry(
      pos.positionId,
      nextRetryAt,
      errMsg,
      pos.exitReason,
    );

    console.warn(
      `[PositionManager] SELL retry scheduled: ${pos.symbol || pos.mint.slice(0, 6)} ` +
        `(attempt ${pos.sellAttempts}/${MAX_RETRIES}) in ${delay}ms — ${errMsg}`,
    );

    setTimeout(() => {
      if (!this.positions.has(pos.positionId)) return;
      const latestPrice = this.priceTracker.getPrice(pos.mint) || triggerPrice;
      this._attemptSell(pos, latestPrice).catch((err) => {
        monitor.recordError('PositionManager', err, {
          phase: 'sell_retry_crash',
          mint: pos.mint,
        });
      });
    }, delay);
  }

  /**
   * v3.3 重试 reconciler
   * ====================
   * 每 5 秒扫一遍 DB，找出所有 status='sell_pending' 且 next_retry_at <= now 的 position
   * 这覆盖两种场景：
   *   1. 重启后 setTimeout 丢失 → 找回所有过期的 retry
   *   2. confirm_async 失败但 setTimeout 也未触发（edge case）
   *
   * 同时检查 sell_confirming 状态：如果最后一次提交超过 30s 还在 sell_confirming，
   * 主动调一次 confirmTx，没确认就触发重试。
   */
  /**
   * v3.4 主动轮询持仓 token 的 pool state，算出当前实时价格。
   * 修复 TIMEOUT 主导问题：微盘币 15s 内可能没有任何外部 swap → PriceTracker 永远不更新
   * → 永远不触发止盈止损 → 全部强平。
   *
   * 实现：用 Executor 的 onlineSdk 直接拉 pool state，从 reserves 算 mid price。
   * 频率：每 poolPollIntervalMs (默认 500ms)
   * 仅持仓期间轮询（持仓为空时不发 RPC）
   */
  async _pollPoolPrices() {
    if (this.positions.size === 0) return;
    if (this._polling) return; // 防止上一轮还没跑完
    this._polling = true;
    try {
      // 收集所有需要查的 (mint, poolAddress) 组合
      const queries = [];
      for (const pos of this.positions.values()) {
        if (pos.exiting) continue; // 正在卖的不需要再轮询
        const tokenInfo = this.tokenRegistry.getToken(pos.mint);
        if (!tokenInfo?.pool_address) continue;
        queries.push({ mint: pos.mint, poolAddress: tokenInfo.pool_address, decimals: tokenInfo.decimals ?? 6 });
      }
      if (queries.length === 0) return;

      // 并行拉，不阻塞
      await Promise.all(
        queries.map(async (q) => {
          try {
            const price = await this._fetchPoolMidPrice(q.poolAddress, q.decimals);
            if (price && price > 0) {
              this.priceTracker.update(q.mint, price, Date.now(), q.poolAddress);
              monitor.inc('PositionManager.poolPollOk', 1, 'PositionManager');
            }
          } catch (err) {
            monitor.inc('PositionManager.poolPollFail', 1, 'PositionManager');
          }
        }),
      );
    } finally {
      this._polling = false;
    }
  }

  /**
   * 从 pool 的 reserves 算 mid price = quoteReserve / baseReserve（按 decimals 调整）
   * 用 Executor 已加载的 onlineSdk
   */
  async _fetchPoolMidPrice(poolAddress, baseDecimals) {
    if (!this.executor.onlineSdk || !this.executor.keypair) return null;
    const { PublicKey } = require('@solana/web3.js');
    const poolKey = new PublicKey(poolAddress);
    const state = await this.executor.onlineSdk.swapSolanaState(poolKey, this.executor.keypair.publicKey);
    if (!state || !state.poolBaseAmount || !state.poolQuoteAmount) return null;

    // Number 精度对小价格够用（small floats），不用 BigInt 除
    const baseRaw = Number(state.poolBaseAmount.toString());
    const quoteRaw = Number(state.poolQuoteAmount.toString());
    if (baseRaw <= 0 || quoteRaw <= 0) return null;

    // mid_price = (quote / 1e9) / (base / 10^baseDecimals)
    //          = quote * 10^baseDecimals / (base * 1e9)
    const price = (quoteRaw / 1e9) / (baseRaw / Math.pow(10, baseDecimals));
    return price;
  }

  async _reconcileRetries() {
    if (this._reconciling) return; // 防止上一轮还没跑完，新轮就启动
    this._reconciling = true;
    try {
      await this._reconcileRetriesInner();
    } finally {
      this._reconciling = false;
    }
  }

  async _reconcileRetriesInner() {
    const now = Date.now();
    const due = this.tradeLogger.getDuePendingRetries(now);

    for (const row of due) {
      const pos = this.positions.get(row.position_id);
      if (!pos) continue; // 已被删除

      // 跳过 stuck 的（不再自动重试，等人工干预）
      if (row.status === 'stuck' || pos.status === 'stuck') continue;

      // sell_confirming：还在等链上确认；只有 last_retry_at 已经超过 30s 才主动重试
      if (row.status === 'sell_confirming') {
        const lastRetry = row.last_retry_at || 0;
        if (now - lastRetry < 30_000) continue;

        // 已经 30s+ 没动静，主动 confirmTx 一次
        const sig = row.pending_sell_signature || pos._lastSellSignature;
        if (sig) {
          const result = await this.executor.confirmTx(sig, { timeoutMs: 3000, pollIntervalMs: 500 });
          if (result.confirmed) {
            monitor.inc('PositionManager.reconcilerConfirmed', 1, 'PositionManager');

            // v3.17 修复 PnL bug：
            // 之前用 pos.entryPrice 作为 exitPrice 占位 → _finalizeSuccess 里 exitSol
            // 退化为 tokenAmount * entryPrice = entrySol → 净 PnL ≈ -feeSol（误显示亏损）。
            // 现在从链上 fetch 真实 SOL 收入，按真实成交价回写。
            let exitPrice = pos.entryPrice;
            let solOut = null;
            try {
              const swap = await this.executor.fetchTxSwapResult(sig, pos.mint);
              // SELL 的 realSolDelta 是正数（钱包 SOL 增加），需 > 0 才有效
              if (swap && swap.realSolDelta > 0 && pos.tokenAmount > 0) {
                solOut = swap.realSolDelta;
                exitPrice = solOut / pos.tokenAmount;
                // 同时累加 SELL tx 的 base fee（priority fee 已包含在 realSolDelta 里）
                if (swap.fee && !pos._reconcilerSellFeeAccounted) {
                  // realSolDelta 已经扣过 priority fee + base fee；这里不再叠加
                  // （避免双重扣减）
                  pos._reconcilerSellFeeAccounted = true;
                }
                console.log(
                  `[PositionManager] 🔄 reconciler found landed sell: ${pos.symbol || pos.mint.slice(0, 6)}, ` +
                    `solOut=${solOut.toFixed(4)} SOL, exitPrice=${exitPrice.toExponential(4)}`,
                );
              } else {
                console.warn(
                  `[PositionManager] 🔄 reconciler found landed sell: ${pos.symbol || pos.mint.slice(0, 6)}, ` +
                    `但 fetchTxSwapResult 拿不到 realSolDelta — fallback 用 entryPrice 占位（PnL 将不准）`,
                );
              }
            } catch (err) {
              monitor.recordError('PositionManager', err, {
                phase: 'reconciler_fetch_swap',
                mint: pos.mint,
                signature: sig,
              });
            }

            this._finalizeSuccess(pos, exitPrice, solOut, sig);
            continue;
          }
        }
        // 没确认，触发重试
        monitor.inc('PositionManager.reconcilerRetried', 1, 'PositionManager');
      }

      // sell_pending（明确等待重试）：直接触发
      const latestPrice = this.priceTracker.getPrice(pos.mint) || pos.entryPrice;
      console.log(
        `[PositionManager] 🔄 reconciler retrying ${pos.symbol || pos.mint.slice(0, 6)} ` +
          `(status=${row.status}, attempts=${pos.sellAttempts})`,
      );
      // 不 await，让多个 retry 并行（但同一 pos 不会并发，因为 status 字段 + lock）
      this._attemptSell(pos, latestPrice).catch((err) => {
        monitor.recordError('PositionManager', err, {
          phase: 'reconciler_retry',
          mint: pos.mint,
        });
      });
    }
  }
}

module.exports = PositionManager;
