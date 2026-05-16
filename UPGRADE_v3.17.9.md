# v3.17.9 升级说明

> 这一版**校正了 v3.17.8 一个错误的设计假设**(CU 111K 通杀)。
> openclaw 实战 5 笔 BUY_CHAIN_FAILED 烧了 0.2 SOL fee 但没买到 token,数据揭示真相。
> 同时加了 reconcile watchdog 兜底 + 告警机制,防止"幽灵 open position"。

---

## 我之前错在哪里

v3.17.8 用 BABYTROLL slot 数据下了一个**经验性推断**:
> "顶级 sniper 93kgxYKe 用 CU 111K 成功,我们也用 111K"

**这是错的**。BABYTROLL slot 那一次 swap 在那个池子状态下凑巧只需要 111K 完成,但**Pump swap 的 CU 消耗有很大方差**。

openclaw 5 笔 BUY_CHAIN_FAILED 实战数据揭示真相:

| 交易 | CU limit | CU consumed | 结果 |
|---|---|---|---|
| Nigga | 150K | 150K | ❌ 爆 |
| GKC #1 | 150K | 150K | ❌ 爆 |
| GKC #2 | 170K | 170K | ❌ 爆 |
| CROWDCAM | 150K | 149,403 | ✅ 99.6% 险胜 |
| BABYTROLL | 150K | 144,912 | ✅ 96.6% |

**Pump swap CU 消耗实际分布**:最低 137K,典型 140-145K,**有时 ≥170K**(看池子复杂度)。

**经济损失**:5 笔失败 × 0.04 SOL priority fee = **0.2 SOL 白花,token 没买到**。

---

## 这一版的 4 个改动

### 1. 🔥 CU 默认 111K → 250K + Priority Fee 0.04 → 0.067 SOL

**为什么 250K**:
- 给典型 swap 留 80% 余量
- 给极端 swap(170-200K)留 25-50% 余量
- 配合 priority fee 拉到 0.067 SOL → **μL/CU = 0.067 / 250K = 267M**
- 仍然能进 BABYTROLL slot 排名 2-3 位(>排名2 的 113M),只是低于排名1的 334M

**ROI 算账**(每笔 BUY):
- v3.17.8 风险:CU 111K → 多花 0.027 SOL,但**每 ~5 笔可能 1 笔失败白烧 0.04**
- v3.17.9 稳:CU 250K → 多花 0.027 SOL,**几乎不失败**
- 净收益:稳定成交 > 偶尔进排名 1 但 20% 失败率

### 2. Reconcile Watchdog 兜底

**症状**(openclaw 实战):Clawd 这笔 BUY 链上失败(ProgramFailedToComplete),token 没到账,但 dashboard 显示 `status=open`。理论上 `_reconcileBuyAsync` 应该检测到 confirmed=false 并关闭 position,但**没有触发**。

**可能根因**:
- `setImmediate` / Promise 异常被吞(已 catch 但实际可能没触发)
- `confirmTx` 内部 RPC 长期阻塞(>60s)
- `getSignatureStatuses` 对失败 tx 返回 null,poll 到 8s 超时但没正常关闭

**修复**:**Watchdog 定时器**
- 开仓后 60s 自动检查
- 如果 position 仍存在 AND `reconciled=false` → 强制按 `BUY_RECONCILE_TIMEOUT` 处理
- 60s 远大于正常 reconcile 时间(1-3s),正常路径不会触发
- Reconcile 成功 / 失败时主动 `clearTimeout`,避免误触发

### 3. BUY_CHAIN_FAILED 告警机制

`scripts/health.js` + dashboard 新加 3 个告警:

| Alert | 级别 | 触发条件 | 处理方式 |
|---|---|---|---|
| `executor.cu_near_limit` | warn | `cuNearLimit > 0` | 立即 `COMPUTE_UNIT_LIMIT += 30K` |
| `executor.buy_chain_failed` | error | `buyChainFail > 0` | 立即 `COMPUTE_UNIT_LIMIT += 50K` 并查代币 |
| `positions.reconcile_watchdog` | critical | `reconcileWatchdog > 0` | 查 Helius RPC 健康度 |

