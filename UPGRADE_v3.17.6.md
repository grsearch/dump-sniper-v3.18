# v3.17.6 升级说明

> 本版本基于 v3.17 实战 24 小时数据驱动迭代,修复了 5 个 bug + 1 个策略优化 + 1 个 SDK 兼容修复。
> 新服务器全新部署:直接按 `DEPLOY.md` 操作即可。
> 从 v3.17 升级:`git pull && systemctl restart dump-sniper`,**但要按下方"必读 .env 调整"改 env**。

---

## 改了什么(7 个改动)

### 0. 关键 Bug:SDK 兼容性 — LaserStream 启动后收不到任何 tx ("NEVER_BEAT")

**症状**:服务启动正常,日志显示 `TickStream initialized` 和 `connected`,但 60s+ 后告警:
```
[WARN] tickstream.no_traffic LaserStream 监控 N 个代币,但 60s+ 无 tx 收到 ...
```
进而所有依赖 TickStream 的模块(DumpDetector/PriceTracker/SignalEngine)都没数据。

**根因**:`@triton-one/yellowstone-grpc` v1.4+(尤其 v5.x napi-rs 路径)要求 `stream.write()` 收到 **protobuf message 实例**,不是 plain JS object。
- TCP 连接 OK、subscribe 调用不报错、stream.write 不报错
- **但 server 端拒绝序列化** → 永远收不到 data → 静默失败
- 这是该 SDK 已知的 breaking change,但 README 没说清楚

**修复**:`TickStream._sendSubscribeRequest` 用 defensive 导入:
```js
const SubscribeRequest = yellowstoneGrpc.SubscribeRequest || null;
// ...
const request = SubscribeRequest
  ? SubscribeRequest.create(requestPlain)  // 新版 SDK
  : requestPlain;                            // 老版 fallback
```

向后兼容老版 SDK(导出不带 .create 时直接 plain object),适配新版(用 .create 包成 protobuf message)。

---

### 1. Bug:reconcile 完成后 highWaterMark 没重置 → trailing 误杀

**症状**:买入后 2 秒就被 trailing 卖,亏 0.05 SOL。

**根因**:
- OPEN 时 `highWaterMark = entryPrice = 估算值`(高估 5-15%)
- Reconcile 修正 entryPrice 到真实值后,**HWM 还停在估算高位**
- 后续真实价格被误判"从 peak 大幅回撤" → trailing 触发

**修复**:`PositionManager._reconcileBuyAsync` 在写入真实 entryPrice 后,同步重置:
```js
pos.highWaterMark = pos.entryPrice;   // 真实值
pos.trailingArmed = false;
pos._tpConfirmCount = 0;
```

### 2. Bug:reconcile 完成那一刻被瞬态高价污染

**症状**:reconcile 重置了 HWM,**但下一个 priceTick 立刻把 HWM 推到瞬态高位**,trailing armed → 真实价格回归被误判"回撤" → 误杀。

**根因**:reconcile 完成 ↔ 下一个 priceTick 之间只有几十 ms,但这段时间内:
- 砸盘后价格剧烈波动
- **我们自买入 3 SOL 进 30 SOL 池子,AMM 自动推高池子价格 ~10%**
- PoolStateCache 每 500ms 轮询读到的就是这个虚高值

**修复**(关键创新):引入 **stabilization 期** + **中位数 baseline**
- reconcile 完成后进入 `stabilizing` 状态,默认 5 秒
- 期间收集所有 priceTick 进 `_stabilizeSamples` 数组
- **不更新 HWM,不武装 trailing,不检查 TP**
- emergency_stop(-15%)仍然工作(救命路径不能屏蔽)
- 5 秒结束时:`baseline = median(samples)`,`HWM = max(baseline, entryPrice)`
- 之后 trailing 才开始正常工作

这比 openclaw 的"10秒冷却期"更稳健 — 它**对池子价格本身做了过滤**,而不是单纯等时间过去。即使 5 秒内有 5% 的瞬态尖刺,中位数会自动忽略它。

### 3. Bug:同砸单跨 LaserStream region 重复触发

**症状**:同一笔砸单(seller_tx)2 分钟后被慢 region 重新推送,触发第二次 BUY,但价格已跌 20% → 亏 0.15 SOL。

**根因**:
- TickStream 多 region dedup 用 5 分钟 TTL
- 跨 region 推送延迟可达 1.5 秒,但极端情况(网络抖动)甚至能跨越 dedup TTL
- SignalEngine 只有按 mint 的 60 秒冷却 → 失效

**修复**:`SignalEngine` 新增 `triggeredSellerTxs` Map(seller_tx → expireAt)
- **持久化**:写入 `signals` 表(已有 seller_tx 字段),启动时从 DB 恢复最近 10 分钟
- **重启不丢**:这是关键差别 — 我估计 openclaw 用的是纯内存方案,重启会丢
- 默认 dedup 窗口 10 分钟(`SELLER_TX_DEDUP_MS=600000`),覆盖最慢 region + 重启窗口

### 4. Bug:SELL 用 SDK 估算而非链上真实值 → PnL 显示亏损但实际盈利

**症状**:实际链上收到 2.91 SOL 但 DB 记录 2.80 SOL,差 3.7% → 显示 -0.012 亏损但实际 +0.091 SOL 盈利。

**根因**:`_confirmSellAsync` 用的是 `_attemptSell` 里 SDK 报价的 `expectedSolOut`,SDK 估算偏低(不含 priority fee 扣减、池子状态略滞后)。

