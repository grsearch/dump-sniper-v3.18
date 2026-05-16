'use strict';

/**
 * DumpDetector (v3)
 * =================
 * 接收 LaserStream 推送的交易，解析其是否为：
 *   - 涉及监控代币的 swap
 *   - 方向为 SELL（base → SOL）
 *   - 卖出 SOL >= 阈值
 *   - 单笔自身造成 priceImpact <= -10%
 *
 * v3 vs v2：
 * 新增 CPI 路由检测（Jupiter / OKX / Flash / Trojan 等 bot 通过 CPI 调 Pump AMM）。
 * 这类交易 pool_base_vault 在 accountKeys 中，但 pool_quote_vault 不在
 * （Jupiter 用中间 WSOL wrapping 账户路由）。
 * v3 回退逻辑：仅凭 base_vault 余额变化 + SOL native balance 推算价格。
 *
 * 解析路径：
 *   1. 完整路径：pool_base_vault + pool_quote_vault 都在 accountKeys
 *      → 直接读两个 vault 余额变化，精确算价格和方向
 *   2. CPI 回退路径：pool_base_vault 在但 pool_quote_vault 不在
 *      → 读 base_vault 余额变化 + SOL native balance 推算
 *      → 标记 source='cpi' 供下游判断
 *   3. 完全缺失：两个 vault 都不在 → 跳过（可能走别的 DEX）
 *
 * priceTick：仅当 pool 已知时才 emit（保证 PriceTracker 拿到的价格质量）
 */

const EventEmitter = require('events');
const bs58Lib = require('bs58');
const bs58 = bs58Lib.default || bs58Lib;
const { config } = require('../config');
const { getMonitor } = require('../monitor/HealthMonitor');

const monitor = getMonitor();
monitor.registerModule('DumpDetector', { staleMs: 120_000, label: 'Dump Detector' });

const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const PUMP_AMM_PROGRAM_ID = config.programs.pumpAmm;

function encodeBase58(value) {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return bs58.encode(value);
  if (value instanceof Uint8Array) return bs58.encode(Buffer.from(value));
  return null;
}

class DumpDetector extends EventEmitter {
  constructor(tokenRegistry) {
    super();
    this.tokenRegistry = tokenRegistry;
    this.poolStateCache = null;
  }

  setPoolStateCache(cache) {
    this.poolStateCache = cache;
  }

