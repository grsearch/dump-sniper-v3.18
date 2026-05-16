# v3.18 Week 2 — ShredStream.com SDK 接入

## 修正说明

最初 Week 2 设计基于 **Jito 官方 ShredStream Proxy** (`jitolabs/jito-shredstream-proxy` docker),
需要自己写 bincode 解码 + gRPC client。

**最终采用 ShredStream.com SDK** (你订阅的服务) — 完全不同的方案,**简单 10 倍**:
- 不需要 docker proxy
- 不需要 bincode 解码 (`npm shredstream` SDK 用 napi-rs Rust 模块自动 deshred)
- 直接 UDP socket → `ShredListener.bind(port)` → 迭代 batch.transactions (已经是 wire-format)

旧的 `entryDecoder.js` / `shredstream.proto` 已删除。

---

## Week 2 交付清单

### 新增文件

**`src/data/ShredStreamSource.js`** (~200 行)

ShredStream.com SDK 包装:
- `ShredListener.bindWithOptions(port, { recvBuf, busyPollUs, enableFec })`
- 异步消费循环 `await listener.nextTransaction()`
- 字节级 program filter (扫描 wire tx 中是否含 Pump AMM program pubkey,
  99% 无关 tx 在这步丢弃)
- emit `transaction` 事件: `{ slot, signature, txIndex, wireBytes, ts, source }`
- HealthMonitor 集成 (txsReceived, txEmitted, txFilteredOut, latestSlot)
- `getMetrics()` 透传 SDK 内部 Rust 指标 (dataShreds, fecRecoveries, lastIoError 等)
- 优雅停止 + 失败时让 systemd 重启进程 (SDK 文档推荐)

### 修改文件

**`src/index.js`**

启动时按 `SHREDSTREAM_ENABLED=true` 启用 ShredStreamSource:
- UDP 监听端口由 `SHREDSTREAM_PORT` 控制 (默认 8001)
- 每 60s 报告一次 Pump AMM tx 计数
- shutdown 时优雅停止

**`.env.example`**

新增 ShredStream.com 配置:
- `SHREDSTREAM_ENABLED` (默认 false)
- `SHREDSTREAM_PORT` (默认 8001)
- `SHREDSTREAM_RECV_BUF_BYTES` (默认 64 MB)
- `PUMP_AMM_PROGRAM_ID`

**`package.json`**

已有依赖 `"shredstream": "^2.0.0"` (无需添加, Openclaw 之前订阅时已加)

### 不变 / 待 Week 3 做

- ❌ DumpDetector 暂未接入 ShredStream (Week 3 完成)
- ❌ SignalEngine 暂未携带 dumpTxRaw (Week 3 完成)
- ❌ buyBundle 暂未实战触发 (Week 3 完成)

Week 2 数据流: **ShredStream.com → SDK → ShredStreamSource → 仅 log + counter, 不触发交易**

---

## 部署: ShredStream.com 配置

### 1. 注册账户 + 启动 Shred Stream

去 https://www.shredstream.com/ :
1. 创建账户 (Discord 联系可以申请免费 trial)
2. 进 dashboard, 点 "Launch Shred Stream"
3. 选区域: **Frankfurt** (你服务器在 FRA, 距离最近, 延迟最低)
4. 输入接收 shreds 的目标信息:
   - **Server IP**: 你服务器的公网 IP (`curl ifconfig.me`)
   - **UDP Port**: 任选, e.g. 8001 (跟 sniper bot 的 SHREDSTREAM_PORT 一致)
5. 启动 stream, dashboard 会显示状态 (active / inactive)

### 2. 服务器配置

```bash
# 1. 防火墙 allow 入站 UDP
sudo ufw allow 8001/udp
# 或 iptables:
sudo iptables -A INPUT -p udp --dport 8001 -j ACCEPT

# 验证 dashboard 推流到达服务器
sudo tcpdump -i any udp port 8001 -c 5
# 应该看到 ShredStream.com 服务器的 IP 推 UDP 包过来

# 2. 调大 socket recv buffer (SDK 文档要求 ≥ 64MB)
sudo sysctl -w net.core.rmem_max=67108864
sudo sysctl -w net.core.busy_read=200
# 永久生效:
echo "net.core.rmem_max=67108864" | sudo tee -a /etc/sysctl.conf
echo "net.core.busy_read=200" | sudo tee -a /etc/sysctl.conf

# 3. 装 SDK (在 sniper bot 目录)
cd /opt/dump-sniper-v3
npm install
# package.json 已有 "shredstream": "^2.0.0", npm install 会自动装
# shredstream SDK 是 napi-rs Rust 原生模块, 第一次安装会下载 prebuilt binary
```

### 3. 在 sniper 启用 ShredStream

修改 `/opt/dump-sniper-v3/.env`:
```bash
SHREDSTREAM_ENABLED=true
SHREDSTREAM_PORT=8001    # 跟 dashboard 一致
SHREDSTREAM_RECV_BUF_BYTES=67108864

# Bundle 模式暂不启用 (Week 3 后再开)
USE_BUNDLE_MODE=false
```

重启:
```bash
sudo systemctl restart dump-sniper
sudo journalctl -u dump-sniper -f --since "1 min ago"
```

### 4. 预期日志

启动:
```
[ShredStreamSource] listening on UDP 0.0.0.0:8001 (recvBuf=64MB, busyPoll=200us)
[main] ShredStream enabled, UDP port=8001, program filter=pAMMBa..
```