**修复**:`_confirmSellAsync` 落链确认后,调 `executor.fetchTxSwapResult(sig, mint)` 拉链上真实 `realSolDelta`,覆盖 SDK 估算。fetch 失败时 fallback 到 SDK 估算(向后兼容)。

这跟 BUY 已经有的 reconcile 是同一套机制,**现在 BUY 和 SELL 都有链上 reconcile,PnL 完全准确**。

### 5. 策略优化:trailing 参数 + stabilization 替代单纯调参

**问题**:5%/2% 参数太敏感(自买入虚高就 5-10%),但单纯调到 15%/5% 过于保守(错过大部分中等反弹)。

**修复**:用 **stabilization 期(根治)+ 适度调参(双保险)**
- `TRAILING_ACTIVATE_PCT`: 5 → **8**(double 保护:stabilization 已经过滤瞬态,8% 再加一道)
- `TRAILING_DRAWDOWN_PCT`: 2 → **3**(允许小波动,不被微小回撤洗出)
- `TRAILING_MIN_HWM_AGE_MS`: 100 → **2000**(HWM 至少稳定 2 秒)
- 新增 `STABILIZATION_MS=5000`(stabilization 期 5 秒)

**vs openclaw 的 15/5/2000/30s**:他过于保守。我的 8/3/2000/5s + stabilization 既能锁中等反弹,又通过过滤层防误杀。
**逻辑测试 7 个场景全过**(含砸盘瞬态过滤、真实反弹捕捉、emergency 救命、中位数 baseline)。

### 6. 优化:COMPUTE_UNIT_LIMIT 200K → 170K

**背景**:实战日志显示我们 BUY CU 消耗 145-163K,但**竞争者只用 112-115K**,μL/CU(fee/CU)被大 CU 拉低,同 slot 排名靠后。

**修复**:`COMPUTE_UNIT_LIMIT=170000`(146K + 17% 余量)
- 给 HERMES 类带 fee_program CPI 的 swap 留余量
- 监控:`PositionManager.cuNearLimit` 计数器,**如果 24h 内 > 0,立刻调回 200K**

⚠️ 这是经过权衡的取舍。如果你的代币列表里大量含 HERMES/复杂 fee_program token,可能要保守用 200K。**先观察 24h `cuNearLimit` 指标再决定**。

---

## 必读 .env 调整(从 v3.17 升级)

```bash
# 新参数(必须设置)
STABILIZATION_MS=5000
SELLER_TX_DEDUP_MS=600000

# trailing 调参
TRAILING_ACTIVATE_PCT=8.0     # 旧 5.0
TRAILING_DRAWDOWN_PCT=3.0     # 旧 2.0
TRAILING_MIN_HWM_AGE_MS=2000  # 旧 100

# CU 降低(谨慎)
COMPUTE_UNIT_LIMIT=170000     # 旧 200000
```

全部使用 default 也行 — 这些都是 v3.17.6 的默认值,**不在 .env 里写也会生效**。

---

## DB schema 不变

不需要 migration。`signals` 表的 `seller_tx` 字段早就有了,v3.17.6 只是把它读出来恢复 dedup 缓存。

---

## 验证步骤(部署后)

启动后看日志,正常应该有:

```
[SignalEngine] restored N triggered seller_tx from DB (within last 10min, dedup window)
[TickStream] initialized with 3 region(s): FRA, EWR, TYO
[Executor] Helius Sender multi-region enabled: 3 endpoints
```

策略触发时:
```
[PositionManager] 📈 OPEN ...
[PositionManager] 🔧 BUY reconciled XXX: entrySol 3.0→2.87 (-4.3%)
[PositionManager] ✅ stabilization done XXX: samples=8, baseline=1.05e-6 (4.20%), HWM set to 1.05e-6
```

如果触发了 trailing:
```
[PositionManager] 🎯 TRAILING_ARMED XXX peakPnl=10.5%, ...
[PositionManager] 📉 TRAILING_STOP XXX peakPnl=15.20% → currentPnl=11.50%
```

如果触发了 SELL reconcile:
```
[PositionManager] 🔧 SELL reconciled XXX: SDK est 2.80 → real 2.91 SOL (3.93%)
```

---

## 调参参考表

跑 24-48 小时后,看 `exit_reason` 分布,按下表调:

```sql
SELECT exit_reason, COUNT(*), AVG(pnl_pct), SUM(pnl_sol)
FROM positions WHERE closed_at IS NOT NULL
  AND opened_at > strftime('%s','now','-48 hours')*1000
GROUP BY exit_reason;
```

| 数据 | 调整方向 |
|---|---|
| TRAILING_STOP 占比 > 40% 且 avg_pnl > +5% | 完美,不动 |
| TRAILING_STOP 占比 < 10% | 过严,trailing 8 → 6,drawdown 3 → 2.5 |
| TRAILING_STOP 占比 > 60% 且 avg_pnl < +3% | 太敏感,trailing 8 → 10,drawdown 3 → 4 |
| EMERGENCY_STOP 占比 > 30% | 延迟没追上对手 / 触发标准太宽 |
| TIMEOUT 占比 > 50% | 砸盘后多数没反弹 → MIN_PRICE_IMPACT_PCT 调严 |
| `cuNearLimit` 计数 > 0 | 立刻调 COMPUTE_UNIT_LIMIT 回 200000 |
| `sellerTxsTracked` 持续高于 50 | sellerTxDedupMs 太长,考虑改 5 分钟 |
