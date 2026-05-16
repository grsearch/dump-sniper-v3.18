# v3.18 升级文档 — Week 1: Atomic Jito Bundle 基础设施

## 升级目标

复制 hnu5 / 3fZftz6m / 93kgxYKe / MRiYA 这类顶级玩家的**同 slot 抢入**能力。

**当前 (v3.17.14) 局限**:
- 单 tx 提交,即使最快也只能 +1 slot 落链
- +1 slot 进场时,价格已经被顶级 atomic bundle 玩家推到反弹位
- 实战胜率 30-50%, 利润空间薄

**v3.18 目标**:
- atomic Jito Bundle 提交: BUY 跟砸盘 tx 强制同 slot 落链
- 同 slot 内顺位: 紧跟砸盘 tx, 在反弹形成前抢到最低价
- 实战胜率目标: ≥70%, 单笔利润 +5-8%

---

## 5 周路线图

| 周 | 任务 | 状态 |
|---|---|---|
| **Week 1** | JitoBundleClient + Executor.buyBundle + main 路径分支 | ✅ 完成 |
| Week 2 | ShredStream UDP 接入 + raw tx 重组 | 待 |
| Week 3 | DumpDetector 适配 raw bytes + SignalEngine 传 dumpTxRaw | 待 |
| Week 4 | 实盘灰度 (0.1 SOL 仓位) + 同 slot 命中率验证 | 待 |
| Week 5 | 参数调优 + 仓位扩大 + 长期运行 | 待 |

---

## Week 1 交付清单

### 新增文件

**`src/core/JitoBundleClient.js`** (~350 行)

独立 Jito Block Engine API 客户端:
- `sendBundle(txs[])` — 多 region 并发竞速提交,Promise.race 取最快
- `getInflightBundleStatus(bundleId)` — 查 bundle 落链状态 (Invalid/Pending/Landed/Failed)
- `getBundleStatuses(bundleIds[])` — 查 bundle 完整信息 (含 tx signatures, slot)
- `getRecommendedTipLamports({percentile, bufferMultiplier})` — 动态 tip 推荐
- `startBackgroundTipPoll(5000)` — 每 5s 后台拉 tip floor, BUY 时 0ms 读
- `pickRandomTipAccount()` — 从 Jito 8 个 wallet 中随机选 (避免账户锁竞争)
- 输入验证: bundle max 5 tx, tx max 1232 bytes
- DRY_RUN 模式支持

**Jito 6 个 region endpoints** (写死, 来自 Jito 官方文档):
- global: `mainnet.block-engine.jito.wtf`
- frankfurt: `frankfurt.mainnet.block-engine.jito.wtf`
- amsterdam: `amsterdam.mainnet.block-engine.jito.wtf`
- ny: `ny.mainnet.block-engine.jito.wtf`
- tokyo: `tokyo.mainnet.block-engine.jito.wtf`
- slc: `slc.mainnet.block-engine.jito.wtf`

**Jito 8 个 tip accounts** (写死, 来自 Jito getTipAccounts API):
- 96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5
- HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe
- ... (共 8 个)

### 修改文件

**`src/core/Executor.js`**

新增:
- `this.senderTipAccounts` (10 个) - Helius Sender tip wallets (重命名自 jitoTipAccounts)
- `this.bundleTipAccounts` (8 个) - Jito Bundle tip wallets (新增)
- `this.jitoTipAccounts` - 向后兼容别名, 指向 senderTipAccounts
- `this.bundleMode` - 从 config 读取 useBundleMode 标志
- `this.jitoBundleClient` - lazy init, 由外部注入
- `setJitoBundleClient(client)` - 主入口注入 JitoBundleClient
- `buyBundle(order, dumpTxRaw)` - 完整的 atomic bundle BUY 方法 (~200 行)
- `_extractTxSignature(rawTx)` - 从签名后 tx 提取 base58 signature
- `_buildAndSignTx(ixs, side, {bundleMode, tipLamportsOverride})` - 加 opts 参数,
  bundleMode=true 时 tip 给 Jito 8 个 wallet,false 时 tip 给 Helius 10 个 wallet

不变 (向后兼容):
- 现有 `buy()` 方法完全不变
- 现有 `sell()` / `_submitTx()` / `_submitToSendersRace()` 完全不变
- Helius Sender + Slipstream + Staked RPC 三路并发竞速保持

**`src/core/PositionManager.js`**

`registerOpen()` 接受新字段:
- `bundleId` - Jito bundle ID (bundle 路径才有)
- `bundleTipLamports` - bundle tip 数额
- `bundleRegion` - 哪个 Jito region 赢了竞速

OPEN 日志区分:
- 普通: `📈 OPEN SYMBOL @ price, tokens, SOL`
- Bundle: `📈 OPEN [BUNDLE] SYMBOL @ price, tokens, SOL bundle=xxxx.. region=ny tip=5000000L`

新 monitor counter:
- `PositionManager.openedBundle` - bundle 路径 OPEN 次数

