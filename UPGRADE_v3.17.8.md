# v3.17.8 升级说明

> 基于 v3.17.7 实战 30+ 笔交易后的迭代,共 5 个改动:
> - **1 个性能优化**(μL/CU 排名)— 这次最重要
> - **1 个内存泄漏修复**(PoolStateCache)
> - **2 个防御性修复**(stuck/restore)
> - **1 个文档同步**(用户调过的触发门槛保留)
>
> 从 v3.17.7 升级:`git pull && systemctl restart dump-sniper`,**.env 关键字段已变默认值**(详见下方)

---

## 最重要的洞察:推翻了之前对 Jito tip 的理解

**v3.17.x 各版本一直把 Jito tip 当成"提升 slot 命中率"的关键手段,这是错的。**

BABYTROLL 实战数据揭示真相:

| 排名 | 钱包 | Priority Fee | Jito Tip | CU | μL/CU | 备注 |
|---|---|---|---|---|---|---|
| 1 | 93kgxYKe | 0.037 SOL | **无** | 111K | **334M** | 没有 tip 排第1 |
| 2 | 3fZftz6m | 0.012 SOL | **无** | 110K | 113M | 也没用 tip |
| 4 | **我们 v3.17.7** | 0.01 SOL | 0.02 SOL | 163K | 61M | tip 多花 0.02 但排第4 |
| 第1名 | 5d8tDay1 | - | - | - | - | 跟砸单同 slot,靠 mempool+bundle |

**3 个关键事实**:
1. Solana leader 同 slot 内排序看 **μL/CU = priority_fee / CU**,**Jito tip 不算入此公式**
2. 顶级 sniper 都没用 Jito tip — 他们靠**高 priority fee + 低 CU** 取胜
3. 跟砸单同 slot(slot+0)的玩家不靠 tip,而是靠 **mempool 监听 / Jito bundle** — 那是我们做不到的层级

**Jito tip 的真正用途**:
- ✅ 提升 **Jito 通道单 tx 拍卖中标率**(Jito 自己的拍卖,跟 leader 排序无关)
- ✅ 让 Helius Sender 走 Jito 通道(需要 ≥ 0.001 SOL)而不只是 staked validator 通道
- ❌ 不会提升你在 leader 内的 slot 排名

---

## 改了什么(5 个改动)

### 1. μL/CU 排名优化(对标实战排名1对手)

新的默认值组合(目标 μL/CU ≈ 360M,超过实战排名1的 334M):

```bash
COMPUTE_UNIT_LIMIT=111000           # 旧 170000 → -34%
BUY_MIN_PRIORITY_FEE_LAMPORTS=40000000   # 旧 10000000 → +300%
JITO_TIP_LAMPORTS=3000000           # 旧 10000000 → -70%(只为 Jito 通道兜底)
```

**这是经济上的重大权衡**:
- 每笔 BUY 多花 0.03 SOL priority fee(0.04 - 0.01),少花 0.007 SOL tip
- 净增加成本约 0.023 SOL/笔
- **必须配合 POSITION_SIZE_SOL ≥ 3 才划算**(否则 0.023 / 0.5 SOL position = 4.6% 的固定吃损,把利润空间挤掉一大块)
- 你最后调到 `POSITION_SIZE_SOL=3`,**这个值跟新 fee 结构正好匹配**

⚠️ **CU 降到 111K 有风险**:
- 实测 SDK BUY 消耗 135-146K — 用 111K 是**赌实际消耗会少**(因为 ComputeBudget 是估算上限,链上多数 swap 不会触达上限)
- **必须监控** `Executor.cuNearLimit` 计数器,如果 24h 内 > 0,立刻调回 130-150K
- 含 fee_program CPI 的 swap(如 HERMES)在 111K 下会爆 — 这类代币要么排除监控,要么单独配 130K

### 2. PoolStateCache 内存泄漏修复

**症状**:服务长跑后出现 "PoolStateCache stale" + Helius RPC RESOURCE_EXHAUSTED,重启就好。

**根因**:`this.cache` 是 Map,token 被移出监控列表后,**该 pool 的 cache entry 永远不删**。短期没问题,长跑(>72h)累积:
- 内存膨胀(每个 cache entry 1-3KB,几百个 = 几 MB,看着不多但加上其他泄漏会触发限流)
- _refreshAll 用 `targets`(当前监控列表)所以失效 entry 永远不刷新,但永远占内存
- 配合 Helius 限流策略,长跑后触发 RESOURCE_EXHAUSTED

**修复**:`_refreshAll` 每轮开头清理 cache 里"不在当前 targets 中"的 entry。

### 3. restoreFromDb 加 status 字段校验

**症状**(openclaw 实战发现):手动 `UPDATE positions SET status='closed' WHERE ...` 但忘记填 `closed_at`,这些行启动时被恢复成 open,dashboard 显示有"幽灵持仓"。

