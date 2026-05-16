# v3.17.7 升级说明

> 基于 v3.17.6 实战 10 笔交易后的进一步迭代,修复 3 个 bug + 1 个深层设计问题。
> 从 v3.17.6 升级:`git pull && systemctl restart dump-sniper`,**.env 加 4 个新参数**(不加也能跑,用默认值)。

---

## 改了什么(4 个改动)

### 1. Bug:LaserStream 推送延迟导致信号过期(买在山顶)

**症状**(openclaw 实战):POSITIONS 代币某次砸盘信号 LaserStream 延迟 **52.8 秒** 才到(127 slot),买入时反弹早结束,立刻 emergency_stop 出场。10 笔中 3 笔是这种"慢信号"。

**根因**:LaserStream 多 region 订阅对大部分代币延迟 < 2 秒,但**某些代币尾延迟可达 48-88 秒**(network/region 不可控因素)。这是 LaserStream 本身的特性,不是代码 bug。

**修复**:`SignalEngine` 加 **slot 过期检查**
- TickStream 维护 `_latestSlot`(任何 region 推过来的 tx 都更新)
- DumpDetector 把 `txMessage.slot` 一路传到 SignalEngine
- SignalEngine 在 `handleDumpSignal` 入口检查 `latestSlot - signal.slot > MAX_SIGNAL_SLOT_GAP`(默认 20 slot ≈ 8s)
- 超过就拒绝信号,不触发买入

**配置**:`MAX_SIGNAL_SLOT_GAP=20`(0 = 禁用)

**对 9 笔回测数据的预测**:
- 4 笔快单(slot gap 0-1) → 仍然通过 ✅
- 3 笔慢单(slot gap 121-214,延迟 48-88s) → 全部拒绝 ✅,避免亏损

### 2. Bug:同一卖家持续出货被反复触发

**症状**(openclaw 实战):同一卖家 `ikG8tz5e` 18 秒内对 POSITIONS 砸了 2 次:
- 14:37:09 sellSol=17.61 impact=-12.16% → BUY #2
- 14:39:10 sellSol=17.61 impact=-12.16% → 同一卖家 BUY #3,价格已跌 20%,直接亏

**根因**:`SELLER_TX_DEDUP_MS`(v3.17.6 新增)是按 **seller_tx 签名**去重,**但同一卖家不同砸单 tx 不会被拦截**。这种"持续出货"场景下,买入反弹概率小。

**修复**:`SignalEngine` 加 **(seller wallet × mint) pair 去重**
- `triggeredSellerMintPairs: Map<"seller:mint", expireAt>`
- 触发买入时记录此 pair,后续 N 分钟内同一卖家对同一 mint 的所有信号都拒绝
- **注意:跟 seller_tx 去重是两道独立防线**:
  - seller_tx 防 LaserStream 重推(同一 tx 不同推送)
  - seller_mint 防同卖家不同 tx(真的反复砸盘)

**配置**:`SELLER_MINT_DEDUP_MS=600000`(10 分钟,0 = 禁用)

### 3. Bug:stabilization 期 emergency_stop 误杀(改进 v3.17.6 的 stabilization 设计)

**症状**(openclaw 实战的第2笔 POSITIONS):
- BUY 提交 estimated entryPrice = 8.198e-6(3 SOL 估算花费)
- BUY reconcile 真实 entryPrice = 7.119e-6(实际 2.58 SOL,估算高 14%)
- reconcile 完成后第一个 tick 价格 ≈ 6.4e-6 → 相对真实 entryPrice 跌 10%
- 但代码里 emergency_stop 仍用 `相对 entryPrice 的 PnL ≤ -15%` 判断
- **整体回归过程触发了一次 -15% 假信号 → emergency 误杀**

**根因深层分析**:
- 估算 entryPrice 比实际高 14%,意味着我们 3 SOL 进 30 SOL 池子推高了 ~10%
- reconcile 后池子价格自然回归到砸盘后真实水平
- "相对 entryPrice 的 PnL" 在这种情形下不可靠,会显示假亏损

**openclaw 的修复(我不采纳)**:stabilization 期 emergency 阈值从 -15% 放宽到 -30%
- 问题:拍脑袋的数字,**真跌 -25% 也会被放过 5 秒**

**我的修复(根治)**:stabilization 期改用 **"相对样本最高价的回撤"** 判断 emergency
- `sampleMax = max(_stabilizeSamples)` ≈ 自买入推高的池子价格峰值
- `drawdown = (sampleMax - currentPrice) / sampleMax`
- 从峰值真的跌 `STABILIZATION_EMERGENCY_DRAWDOWN_PCT`(默认 20%)才触发
- 这样:
  - "AMM 自买入推高 + 回归"(回撤 ≤ 10-12%) → 放过 ✅
  - 真灾难性下跌(回撤 ≥ 20%) → 触发 ✅