**`src/index.js`** (main 路径)

启动时按 `config.execution.useBundleMode` 注入 JitoBundleClient 到 Executor。

`buyOrder` 事件处理新增判断:
```javascript
const canUseBundle =
  config.execution?.useBundleMode &&
  executor.jitoBundleClient &&
  order.dumpTxRaw;

if (canUseBundle) {
  buyResult = await executor.buyBundle(buyOrderParams, order.dumpTxRaw);
  // 可选: BUNDLE_FALLBACK_TO_NORMAL=true 时 bundle 失败 fallback 普通 BUY
} else {
  buyResult = await executor.buy(buyOrderParams);  // 老路径
}
```

**`src/config.js`**

新增 `execution` 配置块:
- `useBundleMode` (默认 false)
- `bundleTipPercentile` (默认 'p75')
- `bundleTipBuffer` (默认 1.5)
- `jitoRegions` (默认 'global,frankfurt')

**`.env.example`**

新增配置区段:
- USE_BUNDLE_MODE
- BUNDLE_TIP_PERCENTILE
- BUNDLE_TIP_BUFFER
- JITO_BUNDLE_REGIONS
- BUNDLE_TIP_MAX_LAMPORTS
- BUNDLE_FALLBACK_TO_NORMAL

---

## 部署说明

### 完全向后兼容

**默认 `USE_BUNDLE_MODE=false`** — Week 1 部署后行为跟 v3.17.14 一模一样。

升级风险: **零**。所有新代码只在 USE_BUNDLE_MODE=true 时才被激活。

### 部署步骤

```bash
cd /opt/dump-sniper-v3
sudo systemctl stop dump-sniper

# 备份 (永远先备份)
sudo cp -r . ../dump-sniper-v3.backup-$(date +%Y%m%d-%H%M)

# 解压新版本
tar -xzf /tmp/dump-sniper-v3.18-week1.tar.gz --strip-components=1

# .env 不需要改动 (新配置默认 false,不影响)
# 也可以可选添加新配置 (拉到 .env.example 看说明)

# 重启
sudo systemctl start dump-sniper

# 验证启动正常
sudo journalctl -u dump-sniper -n 50 --since "1 min ago"

# 验证版本
node -e "console.log(require('./package.json').version)"  # 应输出 3.18.0-week1

# 验证 JitoBundleClient 模块可加载
node -e "
const JBC = require('./src/core/JitoBundleClient');
const c = new JBC({ regions: ['global'], dryRun: true });
c._fetchTipFloor().then(f => console.log('Tip floor:', f));
"
```

### 启用 Bundle 模式 (可选, Week 2 后再启)

Week 2 接入 ShredStream 后,可在 .env 加:

```bash
USE_BUNDLE_MODE=true
BUNDLE_TIP_PERCENTILE=p75
BUNDLE_TIP_BUFFER=1.5
JITO_BUNDLE_REGIONS=global,frankfurt
```

启用前确认:
- JITO_TIP_LAMPORTS >= 1_000_000 (0.001 SOL,bundle 最低 tip)
- 钱包余额 ≥ 30 SOL (建议)

---

## 监控

### 新增 counter (HealthMonitor)

**Executor**:
- `Executor.bundleBuyAttempts` - bundle BUY 尝试次数
- `Executor.bundleBuySuccess` - bundle BUY 成功次数 (DRY_RUN 也算)
- `Executor.bundleBuyFail` - bundle BUY 失败次数
- `Executor.bundleTipsSent` - tip 给 Jito 8 个 wallet 的次数
- `Executor.senderTipsSent` - tip 给 Helius 10 个 wallet 的次数 (老路径)
- `Executor.lastBundleSendMs` - 最近一次 bundle 提交耗时
- `Executor.lastBundleStateLatencyMs` - bundle 路径 state 加载耗时

**JitoBundle**:
- `JitoBundle.sendBundleWon` - bundle 提交成功次数
- `JitoBundle.sendBundleWonBy_<region>` - 各 region 赢的次数
- `JitoBundle.lastSendBundleRaceMs` - 最近一次竞速耗时
- `JitoBundle.sendBundleAllFailed` - 所有 region 都失败次数
- `JitoBundle.tipFloor_p75_lamports` - 当前 p75 tip floor
- `JitoBundle.tipFloor_p95_lamports` - 当前 p95 tip floor
- `JitoBundle.dryRunSent` - DRY_RUN 模拟提交次数

**PositionManager**:
- `PositionManager.openedBundle` - bundle 路径开仓次数

### 查询

```bash
npm run health 2>&1 | grep -E "bundle|JitoBundle"
```

---

## Week 1 测试覆盖

### JitoBundleClient 单元测试 (7/7 通过)

1. ✓ 静态常量 (8 tip accounts, 6 regions)
2. ✓ DRY_RUN 模式初始化
3. ✓ pickRandomTipAccount 分布
4. ✓ getRecommendedTipLamports (fallback values)
5. ✓ sendBundle DRY_RUN 返回 DRY_xxx
6. ✓ 输入验证 (空 array / >5 tx / >1232 bytes / 非 Buffer)
7. ✓ Inflight status DRY_RUN

