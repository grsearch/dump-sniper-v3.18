'use strict';

/**
 * AlertChecker
 * ============
 * 业务规则告警。每 5 秒跑一次，检查特定的"应该发生但没发生"或"不应该发生但发生了"
 * 的情况，触发 monitor.fireAlert。
 *
 * 这一层的职责是把"指标异常"翻译成人能看懂的告警。
 */

const CHECK_INTERVAL_MS = 5_000;

class AlertChecker {
  constructor({ monitor, tickStream, executor, positionManager, tokenRegistry, config }) {
    this.monitor = monitor;
    this.tickStream = tickStream;
    this.executor = executor;
    this.positionManager = positionManager;
    this.tokenRegistry = tokenRegistry;
    this.config = config;

    this._timer = null;

    // 用于趋势告警的 baseline
    this._lastTxCount = 0;
    this._lastTxCountAt = Date.now();
    this._lastBuyFail = 0;
    this._lastSellFail = 0;
  }

  start() {
    this._timer = setInterval(() => this._check(), CHECK_INTERVAL_MS);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
  }

  _check() {
    try {
      this._checkTickStream();
      this._checkExecutorFailures();
      this._checkStuckPositions();
      this._checkParseErrorRate();
      // v3.17.9: BUY 链上失败 / CU 接近上限 / reconcile watchdog 触发
      this._checkBuyChainFailures();
    } catch (err) {
      this.monitor.recordError('AlertChecker', err);
    }
  }

  /**
   * v3.17.9: 关键的 BUY 链上失败监控
   *
   * 区分两种情况:
   * 1. CU 接近上限(≥90% 利用率):告警 warn 级别 — 提示"还有余量但 BUY 即将开始爆"
   * 2. 链上 BUY 失败(ProgramFailedToComplete):error 级别 — 已经在烧 fee 但没买到
   * 3. reconcile watchdog 触发(60s 内 reconcile 没完成):critical — 通常是 RPC 问题
   */
  _checkBuyChainFailures() {
    const cuNearLimit = this.monitor.getCounter('PositionManager.cuNearLimit') || 0;
    const buyChainFail = this.monitor.getCounter('PositionManager.buyChainFail') || 0;
    const reconcileWatchdog = this.monitor.getCounter('PositionManager.reconcileWatchdog') || 0;

    // CU 接近上限 — 还能成功但下一笔可能爆
    if (cuNearLimit > 0) {
      this.monitor.fireAlert(
        'executor.cu_near_limit',
        'warn',
        `${cuNearLimit} 笔 BUY CU 利用率 ≥90%,下一笔可能 BUY_CHAIN_FAILED。立刻调大 COMPUTE_UNIT_LIMIT (推荐 +30K)`,
        { cuNearLimit },
      );
    } else {
      this.monitor.clearAlert('executor.cu_near_limit');
    }

    // BUY 链上失败 — 已经烧 fee 但没买到 token
    if (buyChainFail > 0) {
      this.monitor.fireAlert(
        'executor.buy_chain_failed',
        'error',
        `${buyChainFail} 笔 BUY ProgramFailedToComplete,fee 已烧但 token 没买到。立刻调大 COMPUTE_UNIT_LIMIT`,
        { buyChainFail },
      );
    } else {
      this.monitor.clearAlert('executor.buy_chain_failed');
    }

    // reconcile watchdog 触发 — 异常的 reconcile 未执行场景
    if (reconcileWatchdog > 0) {
      this.monitor.fireAlert(
        'positions.reconcile_watchdog',
        'critical',
        `${reconcileWatchdog} 笔 position 60s 内 reconcile 未完成被 watchdog 强关。通常是 Helius RPC 异常,检查网络`,
        { reconcileWatchdog },
      );
    } else {
      this.monitor.clearAlert('positions.reconcile_watchdog');
    }
  }

