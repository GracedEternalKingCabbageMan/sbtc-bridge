// SBTC bridge — an independent, application-level BTC<->SBTC custody bridge for Sequentia.
//
// SBTC is a NORMAL reissuable Sequentia asset (its reissuance token lives in this bridge's
// Sequentia wallet). The reserve BTC lives in an N-of-M multisig on Bitcoin (testnet4). This
// service is the ONLY thing that mints/burns SBTC and moves the reserve, and it does so 1:1:
//
//   PEG-IN   real BTC deposited to a bridge address  ->  reissue SBTC 1:1 to the user on Sequentia
//   PEG-OUT  SBTC returned to a bridge address        ->  release reserve BTC 1:1 to the user on Bitcoin
//
// It hand-rolls no crypto: the Sequentia node signs the reissuance/send, and bitcoind (with the
// multisig descriptor) signs the reserve release via PSBT. It is a trusted bridge — users trust
// the N operators to keep the reserve 1:1 and not abscond (no BTC peg can be trustless without
// Bitcoin covenants). See ../SequentiaByClaude/doc/sequentia/sbtc-peg-design.md.
//
// SECURITY INVARIANTS (enforced below):
//  - Idempotent: every BTC deposit (by outpoint) and every SBTC return (by outpoint) is processed
//    AT MOST ONCE — a persisted `done` set keyed by outpoint gates both directions.
//  - 1:1 only: SBTC is reissued ONLY against a CONFIRMED BTC deposit, for exactly its sats; reserve
//    BTC is released ONLY against a CONFIRMED SBTC return, for exactly its sats (minus the BTC fee).
//  - No unbacked mint, no double-release: state is written to disk BEFORE the irreversible action's
//    broadcast where possible, and the outpoint is marked done so a crash-restart never repeats it.

import http from 'node:http';
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const CFG_PATH = process.env.SBTC_BRIDGE_CONFIG || join(HERE, 'config.json');
const STATE_PATH = process.env.SBTC_BRIDGE_STATE || join(HERE, 'state.json');

// ---- config -----------------------------------------------------------------
// config.json (see config.example.json):
//   seq: { rpc, wallet, sbtc_asset, fee_asset, min_conf }   — the Sequentia node holding SBTC's reissuance token; fee_asset (USDX) pays all fees (never the Sequence token)
//   btc: { rpc, wallet, multisig_desc, change_addr, min_conf, fee_sat_vb } — bitcoind testnet4 + the reserve multisig descriptor
//   http: { host, port, token }
const CFG = JSON.parse(readFileSync(CFG_PATH, 'utf8'));
const SEQ = CFG.seq, BTC = CFG.btc, HTTPCFG = CFG.http || {};
const SEQ_MIN_CONF = Number(SEQ.min_conf ?? 1);
const BTC_MIN_CONF = Number(BTC.min_conf ?? 2);

// ---- persisted state --------------------------------------------------------
// { pegins:  { [btcDepositAddr]: { seq_recipient, created } },
//   pegouts: { [seqReturnAddr]: { btc_dest, created } },
//   done:    { ["btc:"+txid+":"+vout]: creditTxid, ["seq:"+txid+":"+vout]: releaseTxid },
//   next_index: n }
function loadState() {
  if (!existsSync(STATE_PATH)) return { pegins: {}, pegouts: {}, done: {}, next_index: 0 };
  try { return JSON.parse(readFileSync(STATE_PATH, 'utf8')); }
  catch { throw new Error('state.json is corrupt — refusing to run a custody service on unreadable state'); }
}
let STATE = loadState();
function saveState() {
  // atomic write: tmp + rename, so a crash never leaves half-written custody state.
  const tmp = STATE_PATH + '.tmp';
  writeFileSync(tmp, JSON.stringify(STATE, null, 2));
  renameSync(tmp, STATE_PATH);
}

// ---- JSON-RPC ---------------------------------------------------------------
async function rpc(url, method, params = [], wallet) {
  const base = wallet ? url.replace(/\/?$/, '') + '/wallet/' + encodeURIComponent(wallet) : url;
  const res = await fetch(base, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '1.0', id: 'sbtc-bridge', method, params }),
    signal: AbortSignal.timeout(30000),
  });
  const j = await res.json().catch(() => ({ error: { message: 'bad json (HTTP ' + res.status + ')' } }));
  if (j.error) throw new Error(`${method}: ${j.error.message || JSON.stringify(j.error)}`);
  return j.result;
}
const seqrpc = (m, p) => rpc(SEQ.rpc, m, p, SEQ.wallet);
const btcrpc = (m, p) => rpc(BTC.rpc, m, p, BTC.wallet);

const log = (...a) => console.log(new Date().toISOString(), '[sbtc-bridge]', ...a);
const err = (...a) => console.error(new Date().toISOString(), '[sbtc-bridge]', ...a);
const doneKey = (chain, txid, vout) => `${chain}:${txid}:${vout}`;
const sat = (btc) => Math.round(Number(btc) * 1e8);       // BTC-float -> sats (both chains use 8dp)
const btcAmt = (sats) => (Number(sats) / 1e8).toFixed(8); // sats -> 8dp string

