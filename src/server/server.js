'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const { config } = require('../config');
const TokenRegistry = require('../data/TokenRegistry');

class Server {
  constructor({
    tokenRegistry,
    tradeLogger,
    positionManager,
    signalEngine,
    dailyReport,
    onTokenListChanged,
    onTokenAdded,
  }) {
    this.tokenRegistry = tokenRegistry;
    this.tradeLogger = tradeLogger;
    this.positionManager = positionManager;
    this.signalEngine = signalEngine;
    this.dailyReport = dailyReport;
    this.onTokenListChanged = onTokenListChanged;
    this.onTokenAdded = onTokenAdded;

    this.app = express();
    this.app.use(express.json({ limit: '64kb' }));

    // 可选：dashboard 访问保护（X-Dashboard-Token header / ?token= query）
    if (config.server.dashboardToken) {
      this.app.use('/api', this._authMiddleware());
      this.app.use('/dashboard.html', this._authMiddleware());
      this.app.use('/index.html', this._authMiddleware());
      this.app.use('/', (req, res, next) => {
        if (req.path === '/' || req.path === '/health') return next();
        return next();
      });
    }

    this.app.use(express.static(path.join(__dirname, 'public')));

    this._setupRoutes();

    this.httpServer = http.createServer(this.app);
    this.wss = new WebSocketServer({
      server: this.httpServer,
      path: '/ws',
      verifyClient: (info, cb) => {
        if (!config.server.dashboardToken) return cb(true);
        try {
          const url = new URL(info.req.url, 'http://localhost');
          const token = url.searchParams.get('token');
          if (token === config.server.dashboardToken) return cb(true);
          return cb(false, 401, 'Unauthorized');
        } catch (_) {
          return cb(false, 401, 'Unauthorized');
        }
      },
    });
    this.wss.on('connection', (ws) => {
      ws.send(JSON.stringify({ type: 'hello', dryRun: config.DRY_RUN, ts: Date.now() }));
    });
  }

  _authMiddleware() {
    const token = config.server.dashboardToken;
    return (req, res, next) => {
      const provided = req.headers['x-dashboard-token'] || req.query.token;
      if (provided !== token) {
        return res.status(401).json({ ok: false, error: 'unauthorized' });
      }
      next();
    };
  }

  _validateWebhookSecret(req) {
    if (!config.server.webhookSecret) return true; // 未配置则跳过
    const provided =
      req.headers['x-webhook-secret'] ||
      req.headers['authorization']?.replace(/^Bearer\s+/i, '');
    return provided === config.server.webhookSecret;
  }

  _setupRoutes() {
    const app = this.app;

    // ============ Webhook ============
    app.post('/webhook/add-token', async (req, res) => {
      try {
        if (!this._validateWebhookSecret(req)) {
          return res.status(401).json({ ok: false, error: 'invalid webhook secret' });
        }
        const { network, address, symbol } = req.body || {};
        if (network && network.toLowerCase() !== 'solana') {
          return res.status(400).json({ ok: false, error: 'only solana network supported' });
        }
        if (!address || typeof address !== 'string') {
          return res.status(400).json({ ok: false, error: 'address required' });
        }
        try {
          TokenRegistry.validateMint(address);
        } catch (err) {
          return res.status(400).json({ ok: false, error: err.message });
        }

        // Max token rotation: if at capacity, evict lowest-value tokens
        const evicted = await this._evictIfNeeded(address);

        const token = await this.tokenRegistry.addToken(address, { symbol, source: 'webhook' });
        if (this.onTokenListChanged) this.onTokenListChanged();
        if (this.onTokenAdded) this.onTokenAdded(token);
        this.broadcast({ type: 'tokenAdded', token });
        const resp = { ok: true, token };
        if (evicted.length > 0) {
          resp.evicted = evicted;
          console.log(
            `[webhook] evicted ${evicted.length} token(s) to make room: ` +
            evicted.map(e => `${e.symbol}(${e.reason})`).join(', '),
          );
        }
        res.json(resp);
      } catch (err) {
        console.error(`[webhook] add-token error: ${err.message}`);
        res.status(500).json({ ok: false, error: err.message });
      }
    });

    // ============ Token list ============
    app.get('/api/tokens', (req, res) => {
      res.json({ ok: true, tokens: this.tokenRegistry.listAll() });
    });

    app.post('/api/tokens', async (req, res) => {
      try {
        const { address, symbol } = req.body || {};
        if (!address) return res.status(400).json({ ok: false, error: 'address required' });
        try {
          TokenRegistry.validateMint(address);
        } catch (err) {
          return res.status(400).json({ ok: false, error: err.message });
        }
        const token = await this.tokenRegistry.addToken(address, { symbol, source: 'manual' });
        if (this.onTokenListChanged) this.onTokenListChanged();
        if (this.onTokenAdded) this.onTokenAdded(token);
        this.broadcast({ type: 'tokenAdded', token });
        res.json({ ok: true, token });
      } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
      }
    });