  handleTransaction(txMessage) {
    monitor.inc('DumpDetector.txParsed', 1, 'DumpDetector');
    monitor.beat('DumpDetector', 'parse');
    try {
      const parsed = this._parseTx(txMessage);
      if (!parsed) {
        monitor.inc('DumpDetector.parsedNull', 1, 'DumpDetector');
        return;
      }

      // emit priceTick (DumpDetector 只 emit "可信"价格——pool 已知的)
      monitor.inc('DumpDetector.priceTicks', 1, 'DumpDetector');
      this.emit('priceTick', {
        mint: parsed.baseMint,
        price: parsed.priceAfter,
        ts: parsed.ts,
        poolAddress: parsed.poolAddress,
      });

      // 仅卖单进入下游判定
      if (parsed.side !== 'SELL') return;

      const sellSol = parsed.quoteAmount; // 用户得到的 quote (SOL)
      const priceImpactPct = -parsed.priceChangePct; // 转为正数表示跌幅
      const poolQuoteAfter = parsed.poolQuoteAfter; // 池子 SOL 余额

      // v3.10: 三条过滤
      // 1. sellSol 下限（决心卖单）
      // 2. priceImpact 在区间 [min, max]：太小没反弹空间；太大说明池子已经空了/流动性危险
      // 3. 池子流动性下限：太小的池子进出滑点大，容易亏在 spread 上
      const passSize = sellSol >= config.strategy.minSellSol;
      const passImpact = priceImpactPct >= config.strategy.minPriceImpactPct
                      && priceImpactPct <= config.strategy.maxPriceImpactPct;
      const passLiquidity = poolQuoteAfter >= config.strategy.minPoolQuoteSol;
      const passAll = passSize && passImpact && passLiquidity;

      this.emit('sellAnalyzed', {
        mint: parsed.baseMint,
        symbol: parsed.symbol,
        sellSol,
        priceImpactPct,
        poolQuoteAfter,
        passSize,
        passImpact,
        passLiquidity,
        seller: parsed.signer,
        signature: parsed.signature,
        ts: parsed.ts,
        poolAddress: parsed.poolAddress,
        priceAfter: parsed.priceAfter,
        priceBefore: parsed.priceBefore,
      });

      if (passAll) {
        monitor.inc('DumpDetector.dumpSignals', 1, 'DumpDetector');
        // v3.17.12: 打印砸盘信号的来源（SS vs LS）
        const firstRegionInfo = this._tickStream?._sigFirstRegion?.get(parsed.signature);
        const regionLabel = firstRegionInfo ? firstRegionInfo.region : 'unknown';
        const sigMapSize = this._tickStream?._sigFirstRegion?.size || 0;
        // Debug: check nearby sigs in the map
        let debugInfo = '';
        if (!firstRegionInfo && this._tickStream?._sigFirstRegion) {
          // Try to find the sig with a prefix match (debug)
          const targetPrefix = parsed.signature?.slice(0, 8);
          let found = false;
          for (const [k, v] of this._tickStream._sigFirstRegion) {
            if (k.startsWith(targetPrefix)) {
              debugInfo = ` PREFIX_MATCH key=${k.slice(0,12)} region=${v.region}`;
              found = true;
              break;
            }
          }
          if (!found) debugInfo = ' NO_PREFIX_MATCH';
        }
        console.log(
          `[DumpDetector] 🚨 dump signal: ${parsed.symbol || parsed.baseMint?.slice(0, 6)} ` +
          `sellSol=${sellSol.toFixed(2)} impact=${priceImpactPct.toFixed(1)}% ` +
          `source=${regionLabel} slot=${parsed.slot} sig=${parsed.signature?.slice(0,12)}.. sigMapSize=${sigMapSize}${debugInfo}`,
        );
        this.emit('dumpSignal', {
          mint: parsed.baseMint,
          symbol: parsed.symbol,
          sellSol,
          priceImpactPct,
          poolQuoteAfter,
          seller: parsed.signer,
          signature: parsed.signature,
          ts: parsed.ts,
          slot: parsed.slot, // v3.17.7: 砸盘交易的链上 slot
          poolAddress: parsed.poolAddress,
          poolBaseVault: parsed.poolBaseVault,
          poolQuoteVault: parsed.poolQuoteVault,
          priceAfter: parsed.priceAfter,
          priceBefore: parsed.priceBefore,
          baseDecimals: parsed.baseDecimals,
          quoteDecimals: parsed.quoteDecimals,
        });
      }
    } catch (err) {
      monitor.inc('DumpDetector.parseErrors', 1, 'DumpDetector');
      monitor.recordError('DumpDetector', err, {
        signature: this._extractSignature(txMessage?.transaction),
      });
      console.error(`[DumpDetector] parse error: ${err.message}`);
    }
  }