// ---- PEG-IN: real BTC deposit -> reissue SBTC 1:1 -----------------------------
// A user asks for a fresh deposit address bound to their Sequentia recipient. When BTC lands there
// (confirmed), we reissue exactly that many SBTC sats to the recipient. SBTC is minted ONLY here,
// ONLY against a confirmed deposit — so total SBTC supply always equals the reserve BTC.
async function newPeginAddress(seqRecipient) {
  // A fresh multisig deposit address from the reserve wallet's ranged descriptor. It IS a reserve
  // address (the deposit becomes reserve backing); the label records which recipient it credits.
  const label = 'pegin:' + seqRecipient;
  const addr = await btcrpc('getnewaddress', [label]);   // wallet is a descriptor wallet over multisig_desc
  STATE.pegins[addr] = { seq_recipient: seqRecipient, created: Math.floor(Date.now() / 1000) };
  saveState();
  log('peg-in address', addr, '->', seqRecipient);
  return addr;
}
async function scanPegins() {
  // Confirmed UTXOs sitting at our peg-in deposit addresses = new reserve deposits to credit.
  const utxos = await btcrpc('listunspent', [BTC_MIN_CONF, 9999999, Object.keys(STATE.pegins)]);
  for (const u of utxos || []) {
    const key = doneKey('btc', u.txid, u.vout);
    if (STATE.done[key]) continue;                       // already credited
    const bind = STATE.pegins[u.address];
    if (!bind) continue;                                 // not a peg-in address (change/other)
    const sats = sat(u.amount);
    if (sats <= 0) continue;
    try {
      // Reissue exactly `sats` SBTC, then send them to the recipient (fee paid in the policy asset,
      // NOT deducted from SBTC, so the user is credited 1:1). Mark done BEFORE returning so a
      // crash-restart never re-credits this outpoint. (reissue+send are separate txs; the mark
      // covers the whole credit — a partial crash is reconciled by the idempotent `done` gate.)
      STATE.done[key] = 'crediting'; saveState();
      const need = Number(btcAmt(sats));
      // RECYCLE: spend SBTC the bridge already holds (float returned by prior peg-outs) and mint ONLY
      // the shortfall, so supply tracks peak circulation instead of inflating on every peg-in. ALL
      // fees are paid in SEQ.fee_asset (USDX) — the bridge never holds the Sequence token (Principle
      // 3/4: SEQ has no privileged fee standing). reissueasset params: [asset, amount, fee_asset].
      let held = 0; try { held = Number((await seqrpc('getbalance', []))[SEQ.sbtc_asset] || 0); } catch {}
      const shortfall = need - held;
      if (shortfall > 1e-8) await seqrpc('reissueasset', [SEQ.sbtc_asset, Number(shortfall.toFixed(8)), SEQ.fee_asset]);
      // sendtoaddress params: [address, amount, comment, comment_to, subtractfee, replaceable,
      // conf_target, estimate_mode, avoid_reuse, assetlabel, ignoreblindfail, fee_rate, fee_asset_label].
      const sendTxid = await seqrpc('sendtoaddress',
        [bind.seq_recipient, need, '', '', false, true, null, 'unset', false, SEQ.sbtc_asset, true, null, SEQ.fee_asset]);
      STATE.done[key] = sendTxid; saveState();
      log('PEG-IN', u.txid + ':' + u.vout, btcAmt(sats), 'BTC ->', sats, 'SBTC to', bind.seq_recipient, 'tx', sendTxid);
    } catch (e) {
      STATE.done[key] = ''; delete STATE.done[key]; saveState();   // leave un-done so the next scan retries
      err('peg-in credit failed for', u.txid + ':' + u.vout, '-', e.message);
    }
  }
}