启动后 `npm run health` 能直接看到这些告警。

### 4. 配套配置/文档更新

- `BUY_MAX_PRIORITY_FEE_LAMPORTS`: 0.05 → 0.08 SOL(给 dynamic 模式上探空间)
- `JITO_TIP_LAMPORTS=3000000` 不变(仅 Jito 通道兜底)

---

## .env 必读

```bash
# v3.17.9 关键新默认值(不写也会生效)
COMPUTE_UNIT_LIMIT=250000                # ← 从 111K 改回 250K(避免 BUY 爆)
BUY_MIN_PRIORITY_FEE_LAMPORTS=67000000   # ← 从 0.04 → 0.067 SOL(维持 μL/CU)
BUY_MAX_PRIORITY_FEE_LAMPORTS=80000000   # ← dynamic 上探空间
```

如果你 .env 显式写了 v3.17.8 的旧值,要么删掉(用新默认),要么改成上面值。

---

## 关于 CROWDCAM 实战的额外发现(图3-4)

openclaw 调查 CROWDCAM 那笔的"为什么 μL/CU 267M 但排名 970":
- slot gap = 0(我们进了同一 slot!)
- μL/CU 267M(我们)远高于对手 43M
- **但我们排第 970,对手排 698**

**openclaw 的结论(我认同)**:**Solana leader 不是按 μL/CU 严格排序**
- banking stage 是 FIFO + write-lock 串行混合机制
- 对手通过 mempool 监听**比我们早 600ms** 看到砸盘
- 即便我们 μL/CU 更高,他们 tx 已经在 banking stage 排队靠前了

**这是物理瓶颈,不是代码问题**。要进 slot+0 内排前面,需要:
1. Shredstream 订阅(直接看 leader 的 in-flight tx)
2. mempool 监听(等价手段)
3. Jito bundle(把 BUY 和砸单 tx 打包给 Jito)

**这些都是 6-8 周改造,不是改配置能解决的**。

CROWDCAM 那笔实际是正常工作的 — 移动止盈 +10.44%,实际盈利 0.30 SOL。只是用户手动改 DB 时覆盖了 exit_reason。

---

## 验证步骤

启动后看日志:

```
[Executor] computeUnitLimit=250000
[Executor] buyMinLamports=67000000 (0.067 SOL)
[Executor] expected μL/CU floor: 268M  ← 0.067 SOL / 250K
```

跑 24 小时后 `npm run health`:

```
── Active Alerts ──
  (空,如果有 [WARN] executor.cu_near_limit 或 [ERROR] buy_chain_failed,立即按上方处理)

── Module Counters ──
  [PositionManager]
    buyChainFail              0  ← 必须 0
    cuNearLimit               0  ← 必须 0
    reconcileWatchdog         0  ← 必须 0
    buyReconciled             N  ← 应等于 opened
```

---

## 我个人的判断

**这是 v3.17.x 系列的最后一个 bug 修复版本**。如果跑这一版 48 小时:

✅ 期望看到:
- 0 笔 BUY_CHAIN_FAILED
- 0 笔 cuNearLimit
- 0 笔 reconcileWatchdog
- 平均每笔 BUY 真实成交(reconciled=true)
- 信号-触发-成交链路稳定

如果上面任何一项 > 0,**别再加复杂度,直接调那一项对应的参数**(CU 加 30K,fee 加 0.01,等)。

✅ 如果稳定运行 48 小时,**看 PnL 是否净正**:
- 净正 → 维持配置,等 30 天数据决定要不要进 slot+0
- 净负 → 触发门槛降到 10/10 这条改动可能错了,调回 15/12

**不要再叠新功能了**。slot+0 是另一个 6-8 周项目,需要单独立项。