  /**
   * 解析交易，返回 { side, baseMint, quoteAmount, priceChangePct, ... } 或 null。
   *
   * 算法：
   *   1. 在 pre/postTokenBalances 里找属于监控代币的 mint
   *   2. 查 tokenRegistry.getToken(mint).pool_base_vault / pool_quote_vault
   *   3. 在 pre/postTokenBalances 的 accountIndex/owner 里精确定位这两个 vault 的变化
   *   4. 计算 baseBefore/baseAfter/quoteBefore/quoteAfter，得到价格和方向
   */
  _parseTx(txMessage) {
    const tx = txMessage.transaction;
    if (!tx) return null;
    const meta = tx.meta;
    if (!meta || meta.err) return null;

    // v3.17.7: 提取 slot 用于下游过期判断
    // yellowstone gRPC 把 slot 编码成 string，我们一路传到 SignalEngine
    const slotRaw = txMessage.slot;
    const slot = slotRaw != null
      ? (typeof slotRaw === 'string' ? Number(slotRaw) : slotRaw)
      : null;

    const signature = this._extractSignature(tx);
    const signer = this._extractSigner(tx);

    const preBalances = meta.preTokenBalances || [];
    const postBalances = meta.postTokenBalances || [];
    if (preBalances.length === 0 || postBalances.length === 0) return null;

    // 找出涉及的监控代币
    let baseMint = null;
    let baseDecimals = 6;
    for (const b of preBalances) {
      if (this.tokenRegistry.isActive(b.mint)) {
        baseMint = b.mint;
        baseDecimals = b.uiTokenAmount?.decimals ?? 6;
        break;
      }
    }
    if (!baseMint) {
      // 也可能在 post 里出现（极少见的 case，比如 base ATA 是这次新建的）
      for (const b of postBalances) {
        if (this.tokenRegistry.isActive(b.mint)) {
          baseMint = b.mint;
          baseDecimals = b.uiTokenAmount?.decimals ?? 6;
          break;
        }
      }
    }
    if (!baseMint) return null;

    const tokenInfo = this.tokenRegistry.getToken(baseMint);
    if (!tokenInfo) {
      monitor.inc('DumpDetector.noTokenInfo', 1, 'DumpDetector');
      return null;
    }

    // 必须有 pool base vault 信息才解析
    const poolBaseVault = tokenInfo.pool_base_vault;
    const poolQuoteVault = tokenInfo.pool_quote_vault;
    if (!poolBaseVault) {
      monitor.inc('DumpDetector.skippedNoPoolInfo', 1, 'DumpDetector');
      return null;
    }

    // accountKeys (静态 + loaded address)
    const staticKeys = tx.transaction?.message?.accountKeys || [];
    const loadedWritable = meta.loadedWritableAddresses || [];
    const loadedReadonly = meta.loadedReadonlyAddresses || [];
    const allKeys = [
      ...staticKeys.map((k) => encodeBase58(k)),
      ...loadedWritable.map((k) => encodeBase58(k)),
      ...loadedReadonly.map((k) => encodeBase58(k)),
    ];

    // 在 accountKeys 中找 vault 对应的 accountIndex
    const baseVaultIdx = allKeys.findIndex((k) => k === poolBaseVault);
    const quoteVaultIdx = poolQuoteVault
      ? allKeys.findIndex((k) => k === poolQuoteVault)
      : -1;

    // 两个 vault 都不在 → 这笔交易不涉及 Pump AMM 池子，跳过
    if (baseVaultIdx < 0 && quoteVaultIdx < 0) {
      monitor.inc('DumpDetector.poolNotInTx', 1, 'DumpDetector');
      return null;
    }

    // ---- 完整路径：base_vault + quote_vault 都在 ----
    if (baseVaultIdx >= 0 && quoteVaultIdx >= 0) {
      return this._parseFullVault(
        tx, meta, preBalances, postBalances,
        baseVaultIdx, quoteVaultIdx, baseMint, baseDecimals,
        tokenInfo, poolBaseVault, poolQuoteVault,
        signature, signer, slot, allKeys,
      );
    }

    // ---- CPI 回退路径：只有 base_vault 在（Jupiter/OKX/Flash 等 bot 路由） ----
    if (baseVaultIdx >= 0) {
      monitor.inc('DumpDetector.cpiFallback', 1, 'DumpDetector');
      return this._parseCpiFallback(
        tx, meta, preBalances, postBalances,
        baseVaultIdx, baseMint, baseDecimals,
        tokenInfo, poolBaseVault, poolQuoteVault,
        signature, signer, slot, allKeys,
      );
    }

    // quote_vault 在但 base_vault 不在 — 不太可能，但安全处理
    monitor.inc('DumpDetector.poolNotInTx', 1, 'DumpDetector');
    return null;
  }

