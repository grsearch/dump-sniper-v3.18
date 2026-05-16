# 新服务器部署指南 (v3.17)

本文档面向**全新服务器从零部署**场景。按顺序执行,不要跳步骤。

---

## 0. 前置条件

**服务器规格建议**:
- 4 核 / 8 GB 内存 / 50 GB SSD
- Ubuntu 22.04 LTS 或 24.04 LTS
- **关键:服务器物理位置选欧洲(法兰克福/阿姆斯特丹)或美东**,这是 Solana 主流验证人聚集区,跟你的对手们(其他 sniper)位于相同 region 才能拼速度。亚洲服务器跑这套会被欧美服务器吊打。
- 推荐:Hetzner CCX23 (FRA,€34/月) 或 Vultr High Frequency (EWR/AMS,$30/月)

**必须准备好的 API/Key**:
- ✅ Helius API Key (Professional plan 或更高,$999/月起,Business plan 也行)
  - LaserStream gRPC 需要 Professional+
  - 主 API key 在 https://dashboard.helius.dev
- ✅ LaserStream Token (Helius dashboard 里"LaserStream"标签下生成)
- ✅ Birdeye API Key (https://birdeye.so/developers,免费 tier 够用)
- ✅ Solana 交易钱包 (推荐用新钱包,不要用主钱包)
  - 私钥需要是 **base58 编码**(Phantom 导出的格式)
  - 钱包里准备 0.5-2 SOL 作为交易本金

---

## 1. 系统准备

SSH 登录新服务器后,以 root 或 sudoer 身份:

```bash
# 1.1 更新系统
sudo apt update && sudo apt upgrade -y

# 1.2 安装基础工具
sudo apt install -y curl git vim build-essential rsync logrotate

# 1.3 安装 Node.js 20.x (项目要求 >= 18,推荐 20 LTS)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# 验证
node -v   # 应显示 v20.x
npm -v    # 应显示 10.x+

# 1.4 创建运行用户(如果你的服务器没有非 root 用户的话)
# 如果已有 ubuntu/admin 之类的用户,跳过这步
sudo adduser --disabled-password --gecos "" ubuntu
sudo usermod -aG sudo ubuntu

# 1.5 (可选)防火墙基本配置
sudo ufw allow 22/tcp
sudo ufw allow 3001/tcp   # dashboard 端口,如果想从外网访问
sudo ufw --force enable
```

---

## 2. 拉代码 + 安装

```bash
# 2.1 切到 ubuntu 用户拉代码到 /tmp(因为 install.sh 需要从项目目录运行)
sudo su - ubuntu
cd /tmp
git clone https://github.com/<YOUR_GITHUB>/dump-sniper.git
# 或者用 ssh: git clone git@github.com:<YOUR_GITHUB>/dump-sniper.git

cd dump-sniper

# 2.2 回到 root 跑安装脚本
exit   # 退出 ubuntu 用户回到 sudoer
cd /tmp/dump-sniper

# 安装到默认路径 /opt/dump-sniper
sudo bash deploy/install.sh

# 脚本会自动:
#   - 复制项目文件到 /opt/dump-sniper(排除 node_modules, .env, data/*.db)
#   - npm install --omit=dev(只装 production 依赖)
#   - 设置 systemd 服务
#   - 配置 logrotate
```

如果中间报错,常见原因:
- npm install 失败 → 网络问题,重跑 `cd /opt/dump-sniper && sudo -u ubuntu npm install --omit=dev`
- better-sqlite3 编译失败 → 缺少 build-essential,回到 1.2 装一下

---

## 3. 配置 .env

这是**最关键的一步**。任何配置错误都会导致策略失效或 BUY 失败。

```bash
sudo -u ubuntu cp /opt/dump-sniper/.env.example /opt/dump-sniper/.env
sudo -u ubuntu vim /opt/dump-sniper/.env
```

### 必填项

```bash
# Mode — 先 DRY_RUN!
DRY_RUN=true

# Helius (主 API)
HELIUS_API_KEY=<你的 Helius API key>
HELIUS_RPC_URL=https://mainnet.helius-rpc.com/?api-key=<同上 key>
HELIUS_STAKED_RPC_URL=https://mainnet.helius-rpc.com/?api-key=<同上 key>

# LaserStream Token (Helius dashboard 单独生成)
HELIUS_LASERSTREAM_TOKEN=<你的 LaserStream token>

# Birdeye
BIRDEYE_API_KEY=<你的 Birdeye API key>

# 交易钱包(base58 私钥,Phantom 导出格式)
WALLET_PRIVATE_KEY_BS58=<钱包私钥 base58>
```

### v3.17.6 关键策略参数(已是新默认值,确认即可)

```bash
# 触发条件
MIN_SELL_SOL=15.0
MIN_PRICE_IMPACT_PCT=12.0
MAX_PRICE_IMPACT_PCT=30.0
MIN_POOL_QUOTE_SOL=30.0

# 仓位 — 先小金额!验证策略可用后再放大
POSITION_SIZE_SOL=0.1

# 止盈策略(v3.17.6 实战调参)
TAKE_PROFIT_PCT=50.0
TP_CONFIRM_COUNT=2
TP_CONFIRM_MIN_GAP_MS=300

# 移动止盈(v3.17.6 调参 8/3/2000)
TRAILING_ACTIVATE_PCT=8.0
TRAILING_DRAWDOWN_PCT=3.0
TRAILING_MIN_HWM_AGE_MS=2000

# Stabilization 期(v3.17.6 新增 — 关键!)
STABILIZATION_MS=5000

# 紧急止损
EMERGENCY_STOP_LOSS_PCT=-15.0

# 最大持仓时间(v3.17 改 30 分钟)
MAX_HOLD_MS=1800000

# 滑点
BUY_SLIPPAGE_BPS=1500
SELL_SLIPPAGE_BPS=2000

# 风控
COOLDOWN_MS_PER_TOKEN=60000
MAX_CONCURRENT_POSITIONS=5

# v3.17.6 同砸单去重(防 LaserStream 跨region重推同砸单)
SELLER_TX_DEDUP_MS=600000

# CU 限制(v3.17.6 降到 170K 提升 μL/CU 排名)
COMPUTE_UNIT_LIMIT=170000
```

### v3.17 延迟优化:多 region 配置(强烈推荐)

⚠️ **根据你的服务器 region 选择合适的 endpoint 组合**

**如果服务器在欧洲(FRA/AMS)**:
```bash
# LaserStream 订阅 欧 + 美东 + 亚太
HELIUS_LASERSTREAM_ENDPOINTS=https://laserstream-mainnet-fra.helius-rpc.com,https://laserstream-mainnet-ewr.helius-rpc.com,https://laserstream-mainnet-tyo.helius-rpc.com

# Sender 也用三 region(并发提交,race 取最快)
HELIUS_SENDER_ENDPOINTS=http://fra-sender.helius-rpc.com/fast,http://ewr-sender.helius-rpc.com/fast,http://tyo-sender.helius-rpc.com/fast
```

**如果服务器在美东(EWR/NY)**:
```bash
HELIUS_LASERSTREAM_ENDPOINTS=https://laserstream-mainnet-ewr.helius-rpc.com,https://laserstream-mainnet-fra.helius-rpc.com,https://laserstream-mainnet-tyo.helius-rpc.com
HELIUS_SENDER_ENDPOINTS=http://ewr-sender.helius-rpc.com/fast,http://fra-sender.helius-rpc.com/fast,http://tyo-sender.helius-rpc.com/fast
```

注意:
- **HELIUS_LASERSTREAM_ENDPOINT(无 S 后缀,旧字段)和 HELIUS_LASERSTREAM_ENDPOINTS(数组)都保留**,如果两个都设了,**数组优先**。建议只配数组那个。
- 同理 Sender。
- 没有 token 字段的区别,所有 endpoint 共用一个 `HELIUS_LASERSTREAM_TOKEN`。
- 流量 credits 会按 region 数翻倍,留意 Helius dashboard 用量。

### v3.17 Jito Tip

```bash
# 0.01 SOL — 配合 POSITION_SIZE >= 0.5 SOL 才划算
JITO_TIP_LAMPORTS=10000000

# 如果 POSITION_SIZE 还是 0.1 SOL,先用 0.003-0.005 SOL 看效果
# JITO_TIP_LAMPORTS=3000000
```

### v3.17 Priority Fee Oracle(刷新提速)

```bash
PRIORITY_FEE_REFRESH_MS=500
```

### Server / Dashboard

```bash
DASHBOARD_PORT=3001
BIND_HOST=0.0.0.0   # 如果不想从外网访问,改 127.0.0.1 然后用 ssh tunnel

# 强烈建议设一个 dashboard token 防止公网访问
DASHBOARD_TOKEN=<openssl rand -hex 32 生成>
```

---

## 4. 启动 + 验证

```bash
# 4.1 启动服务
sudo systemctl start dump-sniper

# 4.2 设开机自启
sudo systemctl enable dump-sniper

# 4.3 看状态
sudo systemctl status dump-sniper
# 应该是 active (running),没有红色错误

# 4.4 跟踪日志(实时,Ctrl+C 退出)
sudo journalctl -u dump-sniper -f
```

正常启动日志应该有这几行:

```
[Executor] wallet loaded: <你的钱包地址>
[Executor] Pump AMM SDK loaded ...
[Executor] Helius Sender multi-region enabled: 3 endpoints
  - http://fra-sender.helius-rpc.com/fast
  - http://ewr-sender.helius-rpc.com/fast
  - http://tyo-sender.helius-rpc.com/fast
[TickStream] initialized with 3 region(s): FRA, EWR, TYO
[TickStream:FRA] connected, watching N mints
[TickStream:EWR] connected, watching N mints
[TickStream:TYO] connected, watching N mints
[SignalEngine] restored N triggered seller_tx from DB (within last 10min, dedup window)   ← v3.17.6 新增
```

策略触发时(关键日志):
```
[SignalEngine] ✅ BUY_SIGNAL ... seller_tx=xxx..
[Executor] Sender race won by FRA in ZZms ...
[PositionManager] 📈 OPEN ...
[PositionManager] 🔧 BUY reconciled XXX: entrySol 3.0→2.87 (-4.3%), ...
[PositionManager] ✅ stabilization done XXX: samples=8, baseline=1.05e-6 (+4.20%), HWM set to ...  ← v3.17.6
```

看到 3 个 `connected` + `restored ... seller_tx` + `stabilization done` 说明多 region + dedup 持久化 + 稳定期都工作了。

---

## 5. 添加监控代币

服务启动后,需要告诉它要监控哪些代币。两种方式:

### 方式 A:Dashboard 添加(推荐)

打开浏览器 `http://<server-ip>:3001`,如果设了 `DASHBOARD_TOKEN`,URL 后加 `?token=<your_token>`。

在 dashboard 里有"添加代币"输入框,粘贴 Pump.fun 的代币地址即可。

### 方式 B:Webhook API

```bash
curl -X POST http://localhost:3001/webhook/add-token \
  -H "Content-Type: application/json" \
  -d '{"network":"solana","address":"BWJ7zJauzatao4FsBnGdVsqdBi3k5NbgSY62noZApump","symbol":"Nana"}'
```

代币添加后,系统会自动跑 `fillPools` 补 pool 信息(BUY/SELL 必须的池子数据)。这步如果失败 BUY 会一直触发不了,看日志里有没有 `[poolFinder] ...` 报错。

---

## 6. DRY_RUN 24 小时验证

**严禁立即切 LIVE!** 先 DRY_RUN 跑 24 小时,看以下几个指标都对得上再切。

### 6.1 看 dashboard 上的 latency 部分

应该看到:
- LaserStream 推送延迟分布:有快有慢但**多数 < 1s**
- 内部处理延迟:30-50ms 范围
- 哪些 token 触发了 dumpSignal、哪些被各 region 第一个收到

### 6.2 在终端用 SQL 看策略触发分布

```bash
sudo -u ubuntu sqlite3 /opt/dump-sniper/data/sniper.db <<EOF
SELECT exit_reason, COUNT(*) AS n,
       ROUND(AVG(pnl_pct), 2) AS avg_pnl_pct,
       ROUND(SUM(pnl_sol), 4) AS total_pnl_sol
FROM positions
WHERE closed_at IS NOT NULL
  AND opened_at > strftime('%s','now','-24 hours')*1000
GROUP BY exit_reason
ORDER BY n DESC;
EOF
```

**24h 后健康的分布**应该长这样(顺序可能不同):

| exit_reason | 占比 | avg_pnl_pct |
|---|---|---|
| TRAILING_STOP | 40-60% | +5% ~ +30% |
| EMERGENCY_STOP | 10-20% | ~-15% |
| TIMEOUT | 20-35% | -5% ~ +3% |
| TAKE_PROFIT | < 10% | +45% ~ +60% (罕见但单笔最大) |

**红灯信号**:
- TIMEOUT 占比 > 50% → 多数仓位 30 分钟内没有任何方向 → 可能是触发标准太宽
- EMERGENCY_STOP 占比 > 30% → 砸单后没反弹直接继续跌 → 触发标准要调严
- TRAILING_STOP avg_pnl_pct < +3% → 移动止盈触发太快 → 把 `TRAILING_DRAWDOWN_PCT` 从 2.0 调到 2.5-3.0

### 6.3 看 Sender race 谁赢

```bash
sudo -u ubuntu curl -s http://localhost:3001/api/health | grep -E "senderRaceWonBy|dedup_first"
```

如果某个 region 占比 < 5%,从 `_ENDPOINTS` 里撤掉它省 credits。

### 6.4 看是否有持续 STUCK 仓位

```bash
sudo -u ubuntu sqlite3 /opt/dump-sniper/data/sniper.db \
  "SELECT * FROM positions WHERE status='stuck';"
```

DRY_RUN 模式不会真的卡仓,但 LIVE 后这个表如果开始有数据,要立刻看日志找原因(通常是 SDK 升级、池子异常、滑点不够)。

---

## 7. 切 LIVE

24 小时 DRY_RUN 验证 OK 后:

```bash
sudo systemctl stop dump-sniper
sudo -u ubuntu sed -i 's/^DRY_RUN=.*/DRY_RUN=false/' /opt/dump-sniper/.env
sudo systemctl start dump-sniper

# 头几分钟仔细看日志
sudo journalctl -u dump-sniper -f
```

**LIVE 后第一笔成功 BUY 出现时,会看到**:
```
[SignalEngine] ✅ BUY_SIGNAL <SYMBOL>: sell=XX SOL, impact=-YY%
[Executor] Sender race won by FRA in ZZms ...
[PositionManager] 📈 OPEN <SYMBOL> @ <price>, ...
[PositionManager] 🔧 BUY reconciled <SYMBOL>: entrySol ...
```

确认这一连串日志正常,系统就跑起来了。

---

## 8. 日常运维

```bash
# 看实时日志
sudo journalctl -u dump-sniper -f

# 看最近 1h 日志
sudo journalctl -u dump-sniper --since "1 hour ago"

# 重启服务(改 .env 后需要)
sudo systemctl restart dump-sniper

# 健康检查(命令行)
cd /opt/dump-sniper && npm run health

# JSON 输出健康指标(可以 grep)
cd /opt/dump-sniper && npm run health:json | jq .active_alerts

# 看延迟统计
cd /opt/dump-sniper && npm run dissect

# 看策略统计
cd /opt/dump-sniper && npm run strategy

# 看 stuck 仓位
cd /opt/dump-sniper && npm run stuck

# 升级 Pump SDK(官方升级公告后)
cd /opt/dump-sniper && sudo -u ubuntu npm update @pump-fun/pump-swap-sdk
sudo systemctl restart dump-sniper
```

---

## 9. 常见问题

**Q: 启动后日志一直没看到 `dumpSignal`?**
A: 监控列表里的 token 砸盘事件本来就稀疏,要等。同时检查:
- token 是否补到 pool 信息(`SELECT mint, pool_address FROM tokens WHERE pool_address IS NULL`)
- LaserStream 是否正常推送(看 `TickStream.txReceived` counter 在涨)

**Q: 启动后看到 `tickstream.no_traffic LaserStream 监控 N 个代币,但 60s+ 无 tx 收到` 这种告警?**
A: 这通常是 `@triton-one/yellowstone-grpc` SDK 版本兼容问题:
- v3.17.6 已经修了 — `TickStream._sendSubscribeRequest` 会用 `SubscribeRequest.create()` 把请求包装成 protobuf message,适配新版 SDK(v1.4+ 和 v5+ napi-rs 路径)
- 如果你装的是更老的 v3.17 还没修这个,升级到 v3.17.6
- 另一个可能:`HELIUS_LASERSTREAM_TOKEN` 错了或者过期。Helius dashboard 重新生成一个。
- 检查 TickStream 是否真的 connected:日志里应该有 `[TickStream:FRA] connected, watching N mints`。如果只有 `rebuilding` 没有 `connected`,看 `err.log` 有没有 gRPC 错误。
- **诊断命令**:`sudo journalctl -u dump-sniper --since "5 min ago" | grep -E "TickStream|laserstream"`

**Q: BUY 一直失败,日志显示 `Sender race failed`?**
A: 检查:
- `JITO_TIP_LAMPORTS` 是否 ≥ 200000(Helius Sender 最低要求)
- BUY tx 是否被网络拒收 — 跑 `npm run health` 看 Executor error 列表
- Sender endpoint 是否在该机器可访问(`curl -v http://fra-sender.helius-rpc.com/fast` 应该 405 而不是 connection refused)

**Q: dashboard 显示亏损但实际盈利?**
A: v3.17 已修复 reconciler PnL bug。如果还遇到,看日志里 `reconciler found landed sell` 那行有没有 `fetchTxSwapResult` 报错。

**Q: 怎么把钱包里卡住的 token 卖掉?**
A: STUCK 仓位需要手动用 Pump.fun 或 Jupiter 卖。`scripts/stuck.js` 可以列出来。

**Q: 多 region 是不是必须的?**
A: 不是必须,但**强烈推荐**。单 region 时砸单 leader 不在你 region 会损失 0.5-1.5 秒。多 region 把这个尾延迟压平。代价是流量 credits ×N。

---

## 10. 升级流程(代码更新时)

```bash
cd /opt/dump-sniper
sudo -u ubuntu git pull
sudo -u ubuntu npm install --omit=dev   # 如果 package.json 变了
sudo systemctl restart dump-sniper
sudo journalctl -u dump-sniper -f
```

如果某次升级改了 `.env.example`,对比新增字段:
```bash
diff /opt/dump-sniper/.env.example /opt/dump-sniper/.env | head -50
```

---

## 11. 出问题怎么找原因(troubleshooting 速查表)

| 症状 | 第一步看哪里 |
|---|---|
| 服务启动失败 | `sudo journalctl -u dump-sniper --since "5 min ago"` |
| TickStream 不收 tx | dashboard 的 health panel → TickStream.txReceived 增长是否正常 |
| 总是触发 EMERGENCY | sql 查最近 10 笔 positions 看 entry_price vs sell_price 是否合理 |
| BUY 频繁 fail | `npm run health` → Executor.lastErrors |
| PnL 显示不对 | sql 直查 positions 表的 exit_sol / pnl_sol 字段 |
| Jito tip 像没生效(同 slot 率没提升) | dashboard 看 `Executor.jitoTipsSent` 增长,`Executor.senderRaceWonBy_*` 分布 |

---

完成。有问题先看 `UPGRADE_v3.17.md` 里的"已知限制 / 待办"章节,再去日志,再问。