### Executor.buyBundle 端到端测试 (7/7 通过)

1. ✓ Executor 初始化 with bundle config
2. ✓ setJitoBundleClient 注入
3. ✓ buyBundle DRY_RUN with valid dump tx
4. ✓ 输入验证 — 无 dumpTxRaw
5. ✓ 输入验证 — dumpTxRaw 过大 (>1232 bytes)
6. ✓ 输入验证 — priceAfter 缺失
7. ✓ 普通 buy() 路径 (向后兼容)

### main 集成测试 (5/5 通过)

1. ✓ config.execution 配置加载
2. ✓ Executor + JitoBundleClient 完整通路
3. ✓ canUseBundle 判断正确触发 buyBundle
4. ✓ buyBundle 返回 bundleId / signature / 真实 tokenAmount
5. ✓ 无 dumpTxRaw 时自动 fallback 到普通 buy()

---

## Week 2 准备 (用户需做的)

### 1. ShredStream 订阅

注册: https://www.shredstream.com/
试用: $70/天 (Week 2-4 期间订阅, 估计 $1500)

让 Openclaw 准备:
- ShredStream FRA endpoint
- 服务器开放 UDP 端口 (通常 8001-8002 范围, 等订阅后他们会告诉)
- 防火墙规则确认 `sudo iptables -L | grep UDP`

### 2. 钱包充值

当前 18 SOL → 充到 30 SOL (Week 4 实盘灰度需要)

### 3. 验证 v3.18 Week 1 部署稳定

部署 Week 1 后 跑 24-48 小时确认:
- 服务正常运行,无 crash
- 现有 BUY 路径 (普通 buy()) 行为完全不变
- bundle 相关代码没有引入 regression

观察命令:
```bash
sudo journalctl -u dump-sniper -f | grep -E "BUY|ERROR|JitoBundle"
npm run health 2>&1 | grep -E "buyAttempts|buyChainFail"
```

---

## 风险评估

### Week 1 部署风险: 极低

新代码全部在 `useBundleMode=false` 默认配置下静默,不影响现有 BUY/SELL 流程。

### Week 2-3 开发期风险: 中

- ShredStream UDP 接入需要服务器网络配置正确
- raw shred 重组逻辑可能有解析 bug,但 DRY_RUN 模式可以充分测试

### Week 4 实盘灰度风险: 中高

- Bundle 失败率初期可能 30-50% (tip 调不准 / region 选不对)
- 失败时 fee 浪费, 但不会爆仓 (atomic 失败 = 不上链)
- 建议: 0.1 SOL 仓位,准备 5-10 SOL 灰度预算

### 长期成本

| 项目 | 月费 |
|---|---|
| Helius Business (现有) | $499 |
| ShredStream (Week 2+) | ~$2100 (固定订阅) 或 trial 期 $70/天 |
| Jito tip 消耗 (50-100 笔/天 × 0.005 SOL) | 2.5-5 SOL ≈ $500-1000 |
| 失败 bundle fee 浪费 | 0.5-1 SOL ≈ $100-200 |
| **合计** | **$3100-3800 / 月** |

ROI: 顶级玩家月利 30-200 SOL × $200/SOL = $6K-40K, **覆盖成本绰绰有余**。

---

## 给 Openclaw 的部署指令

```bash
# 1. 备份
cd /opt
sudo cp -r dump-sniper-v3 dump-sniper-v3.backup-$(date +%Y%m%d-%H%M)

# 2. 停服务
sudo systemctl stop dump-sniper

# 3. 解压新版本 (假设 tar 已上传到 /tmp)
cd /opt/dump-sniper-v3
sudo tar -xzf /tmp/dump-sniper-v3.18-week1.tar.gz --strip-components=1

# 4. 装依赖 (axios 是新依赖, 已在 package.json 里)
sudo npm install

# 5. 验证 .env (不需要改动, 但确认没冲突)
diff .env <(grep -v "^#\|^$" /tmp/dump-sniper/.env.example | head -5)

# 6. 验证文件完整
ls -la src/core/JitoBundleClient.js
node --check src/core/JitoBundleClient.js
node --check src/core/Executor.js

# 7. 启动
sudo systemctl start dump-sniper

# 8. 监控 1 分钟
sudo journalctl -u dump-sniper -f --since "1 min ago" | head -30

# 9. 验证现有 BUY 行为不变
npm run health 2>&1 | grep buyAttempts

# 应看到:
#   - 启动日志正常
#   - 没有报错
#   - BUY 路径仍走 buy() (非 bundle), Executor.bundleBuyAttempts=0
```

---

## 下一步

Week 2 开始时:
1. 用户订阅 ShredStream 试用
2. Openclaw 准备服务器 UDP 端口配置
3. 我开始写 ShredStreamSource.js (Week 2 Day 1)

预计 Week 2 完成时间: 5-7 天