  /**
   * 完整路径解析：base_vault + quote_vault 都在 accountKeys 中。
   * 直接读两个 vault 的 token balance 变化，精确算价格和方向。
   * 这是 v2 的原始逻辑，对 Pump AMM 直调交易。
   */
  _parseFullVault(
    tx, meta, preBalances, postBalances,
    baseVaultIdx, quoteVaultIdx, baseMint, baseDecimals,
    tokenInfo, poolBaseVault, poolQuoteVault,
    signature, signer, slot, allKeys,
  ) {
    const baseBefore = this._findBalance(preBalances, baseVaultIdx, baseMint);
    const baseAfter = this._findBalance(postBalances, baseVaultIdx, baseMint);
    const quoteBefore = this._findBalance(preBalances, quoteVaultIdx, WSOL_MINT);
    const quoteAfter = this._findBalance(postBalances, quoteVaultIdx, WSOL_MINT);

    if (
      baseBefore === null || baseAfter === null ||
      quoteBefore === null || quoteAfter === null
    ) {
      monitor.inc('DumpDetector.vaultBalanceMissing', 1, 'DumpDetector');
      return null;
    }

    const poolBaseDelta = baseAfter - baseBefore;
    const poolQuoteDelta = quoteAfter - quoteBefore;

    if (
      !Number.isFinite(baseBefore) || !Number.isFinite(baseAfter) ||
      !Number.isFinite(quoteBefore) || !Number.isFinite(quoteAfter) ||
      baseBefore <= 0 || baseAfter <= 0 ||
      quoteBefore <= 0 || quoteAfter <= 0
    ) {
      return null;
    }

    const priceBefore = quoteBefore / baseBefore;
    const priceAfter = quoteAfter / baseAfter;
    if (priceBefore <= 0 || priceAfter <= 0) return null;
    const priceChangePct = ((priceAfter - priceBefore) / priceBefore) * 100;

    let side;
    if (poolBaseDelta > 0 && poolQuoteDelta < 0) side = 'SELL';
    else if (poolBaseDelta < 0 && poolQuoteDelta > 0) side = 'BUY';
    else return null;

    const quoteAmount = Math.abs(poolQuoteDelta);

    return {
      signature,
      signer,
      ts: Date.now(),
      slot,
      side,
      baseMint,
      baseDecimals,
      quoteDecimals: 9,
      symbol: tokenInfo.symbol || null,
      quoteAmount,
      priceBefore,
      priceAfter,
      priceChangePct,
      poolAddress: tokenInfo.pool_address,
      poolBaseVault,
      poolQuoteVault,
      poolQuoteAfter: quoteAfter,
      poolBaseAfter: baseAfter,
      source: 'direct',
    };
  }

