# v3.17 升级说明

本次改造分两部分:
1. **策略改造**(立即影响交易行为)
2. **延迟优化**(改善同 slot 命中率)

升级前**先备份 DB**:`cp data/sniper.db ~/sniper.db.bak.v316`

---

## 一、策略改造（PositionManager + config）

### 退出策略对比

| 项 | 旧 v3.16 | 新 v3.17 |
|---|---|---|
| 主止盈 TAKE_PROFIT_PCT | +8% (双确认) | **+50%** (双确认) |
| 移动止盈 trailing | ❌ 无 | ✅ peak>+5% armed,回撤2%卖 |
| 紧急止损 EMERGENCY_STOP_LOSS_PCT | -15% | **保持 -15%** |
| 最大持仓 MAX_HOLD_MS | 15 秒 | **30 分钟 (1800000ms)** |
| 最大并发 MAX_CONCURRENT_POSITIONS | 3 | **5** |

### 退出路径优先级（_checkExit 内部顺序）

```
每个 priceTick → _checkExit:
  ├─ [Step 1] PnL ≤ -15%?     → EMERGENCY_STOP    (不双确认,救命)
  ├─ [Step 2] 更新 highWaterMark
  ├─ [Step 3] PnL ≥ +50%?     → TAKE_PROFIT       (双确认: 2 ticks + 300ms gap)
  └─ [Step 4] 移动止盈:
              peak ≥ +5%       → trailingArmed=true (一次性)
              已 armed 且回撤 ≥ 2% 且 hwmAge ≥ 100ms → TRAILING_STOP

每 100ms tick:
  └─ age ≥ 30min?              → TIMEOUT
```

### 设计要点

- **TAKE_PROFIT 保留双确认**:+50% 价格冲到对单 tick 价格污染敏感,2 次确认间隔 300ms 才卖
- **TRAILING_STOP 不双确认**:highWaterMark 本身就是"持仓期最高"的过滤,加上 hwmAge ≥ 100ms 防单 tick 污染创虚假高点
- **trailingArmed 一次性激活**:peak 涨过 +5% 后即使后续回落到 entryPrice 之下,trailing 保持 armed(锁住可能的"二次冲高")
- **EMERGENCY_STOP 与 trailing 互不干扰**:emergency 在 Step 1 优先判断,跌 -15% 直接救命

### Dashboard 新增字段

`positions` 表新增的字段(只在内存,**未持久化** — 重启会从 entryPrice 重新追踪):
- `highWaterMark`:持仓期最高价
- `highWaterMarkTs`:highWaterMark 的更新时间
- `trailingArmed`:是否已激活移动止盈

如要在 dashboard 显示这些,需要在 WebSocket 推送 payload 里加上(server.js 里有发 position list 的代码,可以一并加 — 见下方 "可选增强")。

---

## 二、Dashboard PnL Bug 修复

### Bug 现象
SWATCH 那笔 SELL 实际盈利 +0.178 SOL (+9.74%),但 dashboard 显示亏损。

### 根因
`PositionManager._reconcileRetriesInner` 在第 869-874 行,reconciler 发现链上已经落链的 SELL tx 时,**用 `pos.entryPrice` 作为 exitPrice 占位** + `solOut=null`。

下游 `_finalizeSuccess` 第 594 行:
```js
const exitSol = solOut ?? pos.tokenAmount * exitPrice;
```
当 `solOut=null` 时退化为 `tokenAmount * entryPrice = entrySol`,grossPnl=0,净 PnL = -feeSol → 显示成亏损。

### 修复
在 reconciler 路径,改成调 `executor.fetchTxSwapResult(sig, mint)` 从链上拉真实 SOL 增量,得到 `solOut`,再算出真实 `exitPrice = solOut / tokenAmount`。这跟 BUY 的 `_reconcileBuyAsync` 用一样的工具,**链上事实是唯一真相**。

### 影响范围
只影响 **走 reconciler 路径完成的 SELL**(`status=sell_confirming` 且 `last_retry_at > 30s` 时主动 confirmTx)。