**修复**:`getOpenPositions` 查询从 `WHERE closed_at IS NULL` 改成:
```sql
WHERE closed_at IS NULL AND (status IS NULL OR status != 'closed')
```
双条件保护,中间状态(sell_pending/sell_confirming/stuck)仍能正常恢复。

### 4. SELL confirm 超时双保险(防 stuck)

**症状**(openclaw 实战):10 笔标记为 stuck 的 position,链上 SELL 其实都成功了,只是 confirmTx 在 15 秒窗口内没收到。

**根因**:`_confirmSellAsync` 超时(15s)就走 retry/stuck 路径,但有些 tx 实际在 18-30 秒后才真正确认 — 那时候我们已经把它当失败处理了。

**修复**:`_confirmSellAsync` 超时后,**再发起一次直接 `fetchTxSwapResult` 查询**,如果链上 tx 实际成功 → 走 `_finalizeSuccess`,如果还是失败 → 走原 retry 流程。

### 5. .env 触发门槛保留用户调整,加文档

你最后调了 `MIN_SELL_SOL=10` / `MIN_PRICE_IMPACT_PCT=10`(从 15/12 降)。

我**没改回去**,但在 .env.example 加了注释,说明利弊:
- ✅ 利:更多信号(原本 20 分钟 30 个 dump 全被拒)
- ⚠️ 弊:小砸单的反弹质量可能 < 大砸单(对手仍是顶级 sniper)
- 建议:跑 24-48 小时后用 `npm run analyze` 看 — 如果 10-14 SOL 砸单的 avg_pnl > 0 且不显著差于 15+ SOL,继续用 10;否则调回 15

---

## .env 必读

**v3.17.8 改了 4 个默认值**:

```bash
# 全部使用新默认值即可(.env 不写也会生效)
COMPUTE_UNIT_LIMIT=111000           # ← 新默认
BUY_MIN_PRIORITY_FEE_LAMPORTS=40000000   # ← 新默认  
JITO_TIP_LAMPORTS=3000000           # ← 新默认
BUY_MAX_PRIORITY_FEE_LAMPORTS=50000000   # ← 新默认(静态模式 fallback,从 0.02 → 0.05 SOL)
```

如果你保留 v3.17.7 的旧值(.env 显式写了),要么删掉(用新默认),要么手动改成上面这些值。

---

## 强烈建议监控的指标

启动后跑 24 小时,看 `npm run health` 或 dashboard 里:

| 指标 | 健康范围 | 异常处理 |
|---|---|---|
| `Executor.cuNearLimit` | **必须 = 0** | > 0 立即调 `COMPUTE_UNIT_LIMIT=130000` |
| `PoolStateCache.evicted` | 每天 < 50 | 大量 > 100 说明监控列表频繁变动,正常 |
| `PositionManager.sellRecoveredFromTimeout` | < 10/天 | > 10 说明 confirm 超时严重,要查 RPC subscribeSignature |
| stuck position 数 | 应该 0 或个位数 | 大量 stuck 说明 SELL 提交后 tx 大量失败,要查网络 |

---

## 验证步骤

启动后日志应该有:

```
[Executor] computeUnitLimit=111000 (μL/CU optimization for slot ranking)
[TickStream] initialized with 3 region(s): FRA, EWR, TYO
[PoolStateCache] started (rolling refresh: ...)
[PoolStateCache] evicted N stale entries  ← v3.17.8 新增,可能首次出现是 0
```

第一笔 BUY 时,日志关注:

```
[Executor] BUY ...: priority_fee=40000000 (0.04 SOL), CU_limit=111000, μL/CU=360M
                                                                       ↑ 应该接近 360M
[Executor] BUY tx confirmed in 1 slot, position 1/3   ← 应该在 slot 内排前 3
```

如果排名仍然 4 之后,说明这 slot 里有人比我们更激进(0.05+ SOL fee),可以继续加 `BUY_MIN_PRIORITY_FEE_LAMPORTS=50000000`。

---

## 一个仍然存在的限制(老实说)

**v3.17.8 能让我们进 slot+1 内排名靠前(1-3 位)**,但**永远进不了 slot+0**,因为 slot+0 需要:
1. mempool 监听(不等砸单 tx 落链,直接从 pending pool 抢)
2. Jito bundle(把 BUY 和砸单 tx 打包成一个 bundle 提给 Jito)

这两条都需要**额外的基础设施投入**(Shredstream 订阅 / Jito 接入 / 高速 leader proxy 等),不是改配置能解决的。

**5d8tDay1 这种顶级玩家会一直比我们快 1 slot**,我们能做的是:**当他们没在场或者放弃 BUY 时,作为 slot+1 的最快玩家拿到反弹**。这就是当前 ROI 的天花板。

下一步要不要进 slot+0,看你 ROI 数据:
- 如果 30 天 ROI > 50% 且 PnL > 5 SOL,值得投入开发 Shredstream + Jito bundle(6-8 周工作量)
- 如果 ROI < 20% 或 PnL < 0,先稳定参数,别加复杂度