60s 后:
```
[main] ShredStream: 247 Pump AMM tx received in last 60s (latest slot=298765)
```

如果 60s 内 0 个 tx:
- 检查 dashboard stream 状态是否 active
- `sudo tcpdump -i any udp port 8001` 看是否真有 UDP 流量
- 防火墙是否放开 → `sudo iptables -L | grep 8001`
- sysctl rmem_max 是否调大 → `sysctl net.core.rmem_max`

如果数量太少 (< 50/min):
- 全网 Pump AMM tx 每分钟数百-数千条,你只收到几十条说明丢包严重
- 调大 recvBuf 到 128 MB: `SHREDSTREAM_RECV_BUF_BYTES=134217728`
  + sysctl `net.core.rmem_max=134217728`

---

## Week 2 测试

### 本地无法跑端到端测试

`shredstream` SDK 是 napi-rs Rust 原生模块, 必须在 Linux x64 服务器才能装。
本地开发环境装不上 / 装上也没有真实 UDP 流量。

测试只在服务器上跑 (Openclaw 部署后):
- 启动后看日志是否正常 bind UDP port
- 60s 后看 Pump AMM tx 计数

### 已通过的本地测试

- ✓ 32/32 语法检查
- ✓ ShredStreamSource 模块加载逻辑 (SDK 缺失时 throw 清晰错误)
- ✓ program filter 字节扫描算法 (跟 Jito 官方版本验证过, round-trip 通过)

---

## Week 3 准备

Week 3 任务:
1. **DumpDetector raw bytes 路径**:
   当前 DumpDetector 解析 LaserStream confirmed tx (含 meta.preTokenBalances)。
   从 ShredStream 收到的是无 meta 的 wire-format tx, 需要:
   - 用 `VersionedTransaction.deserialize` 解码 tx
   - 找出 Pump AMM swap instruction
   - 从 instruction data 反序列化得 `amount_in`, `min_amount_out`, `direction`
   - 结合 PoolStateCache 当前 pool reserves 预测交易后影响 (priceImpact)
2. **SignalEngine 传 dumpTxRaw**:
   dumpSignal 字段加 `dumpTxRaw: Buffer`, 给 Executor.buyBundle 用
3. **TickStream 集成 (可选)**:
   ShredStream tx 也走 dedup, 跟 LaserStream 信号合并
4. **完整集成测试**:
   服务器跑 24h, 确认 ShredStream → DumpDetector → buyBundle(DRY_RUN) 端到端工作

**需要 Openclaw 提供**:
- 1-2 笔真实 Pump AMM 砸盘 tx 的 raw bytes 样本 (从服务器拉)
- @pump-fun/pump-swap-sdk 里的 swap instruction IDL

预计 Week 3 工时: 5-7 天

---

## 部署清单 (Openclaw)

```bash
# === 阶段 A: 升级到 v3.18 Week 2 (不启用 ShredStream, 验证不退化) ===
cd /opt
sudo cp -r dump-sniper-v3 dump-sniper-v3.backup-w2-$(date +%Y%m%d)
sudo systemctl stop dump-sniper
cd dump-sniper-v3
sudo tar -xzf /tmp/dump-sniper-v3.18-week2.tar.gz --strip-components=1
sudo npm install
# 不改 .env, 保持 SHREDSTREAM_ENABLED=false
sudo systemctl start dump-sniper
sudo journalctl -u dump-sniper -f --since "1 min ago" | head -30
# 预期: 启动正常, 行为跟 v3.18 Week 1 一致

# 跑 24 小时确认稳定

# === 阶段 B: 在 ShredStream.com 启动 stream ===
# 1) 注册账户 + 启动 Shred Stream (region: Frankfurt, port: 8001)
# 2) 防火墙 + sysctl 配置 (见上)

# === 阶段 C: 在 sniper 启用 ShredStream ===
# 修改 .env:
cat >> /opt/dump-sniper-v3/.env <<EOF
SHREDSTREAM_ENABLED=true
SHREDSTREAM_PORT=8001
SHREDSTREAM_RECV_BUF_BYTES=67108864
EOF
sudo systemctl restart dump-sniper

# 60s 后应看到:
# [ShredStreamSource] listening on UDP 0.0.0.0:8001
# [main] ShredStream: NN Pump AMM tx received in last 60s

# 跑 24-48 小时观察 tx 计数稳定 (期望 100-500/min Pump AMM tx)
```

---

## 风险

- **部署风险**: 极低, `SHREDSTREAM_ENABLED=false` 默认关闭
- **数据风险**: 即使 ShredStream 启用, 也只是 log + counter, 不触发交易, Week 3 才接业务
- **成本**: ShredStream.com $70/天 trial (5-7 天 ≈ $350-490) 或正式套餐月费

---

## 已删除的代码

由于切到 ShredStream.com SDK, 以下为 Jito 官方 ShredStream 写的代码已删除:
- `src/data/entryDecoder.js` (bincode parser)
- `src/proto/shredstream.proto` (gRPC schema)
- 旧版本 `src/data/ShredStreamSource.js` (gRPC client)

如果后续想切换到 Jito 官方 ShredStream Proxy (例如想自建 proxy 不依赖第三方),
可以从 v3.18-week2-prerelease backup 包恢复这些文件。