// ---- PEG-OUT: SBTC returned -> release reserve BTC 1:1 ------------------------
// A user asks for a fresh Sequentia address bound to their Bitcoin destination. When SBTC lands there
// (confirmed), we release exactly that many BTC sats (minus the Bitcoin fee) from the reserve multisig,
// and BURN the returned SBTC so supply keeps tracking the reserve.
async function newPegoutAddress(btcDest) {
  const addr = await seqrpc('getnewaddress', ['pegout:' + btcDest]);
  STATE.pegouts[addr] = { btc_dest: btcDest, created: Math.floor(Date.now() / 1000) };
  saveState();
  log('peg-out address', addr, '->', btcDest);
  return addr;
}
async function scanPegouts() {
  const addrs = Object.keys(STATE.pegouts);
  if (!addrs.length) return;
  // Confirmed SBTC UTXOs at our peg-out addresses = SBTC the user handed back for real BTC.
  const utxos = await seqrpc('listunspent', [SEQ_MIN_CONF, 9999999, addrs, false, { asset: SEQ.sbtc_asset }]);
  for (const u of utxos || []) {
    if (u.asset !== SEQ.sbtc_asset) continue;
    const key = doneKey('seq', u.txid, u.vout);
    if (STATE.done[key]) continue;
    const bind = STATE.pegouts[u.address];
    if (!bind) continue;
    const sats = sat(u.amount);
    if (sats <= 0) continue;
    try {
      STATE.done[key] = 'releasing'; saveState();
      // Release `sats` BTC from the reserve multisig to the user's Bitcoin destination. bitcoind's
      // wallet (holding the multisig descriptor) selects reserve UTXOs, adds change back to the
      // multisig, and takes the BTC fee from the released amount (subtractFeeFromOutputs) so the
      // reserve is never drawn below the SBTC it backs.
      const funded = await btcrpc('walletcreatefundedpsbt',
        [[], [{ [bind.btc_dest]: Number(btcAmt(sats)) }], 0,
         { subtractFeeFromOutputs: [0], changeAddress: BTC.change_addr, ...(BTC.fee_sat_vb ? { fee_rate: BTC.fee_sat_vb } : {}) }]);
      const processed = await btcrpc('walletprocesspsbt', [funded.psbt]);
      const fin = await btcrpc('finalizepsbt', [processed.psbt]);
      if (!fin.complete) throw new Error('reserve release PSBT not fully signed (need more operator co-signers)');
      const releaseTxid = await btcrpc('sendrawtransaction', [fin.hex]);
      // RECYCLE (not burn): the returned SBTC stays in the bridge wallet as float for future peg-ins.
      // We do NOT destroyamount — it cannot take a fee asset, so it would force the bridge to hold the
      // Sequence token just to pay a burn fee. Circulating SBTC still equals reserve BTC (the held
      // float is out of circulation); the next peg-in spends this float before minting anything new.
      STATE.done[key] = releaseTxid; saveState();
      log('PEG-OUT', u.txid + ':' + u.vout, sats, 'SBTC ->', btcAmt(sats), 'BTC to', bind.btc_dest, 'tx', releaseTxid);
    } catch (e) {
      STATE.done[key] = ''; delete STATE.done[key]; saveState();
      err('peg-out release failed for', u.txid + ':' + u.vout, '-', e.message);
    }
  }
}

// ---- HTTP API ---------------------------------------------------------------
// POST /pegin  { seq_recipient }  -> { deposit_address }   (send real BTC here; SBTC is credited on confirm)
// POST /pegout { btc_dest }       -> { sbtc_address }       (send SBTC here; real BTC is released on confirm)
// GET  /status                    -> counts + reserve/supply sanity
function readBody(req) {
  return new Promise((res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { try { res(b ? JSON.parse(b) : {}); } catch { res(null); } }); });
}
function send(res, code, obj) { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); }
const server = http.createServer(async (req, res) => {
  try {
    if (HTTPCFG.token && req.headers.authorization !== 'Bearer ' + HTTPCFG.token) return send(res, 401, { ok: false, error: 'unauthorized' });
    const url = new URL(req.url, 'http://x');
    if (req.method === 'POST' && url.pathname === '/pegin') {
      const b = await readBody(req); if (!b || !b.seq_recipient) return send(res, 400, { ok: false, error: 'seq_recipient required' });
      return send(res, 200, { ok: true, deposit_address: await newPeginAddress(String(b.seq_recipient)) });
    }
    if (req.method === 'POST' && url.pathname === '/pegout') {
      const b = await readBody(req); if (!b || !b.btc_dest) return send(res, 400, { ok: false, error: 'btc_dest required' });
      return send(res, 200, { ok: true, sbtc_address: await newPegoutAddress(String(b.btc_dest)) });
    }
    if (req.method === 'GET' && url.pathname === '/status') {
      let reserve = null, supply = null;
      try { reserve = (await btcrpc('getbalances', [])).mine.trusted; } catch {}
      try { const bal = await seqrpc('getbalance', []); supply = bal[SEQ.sbtc_asset] ?? null; } catch {}
      return send(res, 200, { ok: true, pegins: Object.keys(STATE.pegins).length, pegouts: Object.keys(STATE.pegouts).length,
        processed: Object.keys(STATE.done).length, reserve_btc: reserve, bridge_sbtc_balance: supply });
    }
    return send(res, 404, { ok: false, error: 'not found' });
  } catch (e) { send(res, 500, { ok: false, error: e.message }); }
});

// ---- main loop --------------------------------------------------------------
let scanning = false;
async function tick() {
  if (scanning) return; scanning = true;
  try { await scanPegins(); } catch (e) { err('scanPegins:', e.message); }
  try { await scanPegouts(); } catch (e) { err('scanPegouts:', e.message); }
  scanning = false;
}
const POLL_MS = Number(CFG.poll_ms || 15000);
server.listen(HTTPCFG.port || 9987, HTTPCFG.host || '127.0.0.1', () => {
  log('listening http://' + (HTTPCFG.host || '127.0.0.1') + ':' + (HTTPCFG.port || 9987),
      '| SBTC', SEQ.sbtc_asset, '| poll', POLL_MS + 'ms', '| btc min-conf', BTC_MIN_CONF, '| seq min-conf', SEQ_MIN_CONF);
  tick();
  setInterval(tick, POLL_MS);
});
