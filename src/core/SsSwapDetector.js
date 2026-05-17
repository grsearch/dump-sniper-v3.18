'use strict';

/**
 * SsSwapDetector (v3.18 Week 3)
 * =============================
 * 从 ShredStream 接收的 raw VersionedTransaction 直接判定砸盘,
 * 不依赖 LaserStream 的 meta (preTokenBalances / postTokenBalances)。
 *
 * 这是 atomic Jito Bundle 模式的关键 - 必须在 dump tx 落链前发出 dumpSignal。
 * 等 LS 推送 confirmed tx 时,dump tx 已经被 leader 打包,Jito Bundle 会返回
 * "transaction already processed" 400 错误。
 *
 * 检测流程:
 *   1. raw tx bytes (来自 ShredStream)
 *   2. 字节扫描 Pump AMM program ID (95%+ 过滤)
 *   3. VersionedTransaction.deserialize
 *   4. 遍历 compiled instructions, 找 program_idx → Pump AMM 的指令
 *   5. 检查指令 data 前 8 bytes:
 *      - sell discriminator [51, 230, 133, 164, 1, 127, 131, 173] (0x33e685a4017f83ad)
 *   6. 解析 instruction data:
 *      - base_amount_in (u64 LE, bytes 8..16) = 卖出的 token 数量
 *      - min_quote_amount_out (u64 LE, bytes 16..24) = slippage 保护
 *   7. 从 instruction accounts[0] (pool address) 找哪个 token
 *   8. 查 PoolStateCache 当前 reserves,算 SOL 价值 + priceImpact:
 *        sol_out = pool_quote × base_in / (pool_base + base_in)
 *        priceImpact = base_in / pool_base
 *   9. 通过阈值 → emit dumpSignal (含 dumpTxRaw)
 *
 * 跟 DumpDetector (LS 路径) 共存:
 *   - SS path: 优先, 同 slot bundle 用
 *   - LS path: 兜底, 错过的 tx 走老路径(+1 slot)
 *   - dedup 通过 signature 互斥, 防止双触发
 *
 * 性能要求:
 *   每条 SS tx 处理 ≤ 5ms (字节扫描 + deserialize + 决策)
 *   PoolStateCache 命中时 0ms 拿 reserves
 */

const EventEmitter = require('events');
const bs58Lib = require('bs58');
const bs58 = bs58Lib.default || bs58Lib;
const { PublicKey, VersionedTransaction } = require('@solana/web3.js');
const { config } = require('../config');
const { getMonitor } = require('../monitor/HealthMonitor');

const PUMP_AMM_PROGRAM_ID = config.programs.pumpAmm;
const PUMP_AMM_PROGRAM_BYTES = new PublicKey(PUMP_AMM_PROGRAM_ID).toBuffer();

// Pump AMM instruction discriminators (前 8 bytes of instruction data)
// 来源: @pump-fun/pump-swap-sdk IDL
const DISCRIMINATOR_SELL = Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]);
const DISCRIMINATOR_BUY = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);
const DISCRIMINATOR_BUY_EXACT_QUOTE = Buffer.from([198, 46, 21, 82, 180, 217, 232, 112]);

class SsSwapDetector extends EventEmitter {
  /**
   * @param {object} opts
   * @param {TokenRegistry} opts.tokenRegistry - 用于查 pool → mint 映射
   * @param {PoolStateCache} opts.poolStateCache - 用于拿当前 reserves
   * @param {number} [opts.minSellSol=10] - 卖出最少 SOL 阈值
   * @param {number} [opts.minPriceImpactPct=10] - 最少 priceImpact
   * @param {number} [opts.maxPriceImpactPct=50] - 最高 priceImpact (大于此值 = rug pull)
   * @param {number} [opts.minPoolQuoteSol=30] - 池子最少 SOL 流动性
   */
  constructor(opts = {}) {
    super();
    this.tokenRegistry = opts.tokenRegistry;
    this.poolStateCache = opts.poolStateCache;
    this.minSellSol = opts.minSellSol ?? config.strategy.minSellSol;
    this.minPriceImpactPct = opts.minPriceImpactPct ?? config.strategy.minPriceImpactPct;
    this.maxPriceImpactPct = opts.maxPriceImpactPct ?? config.strategy.maxPriceImpactPct;
    this.minPoolQuoteSol = opts.minPoolQuoteSol ?? config.strategy.minPoolQuoteSol;

    this.monitor = getMonitor();
    this.monitor.registerModule('SsSwapDetector', { staleMs: 120_000, label: 'SS Swap Detector' });

    // sig 级 dedup, 防止 SS + LS 双触发同一个砸盘
    // 由 SignalEngine 维护的 ourSignatures Set 和这里独立,各自的目的不同
    this._processedSigs = new Map(); // sig → ts
    this._processedSigsMax = 5000;
    this._processedSigsTtlMs = 60_000;
    this._cleanupTimer = setInterval(() => this._cleanProcessedSigs(), 30_000);
    if (this._cleanupTimer.unref) this._cleanupTimer.unref();
  }