正常路径(`_confirmSellAsync`)本来就用了正确的 solOut,**没有 bug**。

---

## 三、延迟优化（4 个独立改动）

### 1. LaserStream 多 region 订阅

**改动**:`src/core/TickStream.js` 重写为多 region 架构。

**为什么**:实测 LaserStream 推送 116ms~1528ms (13x 差异),尾延迟主因是"砸单 leader 离你的 region 远"。多 region 订阅,任一 region 先收到就触发(signature 去重防重复)。

**配置**(env):
```bash
# 推荐:欧+美+亚三region
HELIUS_LASERSTREAM_ENDPOINTS=https://laserstream-mainnet-fra.helius-rpc.com,https://laserstream-mainnet-ewr.helius-rpc.com,https://laserstream-mainnet-tyo.helius-rpc.com
HELIUS_LASERSTREAM_TOKEN=<unchanged>
```

如未设 `_ENDPOINTS`,会 fallback 到旧的 `HELIUS_LASERSTREAM_ENDPOINT`(向后兼容)。

**新增 metrics**(`/api/health` 可见):
- `TickStream.{FRA,EWR,TYO}.txReceived`:每 region 收到的 tx 总数
- `TickStream.{FRA,EWR,TYO}.dedup_first`:每 region 抢到第一(去重后实际触发的 tx)
- `TickStream.{FRA,EWR,TYO}.dedup_dup`:每 region 收到时已被别的 region 触发过
- `TickStream.dedupSize`:dedup map 当前大小(应稳定在 < 2000)

**判断 region 价值**:看 `dedup_first` 占总收到的比例。如果某个 region 几乎一直是 dup,说明它对你没贡献,可以撤掉省 credit。

**成本**:每个 region 独立订阅,流量 credits 大致 ×N 倍。如果在 Helius Professional plan 内有富余,接近零增量;不富余的话留意 dashboard 用量。

### 2. Helius Sender 多 region 并发

**改动**:`src/core/Executor.js` `_submitTx` 改成 `Promise.race` 并发到多个 region。

**为什么**:BUY tx 从单一 region Sender 发出,如果砸单 leader 在远 region,跨洋 200-300ms 错过同 slot。并发发到多个 region,谁的 sender 最快把 tx 送到 leader 谁赢。Solana 节点基于 signature 去重,不会重复落链。

**配置**(env):
```bash
HELIUS_SENDER_ENDPOINTS=http://fra-sender.helius-rpc.com/fast,http://ewr-sender.helius-rpc.com/fast,http://tyo-sender.helius-rpc.com/fast
```

向后兼容:未设 `_ENDPOINTS` 时用 `HELIUS_SENDER_ENDPOINT`。

**新增 metrics**:
- `Executor.senderRaceWon`:任一 region 赢得 race 的次数
- `Executor.senderRaceWonBy_{FRA,EWR,TYO}`:每 region 赢得次数(分布告诉你哪个 region 最有用)
- `Executor.lastSenderRaceMs`:最近一次 race 总耗时

### 3. Tip 提升

**改动**:`.env.example` 默认 `JITO_TIP_LAMPORTS` 从 1_000_000 (0.001) 提升参考值到 10_000_000 (0.01)。

**代码不需要改** — 你直接改 env 即可:
```bash
JITO_TIP_LAMPORTS=10000000  # 0.01 SOL
```

⚠️ **tip 是真金白银**:position 0.1 SOL 时,tip 0.01 = 10% 仓位成本。
**必须配合 POSITION_SIZE 放大才划算**:推荐 position ≥ 0.5 SOL 再用 0.01 tip。

### 4. Priority Fee Oracle 反应速度

**改动**:`src/utils/priorityFeeOracle.js` 后台刷新默认 1500ms → 500ms。

**为什么**:砸盘瞬间整网 fee 飙升,1.5s 刷新跟不上,动态 fee 会用过期值。
500ms 后台轮询不影响 BUY 路径延迟(estimate 是同步从内存读),只多消耗一点 credit。

**配置**:
```bash
PRIORITY_FEE_REFRESH_MS=500  # 已是默认值
```

