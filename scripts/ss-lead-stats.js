#!/usr/bin/env node
'use strict';

/**
 * ShredStream vs LaserStream 速度对比统计
 * 用法：
 * npm run ss-stats        # 拉一次当前 stats 快照
 * npm run ss-stats watch  # 每 60s 刷一次
 */

const http = require('http');

const PORT = parseInt(process.env.SERVER_PORT || process.env.DASHBOARD_PORT || '3001', 10);
const HOST = process.env.SERVER_HOST || '127.0.0.1';

function fetch(path) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: HOST, port: PORT, path, method: 'GET', timeout: 5000 },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          try { resolve(JSON.parse(body)); }
          catch (err) { reject(new Error(`bad response: ${body.slice(0, 200)}`)); }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end();
  });
}

async function getStats() {
  const data = await fetch('/api/health');
  const report = data && data.report ? data.report : null;
  if (!report) throw new Error('no health report in response');

  const ts = (report.modules || {}).TickStream || {};

  // Health API flattens counters/gauges directly on the module object
  // Keys like "TickStream.SS_lead_median_ms" or just "SS_lead_median_ms"
  function pick(...names) {
    for (const n of names) {
      if (ts[n] != null) return ts[n];
      const prefixed = `TickStream.${n}`;
      if (ts[prefixed] != null) return ts[prefixed];
    }
    return 0;
  }

  return {
    median: pick('SS_lead_median_ms'),
    p95: pick('SS_lead_p95_ms'),
    mean: pick('SS_lead_mean_ms'),
    samples: pick('SS_samples'),
    winPct: pick('SS_win_pct'),
    ssFirst: pick('SS_first_count'),
    lsFirst: pick('LS_first_count'),
    ssOrphan: pick('SS_orphan_count'),
    ssDedupFirst: pick('SS.dedup_first'),
    ssDedupDup: pick('SS.dedup_dup'),
    ssPumpTxs: pick('SS.pumpTxs'),
    pairsTotal: pick('SS_LS_pairs'),
    uptime: report.uptime_s || report.uptimeSec || 0,
  };
}

function fmt(s) {
  const lines = [];
  lines.push('═══════════════════════════════════════════════════════════════');
  lines.push(' ShredStream vs LaserStream 速度对比');
  lines.push('═══════════════════════════════════════════════════════════════');
  lines.push('');
  lines.push(` ⏱️ 服务运行时间: ${Math.round(s.uptime / 60)} 分钟`);
  lines.push('');
  lines.push(` 📊 配对样本数 (SS↔LS 都看到的 sig): ${s.samples}`);
  if (s.samples === 0) {
    lines.push('');
    lines.push(' ⚠️ 还没有配对样本。需要 ShredStream 和 LaserStream 同时跑');
    lines.push(' 一段时间才能对比两者速度。如果一直为 0,检查 SHREDSTREAM_PORT');
    lines.push(' 配置 + 端口是否被防火墙挡住。');
  } else {
    const sign = (v) => (v > 0 ? `+${v}` : `${v}`);
    lines.push('');
    lines.push(` 🎯 SS 领先时间 (正数 = SS 更快):`);
    lines.push(`   中位数 (p50): ${sign(s.median)} ms`);
    lines.push(`   平均值:       ${sign(s.mean)} ms`);
    lines.push(`   p95:          ${sign(s.p95)} ms`);
    lines.push('');
    lines.push(` 🏁 SS 先到比例: ${s.winPct}%`);
    if (s.winPct >= 60) {
      lines.push(' ✅ SS 速度优势明显,值得投入开发"SS 快速路径"');
    } else if (s.winPct >= 30) {
      lines.push(' ⚠️ SS 优势一般,可以测试更优的部署');
    } else {
      lines.push(' ❌ SS 没有速度优势,LS 多 region 已经足够');
    }
  }

  lines.push('');
  lines.push(` 📥 首次到达计数:`);
  lines.push(`   SS 先到: ${s.ssFirst}`);
  lines.push(`   LS 先到: ${s.lsFirst}`);
  const totalFirst = s.ssFirst + s.lsFirst;
  if (totalFirst > 0) {
    const ssRatio = Math.round((s.ssFirst / totalFirst) * 100);
    lines.push(`   SS 占比: ${ssRatio}%`);
  }
  lines.push('');
  lines.push(` 🐛 SS 孤儿 (SS 看到但 LS 30s 内没看到): ${s.ssOrphan}`);
  lines.push('');
  lines.push(` 📦 ShredStream 原始统计:`);
  lines.push(`   SS Pump tx 总数:         ${s.ssPumpTxs}`);
  lines.push(`   SS dedup 第一次到达:     ${s.ssDedupFirst}`);
  lines.push(`   SS dedup 后到 (重复):    ${s.ssDedupDup}`);
  lines.push('');
  lines.push('═══════════════════════════════════════════════════════════════');

  return lines.join('\n');
}

async function main() {
  const watch = process.argv[2] === 'watch';
  if (watch) {
    while (true) {
      try {
        const s = await getStats();
        console.clear();
        console.log(fmt(s));
        console.log(`\n下次刷新: 60 秒后 (Ctrl+C 退出)`);
      } catch (err) {
        console.error('错误:', err.message);
      }
      await new Promise((r) => setTimeout(r, 60_000));
    }
  } else {
    try {
      const s = await getStats();
      console.log(fmt(s));
    } catch (err) {
      console.error('错误:', err.message);
      console.error('确认 dump-sniper 服务正在运行,端口默认 3001');
      console.error('如果端口不同,设置环境变量 SERVER_PORT=xxxx');
      process.exit(1);
    }
  }
}

main();
