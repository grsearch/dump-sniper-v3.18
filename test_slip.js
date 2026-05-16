'use strict';
const http = require('http');
const { Connection, Keypair, VersionedTransaction, TransactionMessage, SystemProgram } = require('@solana/web3.js');
const bs58 = require('bs58').default || require('bs58');
require('dotenv').config();

function httpReq(method, url, apiKey, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = body ? JSON.stringify(body) : '';
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname,
      method,
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      timeout: 15000,
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(d) }); }
        catch(e) { resolve({ status: res.statusCode, data: d }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (data) req.write(data);
    req.end();
  });
}

async function test() {
  // 改读环境变量，避免硬编码 key 触发 GitHub Secret Scanning
  // 在 .env 里设置:
  //   ALLENHARK_SLIPSTREAM_API_KEY=sk_live_xxxx
  //   ALLENHARK_SLIPSTREAM_BASE_URL=http://<worker-ip>:9091
  const apiKey = process.env.ALLENHARK_SLIPSTREAM_API_KEY;
  const base = process.env.ALLENHARK_SLIPSTREAM_BASE_URL;
  if (!apiKey || !base) {
    console.error('Error: ALLENHARK_SLIPSTREAM_API_KEY and ALLENHARK_SLIPSTREAM_BASE_URL must be set in .env');
    process.exit(1);
  }

  // 1. Balance
  console.log('--- Balance ---');
  try {
    const r = await httpReq('GET', base + '/v1/balance', apiKey);
    console.log('Status:', r.status);
    console.log('Data:', JSON.stringify(r.data, null, 2));
  } catch(e) { console.log('Error:', e.message); }

  // 2. Senders
  console.log('\n--- Senders ---');
  try {
    const r = await httpReq('GET', base + '/v1/senders', apiKey);
    console.log('Status:', r.status, 'Count:', Array.isArray(r.data) ? r.data.length : 'n/a');
    if (Array.isArray(r.data)) r.data.forEach(s => console.log('  ', s.id, s.display_name, 'tip_wallet:', s.tip_wallet?.slice(0,12)+'..'));
    else console.log('Data:', JSON.stringify(r.data)?.slice(0,300));
  } catch(e) { console.log('Error:', e.message); }

  // 3. Build tx
  const secret = bs58.decode(process.env.WALLET_PRIVATE_KEY_BS58);
  const keypair = Keypair.fromSecretKey(secret);
  const rpc = new Connection('https://mainnet.helius-rpc.com/?api-key=' + process.env.HELIUS_API_KEY, 'confirmed');
  const { blockhash } = await rpc.getLatestBlockhash('confirmed');
  const ix = SystemProgram.transfer({ fromPubkey: keypair.publicKey, toPubkey: keypair.publicKey, lamports: 0 });
  const msg = new TransactionMessage({ payerKey: keypair.publicKey, recentBlockhash: blockhash, instructions: [ix] }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([keypair]);
  const txBase64 = Buffer.from(tx.serialize()).toString('base64');
  console.log('\nTx:', txBase64.length, 'chars, sig:', bs58.encode(tx.signature).slice(0,12)+'..');

  // 4. Slipstream submit
  console.log('\n--- Slipstream Submit ---');
  const t0 = Date.now();
  try {
    const r = await httpReq('POST', base + '/v1/transactions/submit', apiKey, {
      transaction: txBase64,
      options: { broadcast_mode: true, max_retries: 2, timeout_ms: 15000 },
    });
    console.log('Status:', r.status, '(' + (Date.now()-t0) + 'ms)');
    console.log('Data:', JSON.stringify(r.data, null, 2));
  } catch(e) { console.log('Error (' + (Date.now()-t0) + 'ms):', e.message); }

  // 5. Helius RPC
  console.log('\n--- Helius RPC ---');
  const t1 = Date.now();
  try {
    const sig = await rpc.sendRawTransaction(Buffer.from(tx.serialize()), { skipPreflight: true, maxRetries: 0 });
    console.log('OK (' + (Date.now()-t1) + 'ms):', sig.slice(0,20)+'..');
  } catch(e) { console.log('Error:', e.message); }

  process.exit(0);
}

test().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