    /**
     * 批量添加：避免每次添加都触发 LaserStream 重建。
     * Body: { tokens: [{ address, symbol }, ...] }
     */
    app.post('/api/tokens/batch', async (req, res) => {
      try {
        const { tokens } = req.body || {};
        if (!Array.isArray(tokens) || tokens.length === 0) {
          return res.status(400).json({ ok: false, error: 'tokens array required' });
        }

        // Pre-evict to make room for all incoming tokens at once
        const newMints = tokens.map(t => t.address).filter(m => {
          try { TokenRegistry.validateMint(m); return true; } catch (_) { return false; }
        });
        const allEvicted = [];
        for (const mint of newMints) {
          const evicted = await this._evictIfNeeded(mint);
          allEvicted.push(...evicted);
        }
        if (allEvicted.length > 0) {
          console.log(
            `[batch] evicted ${allEvicted.length} token(s): ` +
            allEvicted.map(e => `${e.symbol}(${e.reason})`).join(', '),
          );
        }

        const results = [];
        const errors = [];
        for (const t of tokens) {
          try {
            TokenRegistry.validateMint(t.address);
            const token = await this.tokenRegistry.addToken(t.address, {
              symbol: t.symbol,
              source: 'batch',
            });
            results.push(token);
            if (this.onTokenAdded) this.onTokenAdded(token);
          } catch (err) {
            errors.push({ address: t.address, error: err.message });
          }
        }
        // 全部加完后只通知一次（重建 LaserStream 一次）
        if (this.onTokenListChanged) this.onTokenListChanged();
        this.broadcast({ type: 'tokensAdded', count: results.length });
        const resp = { ok: true, added: results.length, failed: errors.length, errors };
        if (allEvicted.length > 0) resp.evicted = allEvicted;
        res.json(resp);
      } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
      }
    });

    app.delete('/api/tokens/:mint', (req, res) => {
      try {
        this.tokenRegistry.removeToken(req.params.mint);
        if (this.onTokenListChanged) this.onTokenListChanged();
        this.broadcast({ type: 'tokenRemoved', mint: req.params.mint });
        res.json({ ok: true });
      } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
      }
    });

    // ============ Logs ============
    app.get('/api/signals', (req, res) => {
      const limit = parseInt(req.query.limit || '100', 10);
      res.json({ ok: true, signals: this.tradeLogger.getRecentSignals(limit) });
    });

    app.get('/api/trades', (req, res) => {
      const limit = parseInt(req.query.limit || '100', 10);
      res.json({ ok: true, trades: this.tradeLogger.getRecentTrades(limit) });
    });

    app.get('/api/positions', (req, res) => {
      const limit = parseInt(req.query.limit || '100', 10);
      res.json({
        ok: true,
        open: this.positionManager.listOpen(),
        recent: this.tradeLogger.getRecentPositions(limit),
        stuck: this.tradeLogger.getStuckPositions(),
      });
    });

    // ============ Manual report trigger ============
    app.post('/api/reports/generate', async (req, res) => {
      try {
        const { date } = req.body || {};
        const target = date ? new Date(date) : new Date(Date.now() - 24 * 60 * 60 * 1000);
        const filepath = await this.dailyReport.generateForDate(target);
        res.json({ ok: true, filepath });
      } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
      }
    });

    // ============ Status ============
    app.get('/api/status', (req, res) => {
      res.json({
        ok: true,
        dryRun: config.DRY_RUN,
        watchedTokens: this.tokenRegistry.listActive().length,
        openPositions: this.positionManager.openPositionCount(),
        config: {
          minSellSol: config.strategy.minSellSol,
          minPriceImpactPct: config.strategy.minPriceImpactPct,
          positionSizeSol: config.strategy.positionSizeSol,
          takeProfitPct: config.strategy.takeProfitPct,
          maxHoldMs: config.strategy.maxHoldMs,
        },
      });
    });

    app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

    // ============ 健康监控 ============
    app.get('/api/health', (req, res) => {
      const { getMonitor } = require('../monitor/HealthMonitor');
      res.json({ ok: true, report: getMonitor().report() });
    });

    app.get('/api/health/summary', (req, res) => {
      const { getMonitor } = require('../monitor/HealthMonitor');
      res.type('text/plain').send(getMonitor().summary());
    });
  }

  /**
   * Max token rotation: evict tokens when at capacity (default 95).
   * Priority: tokens with NO trade history first, sorted by 24h volume ascending.
   * If all tokens have trade history, evict the one with lowest 24h volume.
   * Never evict the incoming mint (already being added).
   * @param {string} incomingMint - the mint about to be added
   * @returns {Array<{mint, symbol, reason}>} evicted tokens
   */
  async _evictIfNeeded(incomingMint) {
    const MAX_TOKENS = parseInt(process.env.MAX_WATCHED_TOKENS || '95', 10);
    const currentTokens = this.tokenRegistry.listAll().filter(t => t.is_active);
    const currentCount = currentTokens.length;

    // If incoming mint already exists, no need to evict
    if (currentTokens.some(t => t.mint === incomingMint)) return [];

    if (currentCount < MAX_TOKENS) return [];

    // Get mints with trade history (accepted signals or positions)
    const tradeLogger = this.tradeLogger;
    const mintsTraded = new Set(
      tradeLogger.db
        .prepare('SELECT DISTINCT mint FROM positions UNION SELECT DISTINCT mint FROM signals WHERE accepted = 1')
        .all()
        .map(r => r.mint),
    );

    // Build candidates with volume info
    const candidates = currentTokens
      .filter(t => t.mint !== incomingMint)
      .map(t => {
        let vol24h = 0;
        try {
          const meta = t.meta_json ? JSON.parse(t.meta_json) : {};
          vol24h = meta.volume24h || 0;
        } catch (_) {}
        return {
          mint: t.mint,
          symbol: t.symbol || '???',
          vol24h,
          hasTrades: mintsTraded.has(t.mint),
        };
      });

    // Sort: no-trade first, then by vol24h ascending
    candidates.sort((a, b) => {
      if (a.hasTrades !== b.hasTrades) return a.hasTrades ? 1 : -1; // no-trade first
      return a.vol24h - b.vol24h; // lower volume first
    });

    // Evict how many?
    const slotsNeeded = currentCount + 1 - MAX_TOKENS;
    const toEvict = candidates.slice(0, Math.max(1, slotsNeeded));

    const evicted = [];
    for (const t of toEvict) {
      this.tokenRegistry.removeToken(t.mint);
      evicted.push({
        mint: t.mint,
        symbol: t.symbol,
        reason: t.hasTrades ? `low_vol(${t.vol24h.toFixed(0)})` : 'no_trades',
      });
    }

    return evicted;
  }

  broadcast(message) {
    const data = JSON.stringify(message);
    for (const client of this.wss.clients) {
      if (client.readyState === 1) {
        try { client.send(data); } catch (_) {}
      }
    }
  }

  start() {
    const host = config.server.bindHost || '0.0.0.0';
    this.httpServer.listen(config.server.port, host, () => {
      console.log(`[Server] listening on ${host}:${config.server.port}`);
      console.log(`[Server] dashboard: http://${host}:${config.server.port}`);
      console.log(`[Server] webhook:   POST http://${host}:${config.server.port}/webhook/add-token`);
      if (config.server.webhookSecret) console.log('[Server] webhook secret: ENABLED');
      if (config.server.dashboardToken) console.log('[Server] dashboard auth: ENABLED');
    });
  }
}

module.exports = Server;