  /**
   * CPI 回退路径解析：只有 base_vault 在 accountKeys 中。
   * 典型场景：Jupiter / OKX DEX Router / Flash / Trojan 等通过 CPI 调 Pump AMM，
   * 但 Jupiter 用中间 WSOL wrapping 账户路由，导致 pool_quote_vault 不在交易中。
   *
   * 算法：
   *   1. 读 base_vault 余额变化 → 确定 swap 方向和 base 数量
   *   2. 卖出时 base_vault 增加 → 找所有 WSOL token balance 减少（或 SOL native）的账户
   *   3. 用 base_vault 变化推算价格（需要参考 PoolStateCache 的实时价格）
   *
   * 关键限制：无法精确读到 quote_vault 的 SOL 变化，
   * 所以 quoteAmount 用 base_vault 变化 × 参考价格推算，
   * priceChangePct 用 base_vault 前后比例变化近似计算。
   */
  _parseCpiFallback(
    tx, meta, preBalances, postBalances,
    baseVaultIdx, baseMint, baseDecimals,
    tokenInfo, poolBaseVault, poolQuoteVault,
    signature, signer, slot, allKeys,
  ) {
    // 1. 读 base_vault 余额变化
    const baseBefore = this._findBalance(preBalances, baseVaultIdx, baseMint);
    const baseAfter = this._findBalance(postBalances, baseVaultIdx, baseMint);

    if (baseBefore === null || baseAfter === null) {
      monitor.inc('DumpDetector.cpiVaultBalanceMissing', 1, 'DumpDetector');
      return null;
    }

    if (!Number.isFinite(baseBefore) || !Number.isFinite(baseAfter) || baseBefore <= 0 || baseAfter <= 0) {
      return null;
    }

    const poolBaseDelta = baseAfter - baseBefore;

    // 2. 方向判定：base 增加 = 有人往池子卖代币 = SELL
    let side;
    if (poolBaseDelta > 0) side = 'SELL';
    else if (poolBaseDelta < 0) side = 'BUY';
    else return null; // 无变化，跳过

    // 3. 估算 quoteAmount（SOL）
    //    CPI 路由下 quote_vault 不在交易中，但可以估算：
    //    卖出 = 用户得到的 SOL ≈ 池子失去的 SOL
    //    用 AMM 常数乘积近似：
    //      quote_out = quote_before - (quote_before * base_before / base_after)
    //    这等价于: quoteAmount = quote_before * (1 - base_before / base_after)
    //    简化为: quoteAmount ≈ |baseDelta| * price_before
    //
    //    更好的方法：遍历 preTokenBalances 找所有 WSOL 账户的变化之和
    //    但 CPI 中间账户会混淆，所以我们用 base_vault 变化 + AMM 近似

    // 用 AMM 常数乘积近似报价
    // 需要池子的当前 quote/base reserve — 从 PoolStateCache 获取
    const poolState = this.poolStateCache
      ? this.poolStateCache.get(tokenInfo.pool_address)
      : null;

    let quoteAmount = 0;
    let priceBefore = 0;
    let priceAfter = 0;
    let priceChangePct = 0;
    let poolQuoteAfter = 0;

    if (poolState && poolState.poolQuoteAmount && poolState.poolBaseAmount) {
      // 有实时池子状态，用 AMM 常数乘积精确计算
      // BN → number（lamports → SOL, raw base → ui amount）
      const qBefore = poolState.poolQuoteAmount.toNumber
        ? poolState.poolQuoteAmount.toNumber() / 1e9
        : Number(poolState.poolQuoteAmount) / 1e9;
      const bBefore = poolState.poolBaseAmount.toNumber
        ? poolState.poolBaseAmount.toNumber() / Math.pow(10, baseDecimals)
        : Number(poolState.poolBaseAmount) / Math.pow(10, baseDecimals);

      if (qBefore > 0 && bBefore > 0) {
        priceBefore = qBefore / bBefore;
        const qAfter = (qBefore * bBefore) / baseAfter;
        quoteAmount = Math.abs(qBefore - qAfter);
        priceAfter = qAfter / baseAfter;
        priceChangePct = ((priceAfter - priceBefore) / priceBefore) * 100;
        poolQuoteAfter = qAfter;
      } else {
        priceBefore = 1;
        priceAfter = baseBefore / baseAfter;
        priceChangePct = ((priceAfter - priceBefore) / priceBefore) * 100;
        quoteAmount = 0;
        poolQuoteAfter = 0;
      }
    } else {
      // 没有实时池子状态 — 用 base 余额比例变化近似
      // price_after / price_before ≈ base_before / base_after (AMM 常数乘积)
      // 这是近似值，对于大额砸盘可能不准确
      priceBefore = 1; // 归一化
      priceAfter = baseBefore / baseAfter;
      priceChangePct = ((priceAfter - priceBefore) / priceBefore) * 100;
      // quoteAmount 无法精确计算，用 0 标记（下游 minSellSol 过滤会跳过）
      quoteAmount = 0;
      poolQuoteAfter = 0;
      monitor.inc('DumpDetector.cpiNoPoolState', 1, 'DumpDetector');
    }

    // CPI 路径只处理 SELL 且 quoteAmount > 0 的情况
    if (side === 'SELL' && quoteAmount <= 0) return null;

    return {
      signature,
      signer,
      ts: Date.now(),
      slot,
      side,
      baseMint,
      baseDecimals,
      quoteDecimals: 9,
      symbol: tokenInfo.symbol || null,
      quoteAmount,
      priceBefore,
      priceAfter,
      priceChangePct,
      poolAddress: tokenInfo.pool_address,
      poolBaseVault,
      poolQuoteVault: poolQuoteVault || null,
      poolQuoteAfter,
      poolBaseAfter: baseAfter,
      source: 'cpi',
    };
  }

  /**
   * 在 balances 数组里找指定 accountIndex + mint 的余额。
   * 返回 ui 数额（float），找不到返回 null。
   */
  _findBalance(balances, accountIndex, expectedMint) {
    for (const b of balances) {
      if (b.accountIndex !== accountIndex) continue;
      if (expectedMint && b.mint !== expectedMint) continue;
      const ui = b.uiTokenAmount;
      if (!ui) return null;
      // uiAmountString 比 uiAmount 更精确（不丢精度）
      const v = parseFloat(ui.uiAmountString || ui.uiAmount || '0');
      if (!Number.isFinite(v)) return null;
      return v;
    }
    return null;
  }

  _extractSignature(tx) {
    try {
      const sig = tx?.transaction?.signatures?.[0];
      return encodeBase58(sig);
    } catch (_) {
      return null;
    }
  }

  _extractSigner(tx) {
    try {
      const accountKeys = tx?.transaction?.message?.accountKeys || [];
      return encodeBase58(accountKeys[0]);
    } catch (_) {
      return null;
    }
  }
}

module.exports = DumpDetector;
module.exports.PUMP_AMM_PROGRAM_ID = PUMP_AMM_PROGRAM_ID;
// TEMP DEBUG - will remove
