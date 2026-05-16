#!/usr/bin/env node
'use strict';

/**
 * 详细交易分析脚本（v3.17.7）
 *
 * 用法：
 *   cd /opt/dump-sniper
 *   node scripts/analyze.js [小时数=24]
 *
 * 输出：
 *   1. positions 全表（按时间倒序，所有字段）
 *   2. exit_reason 分布 + PnL 统计
 *   3. signals 接受/拒绝分布 + 拒绝原因细分
 *   4. 每笔 position 的完整时间线（OPEN → reconcile → SELL → reconcile）
 *   5. slot_gap 分布（信号延迟）
 *   6. 同卖家重复砸盘检测（看看 sellerMint 去重该不该启用）
 *   7. CSV 导出到 reports/analyze_<timestamp>.csv（便于 excel 看）
 *
 * 这个脚本不修改 DB，可以随时跑。
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const HOURS = parseInt(process.argv[2] || '24', 10);
const SINCE_MS = Date.now() - HOURS * 60 * 60 * 1000;

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'sniper.db');
if (!fs.existsSync(DB_PATH)) {
  console.error(`DB not found: ${DB_PATH}`);
  process.exit(1);
}

const db = new Database(DB_PATH, { readonly: true });
db.pragma('journal_mode = WAL');

console.log(`\n${'='.repeat(80)}`);
console.log(`详细交易分析（过去 ${HOURS} 小时）`);
console.log(`DB: ${DB_PATH}`);
console.log(`Since: ${new Date(SINCE_MS).toISOString()}`);
console.log(`${'='.repeat(80)}\n`);

// ====================================================================
// 1. positions 全表
// ====================================================================
console.log('📊 [1] Positions 全表\n');
const positions = db.prepare(`
  SELECT * FROM positions
  WHERE opened_at >= ?
  ORDER BY opened_at DESC
`).all(SINCE_MS);

console.log(`共 ${positions.length} 笔 positions`);
if (positions.length === 0) {
  console.log('过去时间窗口内没有任何 position,可以试 node scripts/analyze.js 168 看一周');
  process.exit(0);
}

console.log('');
for (const p of positions) {
  const opened = new Date(p.opened_at).toISOString().replace('T', ' ').slice(0, 19);
  const closed = p.closed_at ? new Date(p.closed_at).toISOString().replace('T', ' ').slice(0, 19) : '未关闭';
  const holdSec = p.closed_at ? Math.round((p.closed_at - p.opened_at) / 1000) : null;
  const pnlSol = p.pnl_sol !== null ? p.pnl_sol.toFixed(4) : '?';
  const pnlPct = p.pnl_pct !== null ? p.pnl_pct.toFixed(2) : '?';
  const dryRun = p.dry_run ? '🟡DRY' : '🟢LIVE';
  console.log(
    `  ${dryRun} ${p.symbol || p.mint.slice(0, 8)} | ` +
      `entrySol=${(p.entry_sol ?? 0).toFixed(4)} → exitSol=${(p.exit_sol ?? 0).toFixed(4)} | ` +
      `pnl=${pnlSol} SOL (${pnlPct}%) | ` +
      `${p.exit_reason || p.status || '?'} | ` +
      `hold=${holdSec ?? '?'}s | ${opened}`,
  );
}

// ====================================================================
// 2. exit_reason 分布 + PnL 统计
// ====================================================================
console.log('\n\n📈 [2] Exit reason 分布 + PnL 统计\n');
const exitDist = db.prepare(`
  SELECT
    COALESCE(exit_reason, status, 'unknown') AS reason,
    COUNT(*) AS n,
    ROUND(AVG(pnl_pct), 2) AS avg_pnl_pct,
    ROUND(SUM(pnl_sol), 4) AS total_pnl_sol,
    ROUND(MIN(pnl_pct), 2) AS min_pnl_pct,
    ROUND(MAX(pnl_pct), 2) AS max_pnl_pct
  FROM positions
  WHERE opened_at >= ? AND closed_at IS NOT NULL
  GROUP BY reason
  ORDER BY n DESC
`).all(SINCE_MS);

console.log('Exit Reason       | N  | Avg PnL%  | Total PnL SOL | Min%   | Max%');
console.log('------------------|----|-----------|---------------|--------|------');
for (const r of exitDist) {
  console.log(
    `${(r.reason || 'null').padEnd(18)}| ${String(r.n).padStart(2)} | ` +
      `${String(r.avg_pnl_pct ?? '?').padStart(9)} | ` +
      `${String(r.total_pnl_sol ?? '?').padStart(13)} | ` +
      `${String(r.min_pnl_pct ?? '?').padStart(6)} | ${r.max_pnl_pct ?? '?'}`,
  );
}

const totalPnl = exitDist.reduce((s, r) => s + (r.total_pnl_sol || 0), 0);
const totalN = exitDist.reduce((s, r) => s + r.n, 0);
console.log(`\n汇总: ${totalN} 笔已关闭, 总 PnL = ${totalPnl.toFixed(4)} SOL\n`);

// ====================================================================
// 3. signals 分布(接受 vs 拒绝原因)
// ====================================================================
console.log('\n📡 [3] Signals 分布(接受 vs 拒绝原因)\n');
const signalDist = db.prepare(`
  SELECT
    CASE WHEN accepted = 1 THEN 'ACCEPTED' ELSE COALESCE(reject_reason, 'rejected_unknown') END AS bucket,
    COUNT(*) AS n
  FROM signals
  WHERE ts >= ?
  GROUP BY bucket
  ORDER BY n DESC
`).all(SINCE_MS);

let totalSignals = 0;
for (const r of signalDist) totalSignals += r.n;

console.log(`共 ${totalSignals} 个 signal events 过去 ${HOURS} 小时:\n`);
for (const r of signalDist) {
  const pct = totalSignals > 0 ? ((r.n / totalSignals) * 100).toFixed(1) : '0';
  const truncated = (r.bucket || 'null').length > 50
    ? (r.bucket || 'null').slice(0, 47) + '...'
    : r.bucket || 'null';
  console.log(`  ${String(r.n).padStart(4)} (${pct.padStart(5)}%) | ${truncated}`);
}

// ====================================================================
// 4. 每笔 position 的详细时间线
// ====================================================================
console.log('\n\n🔍 [4] 每笔 position 的详细时间线\n');
for (const p of positions) {
  console.log(`\n--- ${p.symbol || p.mint.slice(0, 8)} (position_id=${p.position_id}) ---`);
  console.log(`  Mint:            ${p.mint}`);
  console.log(`  Status:          ${p.status || 'unknown'} / ${p.exit_reason || 'no exit_reason yet'}`);
  console.log(`  DRY_RUN:         ${p.dry_run ? 'yes' : 'no'}`);

  // BUY 信息
  console.log(`  --- BUY ---`);
  console.log(`  opened_at:       ${new Date(p.opened_at).toISOString()}`);
  console.log(`  entry_sol:       ${p.entry_sol ?? '?'}`);
  console.log(`  entry_price:     ${p.entry_price ?? '?'}`);
  console.log(`  token_amount:    ${p.token_amount ?? '?'}`);
  console.log(`  buy_signature:   ${p.buy_signature || '?'}`);

  // 对应的 signals
  const sigs = db.prepare(`
    SELECT * FROM signals
    WHERE mint = ? AND ts BETWEEN ? AND ?
    ORDER BY ts ASC
  `).all(p.mint, p.opened_at - 10_000, p.opened_at + 5_000);

  if (sigs.length > 0) {
    console.log(`  Related signals (within ±5s of OPEN):`);
    for (const s of sigs) {
      console.log(
        `    ${new Date(s.ts).toISOString().slice(11, 19)} | ${s.kind || '?'} | ` +
          `sellSol=${s.sell_sol?.toFixed(2)} | impact=-${s.price_impact_pct?.toFixed(2)}% | ` +
          `accepted=${s.accepted} | seller=${(s.seller || '').slice(0, 6)}.. | ` +
          `seller_tx=${(s.seller_tx || '').slice(0, 8)}.. ${s.reject_reason ? '| ' + s.reject_reason : ''}`,
      );
    }
  }

  // SELL 信息
  if (p.closed_at) {
    console.log(`  --- SELL ---`);
    console.log(`  closed_at:       ${new Date(p.closed_at).toISOString()}`);
    console.log(`  hold_seconds:    ${Math.round((p.closed_at - p.opened_at) / 1000)}`);
    console.log(`  exit_price:      ${p.exit_price ?? '?'}`);
    console.log(`  exit_sol:        ${p.exit_sol ?? '?'}`);
    console.log(`  exit_reason:     ${p.exit_reason || '?'}`);
    console.log(`  pnl_sol:         ${p.pnl_sol?.toFixed(4) ?? '?'}`);
    console.log(`  pnl_pct:         ${p.pnl_pct?.toFixed(2) ?? '?'}%`);
    console.log(`  sell_signature:  ${p.sell_signature || '?'}`);
    console.log(`  sell_attempts:   ${p.sell_attempts ?? 0}`);
  } else {
    console.log(`  --- POSITION STILL OPEN ---`);
  }
}

// ====================================================================
// 5. 同卖家重复砸盘检测
// ====================================================================
console.log('\n\n🚨 [5] 同卖家重复砸盘检测\n');
const repeatSellers = db.prepare(`
  SELECT seller, mint, symbol, COUNT(*) AS n,
         MIN(ts) AS first_ts, MAX(ts) AS last_ts,
         SUM(CASE WHEN accepted = 1 THEN 1 ELSE 0 END) AS n_accepted
  FROM signals
  WHERE ts >= ? AND seller IS NOT NULL AND mint IS NOT NULL
  GROUP BY seller, mint
  HAVING n > 1
  ORDER BY n DESC
  LIMIT 30
`).all(SINCE_MS);

if (repeatSellers.length === 0) {
  console.log('  无重复砸盘卖家(过去时间窗口内)');
} else {
  console.log('卖家×Mint     | 次数 | 已买入 | 时间跨度 | Symbol');
  console.log('--------------|------|--------|----------|--------');
  for (const r of repeatSellers) {
    const spanSec = Math.round((r.last_ts - r.first_ts) / 1000);
    console.log(
      `  ${r.seller.slice(0, 6)}..→${r.mint.slice(0, 6)}.. | ` +
        `${String(r.n).padStart(4)} | ${String(r.n_accepted).padStart(6)} | ` +
        `${String(spanSec).padStart(8)}s | ${r.symbol || '?'}`,
    );
  }
  console.log('\n  💡 如果"已买入"列出现 ≥ 2,说明同一卖家多次砸盘都被买入了 → SELLER_MINT_DEDUP_MS 是必要的');
}

// ====================================================================
// 6. CSV 导出
// ====================================================================
const reportsDir = path.join(__dirname, '..', 'reports');
if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
const csvPath = path.join(reportsDir, `analyze_${Date.now()}.csv`);
const headers = [
  'position_id', 'symbol', 'mint',
  'opened_at_iso', 'closed_at_iso', 'hold_seconds',
  'entry_sol', 'entry_price', 'token_amount',
  'exit_sol', 'exit_price', 'pnl_sol', 'pnl_pct',
  'exit_reason', 'status', 'sell_attempts', 'dry_run',
  'buy_signature', 'sell_signature',
];
const lines = [headers.join(',')];
for (const p of positions) {
  const row = [
    p.position_id,
    JSON.stringify(p.symbol || ''),
    p.mint,
    new Date(p.opened_at).toISOString(),
    p.closed_at ? new Date(p.closed_at).toISOString() : '',
    p.closed_at ? Math.round((p.closed_at - p.opened_at) / 1000) : '',
    p.entry_sol ?? '',
    p.entry_price ?? '',
    p.token_amount ?? '',
    p.exit_sol ?? '',
    p.exit_price ?? '',
    p.pnl_sol ?? '',
    p.pnl_pct ?? '',
    p.exit_reason || '',
    p.status || '',
    p.sell_attempts ?? '',
    p.dry_run || 0,
    p.buy_signature || '',
    p.sell_signature || '',
  ];
  lines.push(row.join(','));
}
fs.writeFileSync(csvPath, lines.join('\n'));
console.log(`\n\n✅ CSV 已导出: ${csvPath}`);
console.log(`   (用 Excel/Numbers 打开,或 scp 拉到本地分析)\n`);

db.close();