  /**
   * TickStream 在监控列表非空时，应该持续收到 tx。
   * 60 秒内 0 tx 是异常。
   */
  _checkTickStream() {
    const watching = this.tokenRegistry.getActiveMintSet().size;
    if (watching === 0) {
      this.monitor.clearAlert('tickstream.no_traffic');
      return;
    }
    const txCount = this.monitor.getCounter('TickStream.txReceived');
    const now = Date.now();
    if (txCount > this._lastTxCount) {
      this._lastTxCount = txCount;
      this._lastTxCountAt = now;
      this.monitor.clearAlert('tickstream.no_traffic');
    } else if (now - this._lastTxCountAt > 60_000) {
      this.monitor.fireAlert(
        'tickstream.no_traffic',
        'warn',
        `LaserStream 监控 ${watching} 个代币，但 60s+ 无 tx 收到`,
        { watching, last_tx_seconds_ago: Math.round((now - this._lastTxCountAt) / 1000) },
      );
    }
  }

  /**
   * Executor：连续 3 次 BUY 失败 / SELL 失败 → 告警
   */
  _checkExecutorFailures() {
    const buyFail = this.monitor.getCounter('Executor.buyFail');
    const buySuccess = this.monitor.getCounter('Executor.buySuccess');
    const sellFail = this.monitor.getCounter('Executor.sellFail');
    const sellSuccess = this.monitor.getCounter('Executor.sellSuccess');

    // 连续失败 = (失败次数 - 上次成功后的失败次数) ≥ 3
    // 这里用更简单的近似：最近 5 笔交易里失败 ≥ 3
    const recentBuy = buyFail + buySuccess;
    if (recentBuy >= 3) {
      const failRate = buyFail / recentBuy;
      if (failRate >= 0.6) {
        this.monitor.fireAlert(
          'executor.buy_failures',
          'error',
          `BUY 失败率高: ${buyFail}/${recentBuy} (${(failRate * 100).toFixed(0)}%)`,
          { buyFail, buySuccess },
        );
      } else {
        this.monitor.clearAlert('executor.buy_failures');
      }
    }
    const recentSell = sellFail + sellSuccess;
    if (recentSell >= 3) {
      const failRate = sellFail / recentSell;
      if (failRate >= 0.6) {
        this.monitor.fireAlert(
          'executor.sell_failures',
          'critical',
          `SELL 失败率高: ${sellFail}/${recentSell} (${(failRate * 100).toFixed(0)}%) - 资金可能卡住`,
          { sellFail, sellSuccess },
        );
      } else {
        this.monitor.clearAlert('executor.sell_failures');
      }
    }
  }

  /**
   * 持仓 > maxHoldMs + 5s 还没退出 → 应当报警
   */
  _checkStuckPositions() {
    const open = this.positionManager.listOpen();
    const now = Date.now();
    const maxAge = this.config.strategy.maxHoldMs + 5_000;
    const stuck = open.filter((p) => now - p.openedAt > maxAge);
    if (stuck.length > 0) {
      this.monitor.fireAlert(
        'positions.stuck',
        'critical',
        `${stuck.length} 个持仓超过 maxHoldMs+5s 未退出（可能 SELL 一直失败）`,
        {
          mints: stuck.map((p) => ({
            symbol: p.symbol,
            mint: p.mint,
            age_s: Math.round((now - p.openedAt) / 1000),
            sell_attempts: p.sellAttempts || 0,
          })),
        },
      );
    } else {
      this.monitor.clearAlert('positions.stuck');
    }
  }

  /**
   * DumpDetector 解析错误率 > 10% → 告警
   */
  _checkParseErrorRate() {
    const total = this.monitor.getCounter('DumpDetector.txParsed');
    const errors = this.monitor.getCounter('DumpDetector.parseErrors');
    if (total < 50) return; // 样本不足
    const rate = errors / total;
    if (rate > 0.1) {
      this.monitor.fireAlert(
        'detector.high_parse_error_rate',
        'warn',
        `DumpDetector 解析错误率 ${(rate * 100).toFixed(1)}% (${errors}/${total})`,
        { errors, total },
      );
    } else {
      this.monitor.clearAlert('detector.high_parse_error_rate');
    }
  }
}

module.exports = AlertChecker;