---

## 升级步骤

```bash
# 1. 停老版本
sudo systemctl stop dump-sniper

# 2. 备份 DB
cp /opt/dump-sniper/data/sniper.db ~/sniper.db.bak.v316.$(date +%s)

# 3. 部署新代码（保留 .env 和 data/）
sudo bash deploy/install.sh /opt/dump-sniper

# 4. 改 .env(关键!)
sudo -u ubuntu vim /opt/dump-sniper/.env
# 检查/修改以下变量:
#   TAKE_PROFIT_PCT=50.0
#   TRAILING_ACTIVATE_PCT=5.0
#   TRAILING_DRAWDOWN_PCT=2.0
#   TRAILING_MIN_HWM_AGE_MS=100
#   MAX_HOLD_MS=1800000
#   MAX_CONCURRENT_POSITIONS=5
#   JITO_TIP_LAMPORTS=10000000        # 视 position 大小决定
#   HELIUS_LASERSTREAM_ENDPOINTS=...   # 多 region(可选,有 fallback)
#   HELIUS_SENDER_ENDPOINTS=...        # 多 region(可选,有 fallback)
#   PRIORITY_FEE_REFRESH_MS=500

# 5. DRY_RUN 模式先观察 24h
echo "DRY_RUN=true" >> /opt/dump-sniper/.env
sudo systemctl start dump-sniper
# 看日志:同 slot 命中率、trailing 触发率、dedup 第一名 region 分布
sudo journalctl -u dump-sniper -f | grep -E "TRAILING|TAKE_PROFIT|EMERGENCY|Sender race|dedup_first"

# 6. 24h 后切 LIVE
sudo systemctl stop dump-sniper
sed -i 's/^DRY_RUN=.*/DRY_RUN=false/' /opt/dump-sniper/.env
sudo systemctl start dump-sniper
```

---

## 24h DRY_RUN 后要看的关键指标

在 dashboard 或 `npm run health` 里看:

1. **新策略触发分布**(执行 SQL):
```sql
SELECT exit_reason, COUNT(*) AS n,
       ROUND(AVG(pnl_pct), 2) AS avg_pnl,
       ROUND(SUM(pnl_sol), 4) AS total_pnl_sol
FROM positions
WHERE closed_at IS NOT NULL
  AND opened_at > strftime('%s','now','-24 hours')*1000
GROUP BY exit_reason
ORDER BY n DESC;
```
**健康信号**:
- `TAKE_PROFIT` 占比偏低(+50% 罕见),但 avg_pnl ≥ +45%
- `TRAILING_STOP` 是主要止盈来源,avg_pnl 在 +5% ~ +30% 之间
- `EMERGENCY_STOP` 占比 < 20%
- `TIMEOUT` 占比 < 30%(30min 内大多数会被前 3 个触发)

2. **同 slot 命中率**(看 dashboard 的 latency 部分):
- 单 region 时基线 30%
- 多 region 后目标 45-55%

3. **Sender race region 分布**:
```
Executor.senderRaceWonBy_FRA: X
Executor.senderRaceWonBy_EWR: Y
Executor.senderRaceWonBy_TYO: Z
```
如果某个 region 占 < 5%,说明对你没用,可以撤。

---

## 已知限制 / 待办

- **trailing 字段未持久化**:重启时 highWaterMark 重置为 entryPrice。如果重启时已经 armed 的仓位,trailing 状态会丢失。这是为简化 schema 做的取舍 — 如果实际运行中发现重启频次高且影响明显,可以加 DB migration 把 high_water_mark / high_water_mark_ts / trailing_armed 三个字段持久化到 positions 表。
- **多 region credit 用量翻倍**:如果你的 Helius plan 接近 credit 上限,启用多 region 前先在 dashboard 看用量。
- **Sender 全失败**:多 region 全部 fail 会 fallback 到 staked RPC,跟旧行为一致;但全失败时延迟 = 等所有 region 各自 5s timeout = 5 秒,有损害。如果某 region 持续 fail,从 `_ENDPOINTS` 里移除它。