**5 个测试场景全过**(含 openclaw 那笔实战的精确数据)。

**配置**:`STABILIZATION_EMERGENCY_DRAWDOWN_PCT=20.0`

### 4. 新工具:`npm run analyze` 详细分析脚本

为了帮助分析实战数据,加了一个新命令:

```bash
cd /opt/dump-sniper
npm run analyze        # 过去 24 小时
npm run analyze 168    # 过去 7 天
```

输出 6 个 section:
1. **Positions 全表**(按时间倒序,所有字段一行一笔)
2. **Exit reason 分布 + PnL 统计**(每个 reason 的 N/平均 PnL%/总 PnL SOL/min/max)
3. **Signals 分布**(接受 vs 各种拒绝原因细分)
4. **每笔 position 的详细时间线**(BUY → 关联 signals → SELL,所有字段都打印)
5. **同卖家重复砸盘检测**(看看 sellerMint 去重的命中率)
6. **CSV 导出**(`reports/analyze_<timestamp>.csv`,Excel 打开看更方便)

---

## 必读 .env 调整

```bash
# v3.17.7 新增(全用默认值也行)
MAX_SIGNAL_SLOT_GAP=20
SELLER_MINT_DEDUP_MS=600000
STABILIZATION_EMERGENCY_DRAWDOWN_PCT=20.0

# 注意:这一版没改其他参数,v3.17.6 的所有 env 仍然有效
```

---

## 验证步骤

启动后看日志,正常应该看到:

```
[TickStream] initialized with 3 region(s): FRA, EWR, TYO
[TickStream:FRA] connected, watching N mints
[SignalEngine] restored N triggered seller_tx from DB ...
```

砸盘信号到来时:

```
[SignalEngine] ✅ BUY_SIGNAL XXX: sell=17.6 SOL, impact=-12.2%, seller=ikG8tz.., seller_tx=2AMS45G4.., slot_gap=2
```

注意末尾的 `slot_gap=X` — 这是 v3.17.7 新增的日志字段,告诉你这笔砸盘信号迟到了多少 slot。

如果某笔信号被拒绝(慢信号):

```
[SignalEngine] ⏭ rejected XXX: slot gap too large: dump@419363545, now@419363716, gap=171 (>20, ~68s late)
```

如果同卖家反复砸盘:

```
[SignalEngine] ⏭ rejected XXX: same seller+mint cooldown (seller ikG8tz.. dumped POSITIONS again, expires in 480s)
```

---

## 跑完后看数据

```bash
# 直接看
npm run analyze 24

# 导出 CSV
ls reports/analyze_*.csv

# 拉到本地分析(在你本地机器)
scp ubuntu@<your-server>:/opt/dump-sniper/reports/analyze_*.csv ~/
```

需要重点看的指标:

| 指标 | 健康范围 | 异常意味着 |
|---|---|---|
| `rejectedSlotGapTooLarge` 占比 | 5-15% | < 5% 说明 LaserStream 都很快,不需要这个过滤;> 30% 说明你的 region 选错了 |
| `rejectedSellerMintPair` 数 | 0-小 | > 0 说明同卖家反复砸盘场景真实存在 |
| `EMERGENCY_STOP` 占比 | < 20% | 高了说明延迟还有问题或者池子在持续下跌 |
| `TRAILING_STOP` 占比 | 40-60% | 低了说明 trailing 太严或者反弹质量低 |
| `TAKE_PROFIT` 占比 | < 15% | +50% 罕见,但单笔利润最大 |
| `TIMEOUT` 占比 | < 30% | 高了说明 30 分钟内多数仓位没方向 |

---

## 关键差异:v3.17.7 vs openclaw 的修复

| Bug | openclaw 的修复 | 我的修复 | 谁更好 |
|---|---|---|---|
| 信号慢导致买在山顶 | slot gap 检查(同方向) | slot gap 检查 + 日志带 slot_gap | 同等(他先发现) |
| 同卖家持续砸盘 | seller+mint N 分钟去重(同方向) | seller+mint 去重 + 跟 seller_tx 去重并存 | 同等(我加了一层独立性) |
| stabilization 期误杀 | -15% → -30% 固定阈值放宽 | 改用相对样本峰值回撤(根治) | **我更好** |
| 数据分析 | (没做) | `npm run analyze` 6 段详细输出 + CSV | 我做了 |