  /**
   * 判断 signature 是否已被 SS 路径处理过(防止 LS 重复触发)
   * 由 DumpDetector (LS 路径) 调用,如果返回 true,LS 跳过这个砸盘
   */
  hasProcessed(sig) {
    if (!sig) return false;
    const ts = this._processedSigs.get(sig);
    if (!ts) return false;
    if (Date.now() - ts > this._processedSigsTtlMs) {
      this._processedSigs.delete(sig);
      return false;
    }
    return true;
  }

  _markProcessed(sig) {
    if (!sig) return;
    this._processedSigs.set(sig, Date.now());
    if (this._processedSigs.size > this._processedSigsMax) {
      this._cleanProcessedSigs();
    }
  }

  _cleanProcessedSigs() {
    const now = Date.now();
    for (const [sig, ts] of this._processedSigs) {
      if (now - ts > this._processedSigsTtlMs) this._processedSigs.delete(sig);
    }
  }

  /**
   * 入口: ShredStream 推送 wire-format raw tx 时调用
   *
   * @param {Buffer} rawTx - serialized VersionedTransaction bytes
   * @param {number} slot
   * @returns {void} - 通过 emit('dumpSignal') 推下游
   */
  handleRawTx(rawTx, slot) {
    const t0 = Date.now();
    this.monitor.inc('SsSwapDetector.txReceived', 1, 'SsSwapDetector');

    // Step 1: 字节扫描 Pump AMM program 在 raw 里
    // (TickStream._shredLoop 已经做了这步,这里二次防御)
    if (rawTx.indexOf(PUMP_AMM_PROGRAM_BYTES) === -1) {
      this.monitor.inc('SsSwapDetector.filteredOut', 1, 'SsSwapDetector');
      return;
    }

    // Step 2: deserialize
    let tx;
    try {
      tx = VersionedTransaction.deserialize(new Uint8Array(rawTx));
    } catch (err) {
      this.monitor.inc('SsSwapDetector.deserializeErrors', 1, 'SsSwapDetector');
      return;
    }

    // Step 3: 取 signature, dedup
    const sigBytes = tx.signatures[0];
    if (!sigBytes) return;
    const sig = bs58.encode(Buffer.from(sigBytes));
    if (this.hasProcessed(sig)) {
      this.monitor.inc('SsSwapDetector.dedupHit', 1, 'SsSwapDetector');
      return;
    }

    // Step 4: 取 staticAccountKeys + 找 Pump AMM program index
    const staticKeys = tx.message.staticAccountKeys || [];
    let pumpAmmProgramIdx = -1;
    for (let i = 0; i < staticKeys.length; i++) {
      if (staticKeys[i].toBase58() === PUMP_AMM_PROGRAM_ID) {
        pumpAmmProgramIdx = i;
        break;
      }
    }
    // 也可能 program 在 loadedAddresses (从 ALT 加载) — 但 SS raw tx 时
    // 我们还没 resolve ALT, 所以只能看 staticKeys。这是已知限制,
    // 涵盖了 90%+ 的直接 Pump AMM 调用。Jupiter 路由情况不在 SS 路径处理范围。
    if (pumpAmmProgramIdx === -1) {
      this.monitor.inc('SsSwapDetector.noPumpAmmInStatic', 1, 'SsSwapDetector');
      return;
    }

    // Step 5: 遍历 instructions, 找 program_idx == pumpAmmProgramIdx 且 discriminator == sell
    const instructions = tx.message.compiledInstructions || [];
    let sellIx = null;
    for (let i = 0; i < instructions.length; i++) {
      const ix = instructions[i];
      if (ix.programIdIndex !== pumpAmmProgramIdx) continue;
      // 检查 discriminator
      const data = ix.data;
      if (!data || data.length < 24) continue; // sell 至少 8+8+8 = 24 bytes
      // 比对 discriminator
      let match = true;
      for (let j = 0; j < 8; j++) {
        if (data[j] !== DISCRIMINATOR_SELL[j]) { match = false; break; }
      }
      if (match) {
        sellIx = ix;
        break;
      }
    }
    if (!sellIx) {
      // 也许是 buy 或其他 Pump AMM 指令, 不是砸盘
      this.monitor.inc('SsSwapDetector.notSell', 1, 'SsSwapDetector');
      return;
    }

    this.monitor.inc('SsSwapDetector.sellFound', 1, 'SsSwapDetector');

    // Step 6: 解析 instruction data
    // sell: { base_amount_in: u64 LE, min_quote_amount_out: u64 LE }
    const data = sellIx.data;
    // 用 Buffer 处理(可能 data 是 Uint8Array)
    const dataBuf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const baseAmountIn = dataBuf.readBigUInt64LE(8); // BigInt
    const minQuoteOut = dataBuf.readBigUInt64LE(16);

    // Step 7: 取 instruction accounts[0] = pool address
    // sellIx.accountKeyIndexes 是 Uint8Array,索引到 message.accountKeys
    // 注意: 对于 v0 tx, accountKeys 包括 staticKeys + ALT addresses (但 ALT 没 resolve)
    // pool 通常是 ALT 的第一个写账户。但实际上,大部分 Pump AMM 直调,pool 在 staticKeys 里
    const accountIndexes = sellIx.accountKeyIndexes;
    if (!accountIndexes || accountIndexes.length === 0) {
      this.monitor.inc('SsSwapDetector.noAccounts', 1, 'SsSwapDetector');
      return;
    }
    const poolIdx = accountIndexes[0];
    if (poolIdx >= staticKeys.length) {
      // pool 在 ALT 里, SS 路径无法直接读
      // 这种情况(Jupiter 路由等)由 LS 路径兜底
      this.monitor.inc('SsSwapDetector.poolInALT', 1, 'SsSwapDetector');
      return;
    }
    const poolAddress = staticKeys[poolIdx].toBase58();

    // Step 8: 查 TokenRegistry 找 pool → mint
    if (!this.tokenRegistry) {
      this.monitor.inc('SsSwapDetector.noTokenRegistry', 1, 'SsSwapDetector');
      return;
    }
    // tokenRegistry 通常按 mint 查,这里需要按 pool 反查
    // 用 tokenRegistry.getTokenByPool 如果有,否则遍历(在监控 token 量级 50-100 时是 OK 的)
    let tokenInfo = null;
    if (typeof this.tokenRegistry.getTokenByPool === 'function') {
      tokenInfo = this.tokenRegistry.getTokenByPool(poolAddress);
    } else {
      // 退化: 遍历查
      const allTokens = this.tokenRegistry.getAllTokens?.() || [];
      tokenInfo = allTokens.find(t => t.pool_address === poolAddress);
    }
    if (!tokenInfo) {
      // 不是监控的 token,无视
      this.monitor.inc('SsSwapDetector.poolNotWatched', 1, 'SsSwapDetector');
      return;
    }

    // Step 9: 拿 PoolStateCache 当前 reserves 算 SOL 价值
    if (!this.poolStateCache) {
      this.monitor.inc('SsSwapDetector.noPoolCache', 1, 'SsSwapDetector');
      return;
    }
    const poolState = this.poolStateCache.get(poolAddress);
    if (!poolState) {
      this.monitor.inc('SsSwapDetector.poolStateCacheMiss', 1, 'SsSwapDetector');
      return;
    }

    // 从 poolState 取 reserves
    // PoolStateCache 存的是 SDK swapSolanaState 的结构, 里面有 baseTokenReserve / quoteTokenReserve
    // 但具体字段名要看 SDK 实现, 这里做防御性 fallback
    const baseReserveBN = this._extractReserve(poolState, 'base');
    const quoteReserveBN = this._extractReserve(poolState, 'quote');
    if (baseReserveBN == null || quoteReserveBN == null) {
      this.monitor.inc('SsSwapDetector.poolStateMalformed', 1, 'SsSwapDetector');
      return;
    }

    // 用 BigInt 算精确,避免 Number 精度问题
    const baseReserveBI = BigInt(baseReserveBN.toString());
    const quoteReserveBI = BigInt(quoteReserveBN.toString());
    if (baseReserveBI === 0n || quoteReserveBI === 0n) {
      this.monitor.inc('SsSwapDetector.poolEmpty', 1, 'SsSwapDetector');
      return;
    }

    // Step 10: 算 priceImpact + sol_out
    // constant product: (base + dx) × (quote - dy) = base × quote
    // 解: dy = quote × dx / (base + dx)
    const dx = baseAmountIn; // 卖出的 base token (lamports of base)
    const baseAfter = baseReserveBI + dx;
    const dy = (quoteReserveBI * dx) / baseAfter; // SOL out (lamports)
    const quoteAfter = quoteReserveBI - dy;

    const solOut = Number(dy) / 1e9; // lamports → SOL
    const poolQuoteAfterSol = Number(quoteAfter) / 1e9;
    const poolQuoteBeforeSol = Number(quoteReserveBI) / 1e9;

    // priceImpact: 用 base 占比衡量
    // priceImpactPct = dx / (base + dx) × 100 (相对于砸盘后的总 base 大小)
    // 或者 = dx / base × 100 (相对于砸盘前的 base) — 跟 LS 路径口径一致用后者
    const priceImpactPct = Number((dx * 10000n) / baseReserveBI) / 100; // 0.01% precision

    // Step 11: 应用阈值
    if (solOut < this.minSellSol) {
      this.monitor.inc('SsSwapDetector.belowMinSellSol', 1, 'SsSwapDetector');
      return;
    }
    if (priceImpactPct < this.minPriceImpactPct) {
      this.monitor.inc('SsSwapDetector.belowMinImpact', 1, 'SsSwapDetector');
      return;
    }
    if (priceImpactPct > this.maxPriceImpactPct) {
      this.monitor.inc('SsSwapDetector.aboveMaxImpact', 1, 'SsSwapDetector');
      return;
    }
    if (poolQuoteBeforeSol < this.minPoolQuoteSol) {
      this.monitor.inc('SsSwapDetector.poolTooSmall', 1, 'SsSwapDetector');
      return;
    }

    // Step 12: 算 priceAfter / priceBefore 用于下游 BUY DRY_RUN 模拟
    const baseDecimals = tokenInfo.decimals ?? 6;
    const quoteDecimals = 9;
    const dec = Math.pow(10, baseDecimals - quoteDecimals);
    const priceBefore = (Number(quoteReserveBI) / Number(baseReserveBI)) * dec;
    const priceAfter = (Number(quoteAfter) / Number(baseAfter)) * dec;

    // 标记 dedup 防止 LS 路径再触发
    this._markProcessed(sig);
    this.monitor.inc('SsSwapDetector.dumpSignals', 1, 'SsSwapDetector');

    const latency = Date.now() - t0;
    this.monitor.set('SsSwapDetector.lastLatencyMs', latency, 'SsSwapDetector');

    console.log(
      `[SsSwapDetector] 🚨 SS dump signal: ${tokenInfo.symbol || tokenInfo.mint.slice(0, 6)} ` +
        `sellSol=${solOut.toFixed(2)} impact=${priceImpactPct.toFixed(1)}% ` +
        `pool=${poolQuoteBeforeSol.toFixed(0)}SOL slot=${slot} sig=${sig.slice(0, 12)}.. ` +
        `(parse=${latency}ms)`,
    );

    this.emit('dumpSignal', {
      mint: tokenInfo.mint,
      symbol: tokenInfo.symbol,
      sellSol: solOut,
      priceImpactPct,
      poolQuoteAfter: poolQuoteAfterSol,
      seller: null, // SS 路径拿不到 signer (没有 meta)
      signature: sig,
      ts: Date.now(),
      slot,
      poolAddress,
      poolBaseVault: tokenInfo.pool_base_vault,
      poolQuoteVault: tokenInfo.pool_quote_vault,
      priceAfter,
      priceBefore,
      baseDecimals,
      quoteDecimals,
      dumpTxRaw: rawTx, // ← 关键: bundle 用这个
      source: 'SS', // 标记来源, 下游可区分
    });
  }

  /**
   * 从 PoolStateCache 拿到的 poolState 里提取 base/quote reserves。
   *
   * PoolStateCache 来自 SDK swapSolanaState(), 结构可能是:
   *   { poolBaseAmount, poolQuoteAmount } (BN)
   *   { poolBaseTokenReserves, poolQuoteTokenReserves } (BN)
   *   { baseReserve, quoteReserve } (BN)
   *
   * 这里做防御性 fallback, 优先看常见字段名。
   */
  _extractReserve(poolState, kind) {
    if (!poolState) return null;
    const candidates = kind === 'base'
      ? ['poolBaseAmount', 'poolBaseTokenReserves', 'baseReserve', 'base_reserves', 'baseAmount']
      : ['poolQuoteAmount', 'poolQuoteTokenReserves', 'quoteReserve', 'quote_reserves', 'quoteAmount'];
    for (const k of candidates) {
      const v = poolState[k];
      if (v != null) return v;
    }
    return null;
  }

  stop() {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }
  }
}

module.exports = SsSwapDetector;
