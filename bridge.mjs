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
//  - No unbacked mint, no double-release, no permanent wedge: an outpoint is marked PENDING before
//    the irreversible action and DONE (with the real txid) after it. A crash or an ambiguous RPC
//    failure (tx relayed but the response was lost) is never blind-retried and never blind-cleared:
//    the pending record is RECONCILED against chain state (`verifyPeginCredit`/`verifyPegoutRelease`,
//    and `reconcileOnBoot` at startup). We re-do the action ONLY when the chain positively shows it
//    did NOT broadcast; if it did broadcast we complete the record; if we cannot tell we leave the
//    sentinel and refuse to act (fail closed). This gives both at-most-once AND at-least-once.

import http from 'node:http';
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const CFG_PATH = process.env.SBTC_BRIDGE_CONFIG || join(HERE, 'config.json');
const STATE_PATH = process.env.SBTC_BRIDGE_STATE || join(HERE, 'state.json');

// ---- runtime context --------------------------------------------------------
// Populated by main() from config.json; overridable in tests via __configureForTest(). Keeping these
// mutable (rather than top-level file/network side effects at import time) is what lets the scan and
// reconcile logic be unit-tested against a mock chain, with no live node and no config file.
let STATE = { pegins: {}, pegouts: {}, done: {}, next_index: 0 };
let SEQ = null, BTC = null, HTTPCFG = {};
let SEQ_MIN_CONF = 1, BTC_MIN_CONF = 2, POLL_MS = 15000;
let seqrpc = null, btcrpc = null;

// ---- persisted state --------------------------------------------------------
// { pegins:  { [btcDepositAddr]: { seq_recipient, created } },
//   pegouts: { [seqReturnAddr]: { btc_dest, created } },
//   done:    { ["btc:"+txid+":"+vout]: <entry>, ["seq:"+txid+":"+vout]: <entry> },
//   next_index: n }
// A `done` entry is one of:
//   { stage: 'pending', txid: null|<txid>, inputs?: [...], at }   — action started/in-flight (no final txid yet)
//   { stage: 'done',    txid: <txid>, at }                         — action completed, txid recorded
// Legacy states from earlier builds — a bare string '' / 'crediting' / 'releasing' (placeholder) or a
// bare txid string (completed) — are still understood (see doneEntry()).
function loadState() {
  if (!existsSync(STATE_PATH)) return { pegins: {}, pegouts: {}, done: {}, next_index: 0 };
  try { return JSON.parse(readFileSync(STATE_PATH, 'utf8')); }
  catch { throw new Error('state.json is corrupt — refusing to run a custody service on unreadable state'); }
}
function defaultSaveState() {
  // atomic write: tmp + rename, so a crash never leaves half-written custody state.
  const tmp = STATE_PATH + '.tmp';
  writeFileSync(tmp, JSON.stringify(STATE, null, 2));
  renameSync(tmp, STATE_PATH);
}
let saveState = defaultSaveState;

// ---- done-set accessors -----------------------------------------------------
function doneEntry(key) {
  const v = STATE.done[key];
  if (v === undefined) return undefined;
  if (typeof v === 'string') {
    // legacy encoding: placeholder strings = pending (but un-attributable -> fail closed on reconcile),
    // any other non-empty string = a completed txid.
    if (v === '' || v === 'crediting' || v === 'releasing') return { stage: 'pending', txid: null, legacy: true };
    return { stage: 'done', txid: v };
  }
  return v;
}
function isCompleted(key) { const e = doneEntry(key); return !!(e && e.stage === 'done'); }
function markPending(key, extra = {}) {
  STATE.done[key] = { stage: 'pending', txid: null, ...extra, at: Math.floor(Date.now() / 1000) };
  saveState();
}
function markDone(key, txid) {
  STATE.done[key] = { stage: 'done', txid: String(txid), at: Math.floor(Date.now() / 1000) };
  saveState();
}
function clearSentinel(key) { delete STATE.done[key]; saveState(); }

// ---- JSON-RPC ---------------------------------------------------------------
async function rpc(url, method, params = [], wallet) {
  // Node's fetch (undici) refuses a URL that embeds credentials (http://user:pass@host), so pull them
  // out into an Authorization: Basic header and use a credential-free URL.
  const u = new URL(url);
  const auth = (u.username || u.password)
    ? 'Basic ' + Buffer.from(decodeURIComponent(u.username) + ':' + decodeURIComponent(u.password)).toString('base64')
    : null;
  u.username = ''; u.password = '';
  const clean = u.toString().replace(/\/$/, '');
  const base = wallet ? clean + '/wallet/' + encodeURIComponent(wallet) : clean;
  const headers = { 'content-type': 'application/json' };
  if (auth) headers.authorization = auth;
  const res = await fetch(base, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '1.0', id: 'sbtc-bridge', method, params }),
    signal: AbortSignal.timeout(30000),
  });
  const j = await res.json().catch(() => ({ error: { message: 'bad json (HTTP ' + res.status + ')' } }));
  if (j.error) throw new Error(`${method}: ${j.error.message || JSON.stringify(j.error)}`);
  return j.result;
}

const log = (...a) => console.log(new Date().toISOString(), '[sbtc-bridge]', ...a);
const err = (...a) => console.error(new Date().toISOString(), '[sbtc-bridge]', ...a);
const doneKey = (chain, txid, vout) => `${chain}:${txid}:${vout}`;
const sat = (btc) => Math.round(Number(btc) * 1e8);       // BTC-float -> sats (both chains use 8dp)
const btcAmt = (sats) => (Number(sats) / 1e8).toFixed(8); // sats -> 8dp string
const PEGIN_MARKER = (key) => 'sbtc-pegin:' + key;        // unique wallet comment stamped on each credit send

// ---- reconciliation: did the irreversible action already broadcast? ---------
// These answer the ONLY question that makes ambiguous failures safe: for THIS outpoint, is the
// credit/release already on-chain? 'confirmed' -> complete the record with the real txid; 'absent' ->
// positively never broadcast, safe to (re)do; 'unknown' -> cannot tell (node down, or an un-attributable
// legacy placeholder) -> caller must leave the sentinel and NOT act.
async function verifyPeginCredit(key, entry) {
  // The credit send stamps the deposit outpoint as its wallet comment, so a broadcast credit is always
  // findable even when the sendtoaddress response was lost.
  const marker = PEGIN_MARKER(key);
  let txs;
  try { txs = await seqrpc('listtransactions', ['*', 10000, 0, true]); }
  catch (e) { return { status: 'unknown', reason: 'listtransactions failed: ' + e.message }; }
  for (const t of txs || []) {
    if (t && t.category === 'send' && t.comment === marker && t.txid) return { status: 'confirmed', txid: t.txid };
  }
  // No marked send exists. For a placeholder written by the current code that means the credit never
  // broadcast (the marker is set atomically with the send). A legacy placeholder carried no marker, so
  // its absence proves nothing — refuse to retry (would double-credit); leave it for manual reconcile.
  if (entry && entry.legacy) return { status: 'unknown', reason: 'legacy peg-in placeholder without marker; manual reconcile required' };
  return { status: 'absent' };
}
async function verifyPegoutRelease(key, entry) {
  // We record the finalized txid + the reserve inputs it spends BEFORE broadcasting, so a broadcast
  // release is findable by txid (it is a wallet tx: it spends the multisig and pays change back to it).
  if (entry && entry.txid) {
    try {
      const gt = await btcrpc('gettransaction', [entry.txid]);
      if (gt && gt.txid) return { status: 'confirmed', txid: gt.txid };
    } catch (e) {
      // "Invalid or non-wallet transaction id" -> our node never created/broadcast it; cross-check inputs.
    }
    if (Array.isArray(entry.inputs) && entry.inputs.length) {
      for (const inp of entry.inputs) {
        let utxo;
        try { utxo = await btcrpc('gettxout', [inp.txid, inp.vout, true]); }
        catch (e) { return { status: 'unknown', reason: 'gettxout failed: ' + e.message }; }
        if (utxo === null) {
          // The reserve input is already spent, yet the wallet does not know our txid: something else
          // moved this reserve UTXO. Do NOT release again — fail closed for a human.
          return { status: 'unknown', reason: 'reserve input ' + inp.txid + ':' + inp.vout + ' spent by an unrecognized tx' };
        }
      }
      // Txid unknown to the wallet AND every reserve input still unspent -> the release never broadcast.
      return { status: 'absent' };
    }
    return { status: 'unknown', reason: 'peg-out placeholder has a txid but no recorded inputs to verify' };
  }
  // No txid recorded. The current code computes+persists the txid strictly before sendrawtransaction, so
  // a txid-less non-legacy placeholder means the release never broadcast. A legacy 'releasing' placeholder
  // carries no txid and cannot be attributed -> fail closed.
  if (entry && entry.legacy) return { status: 'unknown', reason: 'legacy peg-out placeholder without txid; manual reconcile required' };
  return { status: 'absent' };
}

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
// ---- fund-safety: SBTC owed to not-yet-released peg-outs ---------------------
// Peg-out RETURN addresses are getnewaddress in THIS Sequentia wallet (see newPegoutAddress), so a
// returned SBTC lands as an ordinary SPENDABLE wallet UTXO. Until scanPegouts has released the reserve
// BTC for it, that SBTC is OWED to the peg-out and MUST NOT be recycled as peg-in float: the peg-in
// credit does whole-wallet coin selection, and tick() runs scanPegins BEFORE scanPegouts, so an
// unguarded peg-in could spend a freshly-confirmed peg-out's return and silently drop the peg-out
// forever (that user loses their BTC). This enumerates those still-owed outpoints (+ their total sats)
// so scanPegins can BOTH exclude their value from the recyclable float AND lock them out of coin
// selection. Already-released returns are free float (recyclable) and are excluded here. If we cannot
// enumerate the returns we THROW — scanPegins then skips crediting this tick (fail closed) rather than
// risk raiding a peg-out. minconf 0 AND include_unsafe TRUE: earmark a return from the instant it lands
// on-chain, at ANY confirmation depth. A peg-out return is an incoming transfer from an external key, so
// while it is still 0-conf bitcoind flags it "unsafe" — and listunspent's DEFAULT include_unsafe OMITS
// unsafe outputs. With that default a still-0-conf return would be INVISIBLE here, hence neither locked
// nor float-excluded; it could then confirm mid-tick (the credit loop re-reads the wallet via getbalance
// as the Sequentia chain advances), become spendable-and-unlocked, and be cannibalized by a peg-in credit
// before scanPegouts ever releases it (that user loses their BTC). Enumerating unsafe outputs too closes
// that window: locking is by outpoint, so a lock taken at 0-conf persists when the return later confirms.
// Over-earmarking only ever over-mints float (still 1:1); under-earmarking is what loses funds.
async function earmarkedPegoutUtxos() {
  const addrs = Object.keys(STATE.pegouts);
  if (!addrs.length) return { outpoints: [], sats: 0 };
  let utxos;
  // listunspent [minconf, maxconf, addresses, include_unsafe, {asset}] — include_unsafe MUST be true so a
  // 0-conf / "unsafe" peg-out return is enumerated (and thus locked + float-excluded) the moment it appears.
  try { utxos = await seqrpc('listunspent', [0, 9999999, addrs, true, { asset: SEQ.sbtc_asset }]); }
  catch (e) { throw new Error('earmark scan failed (listunspent): ' + e.message); }
  const outpoints = [], seen = new Set();
  let sats = 0;
  for (const u of utxos || []) {
    if (u.asset !== SEQ.sbtc_asset) continue;
    if (!STATE.pegouts[u.address]) continue;                 // not one of our peg-out returns
    if (isCompleted(doneKey('seq', u.txid, u.vout))) continue; // already released -> free float, recyclable
    const k = u.txid + ':' + u.vout;
    if (seen.has(k)) continue; seen.add(k);
    outpoints.push({ txid: u.txid, vout: u.vout });
    sats += sat(u.amount);
  }
  return { outpoints, sats };
}
async function scanPegins() {
  // Confirmed UTXOs sitting at our peg-in deposit addresses = new reserve deposits to credit.
  const utxos = await btcrpc('listunspent', [BTC_MIN_CONF, 9999999, Object.keys(STATE.pegins)]);

  // FUND-SAFETY (a peg-in must NEVER cannibalize a peg-out): the SBTC still owed to not-yet-released
  // peg-outs is earmarked (locked out of coin selection + subtracted from recyclable float) IMMEDIATELY
  // BEFORE EACH credit's send, inside the loop — NOT once here. A single pre-loop snapshot missed a
  // return that landed AFTER it yet confirmed mid-loop (one tick can process a batch of deposits over
  // tens of seconds, spanning a Sequentia block). A per-credit re-lock closes that window: any return
  // already on-chain at the re-lock — even 0-conf (earmarkedPegoutUtxos uses include_unsafe) — is locked
  // out, and no external return can go from absent to SPENDABLE in the sub-second await gap before
  // sendtoaddress (becoming spendable needs a ~30s confirmation).

  for (const u of utxos || []) {
    const key = doneKey('btc', u.txid, u.vout);
    if (isCompleted(key)) continue;                      // already credited
    const bind = STATE.pegins[u.address];
    if (!bind) continue;                                 // not a peg-in address (change/other)
    const sats = sat(u.amount);
    if (sats <= 0) continue;
    const need = Number(btcAmt(sats));

    // A pending sentinel means a prior attempt started (or crashed) mid-credit. Reconcile it against the
    // chain before doing anything irreversible — NEVER blind-retry (would mint unbacked SBTC).
    const pending = doneEntry(key);
    if (pending) {
      const v = await verifyPeginCredit(key, pending);
      if (v.status === 'confirmed') { markDone(key, v.txid); log('PEG-IN reconciled', key, 'already credited tx', v.txid); continue; }
      if (v.status !== 'absent')    { err('PEG-IN reconcile inconclusive for', key, '-', v.reason, '(leaving pending, no retry)'); continue; }
      clearSentinel(key);                                // positively never broadcast -> safe to (re)credit
    }

    try {
      markPending(key);
      // Re-earmark + re-lock the peg-out returns HERE, right before this credit's coin selection, so a
      // return that appeared since the previous credit is locked out before sendtoaddress runs. The
      // unlock-all clears a since-released return so it rejoins recyclable float; no credit runs between
      // the unlock and the re-lock (single-threaded), and the send below is only a few sub-second awaits
      // later. A throw here (cannot enumerate/lock) fails closed via the catch. Locking is by outpoint,
      // so a return locked here at 0-conf stays locked when it later confirms.
      const earmark = await earmarkedPegoutUtxos();
      if (Object.keys(STATE.pegouts).length) {
        await seqrpc('lockunspent', [true]);
        if (earmark.outpoints.length) await seqrpc('lockunspent', [false, earmark.outpoints]);
      }
      // RECYCLE: spend SBTC the bridge already holds (float returned by prior peg-outs) and mint ONLY the
      // shortfall, so supply tracks peak circulation instead of inflating on every peg-in. ALL fees are
      // paid in SEQ.fee_asset (USDX) — the bridge never holds the Sequence token (Principle 3/4). This
      // reissue is self-correcting on retry: `held` already includes any prior (ambiguous) reissue, so
      // the shortfall collapses to ~0 and we never double-mint. reissueasset params: [asset, amount, fee_asset].
      let held = 0; try { held = Number((await seqrpc('getbalance', []))[SEQ.sbtc_asset] || 0); } catch {}
      // Recyclable float EXCLUDES SBTC owed to pending peg-outs (earmark.sats): counting it would make
      // us under-mint and force coin selection to reach for a peg-out's (locked) return, wedging the
      // credit. Subtracting it mints the honest shortfall from fresh supply and leaves the return intact.
      const freeFloat = Math.max(0, held - earmark.sats / 1e8);
      const shortfall = need - freeFloat;
      if (shortfall > 1e-8) await seqrpc('reissueasset', [SEQ.sbtc_asset, Number(shortfall.toFixed(8)), SEQ.fee_asset]);
      // Stamp the deposit outpoint as the send's wallet comment so an ambiguous failure (tx relayed,
      // response lost) is reconciled by comment instead of re-sent. sendtoaddress params: [address,
      // amount, comment, comment_to, subtractfee, replaceable, conf_target, estimate_mode, avoid_reuse,
      // assetlabel, ignoreblindfail, fee_rate, fee_asset_label].
      const sendTxid = await seqrpc('sendtoaddress',
        [bind.seq_recipient, need, PEGIN_MARKER(key), '', false, true, null, 'unset', false, SEQ.sbtc_asset, true, null, SEQ.fee_asset]);
      markDone(key, sendTxid);
      log('PEG-IN', u.txid + ':' + u.vout, btcAmt(sats), 'BTC ->', sats, 'SBTC to', bind.seq_recipient, 'tx', sendTxid);
    } catch (e) {
      // Ambiguous: the send may already have broadcast. Do NOT delete the sentinel blindly — verify.
      const v = await verifyPeginCredit(key, doneEntry(key));
      if (v.status === 'confirmed') { markDone(key, v.txid); err('PEG-IN', key, 'RPC errored but credit DID broadcast — recorded tx', v.txid); }
      else if (v.status === 'absent') { clearSentinel(key); err('PEG-IN credit failed (not broadcast) for', key, '- will retry -', e.message); }
      else { err('PEG-IN credit AMBIGUOUS for', key, '- keeping sentinel, NO retry until verified -', e.message, '/', v.reason); }
    }
  }
}

// ---- PEG-OUT: SBTC returned -> release reserve BTC 1:1 ------------------------
// A user asks for a fresh Sequentia address bound to their Bitcoin destination. When SBTC lands there
// (confirmed), we release exactly that many BTC sats (minus the Bitcoin fee) from the reserve multisig.
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
    if (isCompleted(key)) continue;
    const bind = STATE.pegouts[u.address];
    if (!bind) continue;
    const sats = sat(u.amount);
    if (sats <= 0) continue;

    // Reconcile any pending sentinel before releasing more reserve — NEVER blind-retry (would double-release).
    const pending = doneEntry(key);
    if (pending) {
      const v = await verifyPegoutRelease(key, pending);
      if (v.status === 'confirmed') { markDone(key, v.txid); log('PEG-OUT reconciled', key, 'already released tx', v.txid); continue; }
      if (v.status !== 'absent')    { err('PEG-OUT reconcile inconclusive for', key, '-', v.reason, '(leaving pending, no retry)'); continue; }
      clearSentinel(key);
    }

    try {
      markPending(key);
      // Release `sats` BTC from the reserve multisig to the user's Bitcoin destination. bitcoind's wallet
      // (holding the multisig descriptor) selects reserve UTXOs, adds change back to the multisig, and
      // takes the BTC fee from the released amount (subtractFeeFromOutputs) so the reserve is never drawn
      // below the SBTC it backs.
      const funded = await btcrpc('walletcreatefundedpsbt',
        [[], [{ [bind.btc_dest]: Number(btcAmt(sats)) }], 0,
         { subtractFeeFromOutputs: [0], changeAddress: BTC.change_addr, ...(BTC.fee_sat_vb ? { fee_rate: BTC.fee_sat_vb } : {}) }]);
      const processed = await btcrpc('walletprocesspsbt', [funded.psbt]);
      const fin = await btcrpc('finalizepsbt', [processed.psbt]);
      if (!fin.complete) throw new Error('reserve release PSBT not fully signed (need more operator co-signers)');
      // Record the finalized txid + the reserve inputs it spends BEFORE broadcasting, so an ambiguous
      // sendrawtransaction (tx relayed, response lost) — or a crash right after — is reconciled against
      // the chain and never re-sent.
      const decoded = await btcrpc('decoderawtransaction', [fin.hex]);
      const inputs = (decoded.vin || []).map((v) => ({ txid: v.txid, vout: v.vout }));
      markPending(key, { txid: decoded.txid, inputs });
      const releaseTxid = await btcrpc('sendrawtransaction', [fin.hex]);
      // RECYCLE (not burn): the returned SBTC stays in the bridge wallet as float for future peg-ins.
      // We do NOT destroyamount — it cannot take a fee asset, so it would force the bridge to hold the
      // Sequence token just to pay a burn fee. Circulating SBTC still equals reserve BTC (the held float
      // is out of circulation); the next peg-in spends this float before minting anything new.
      markDone(key, releaseTxid);
      log('PEG-OUT', u.txid + ':' + u.vout, sats, 'SBTC ->', btcAmt(sats), 'BTC to', bind.btc_dest, 'tx', releaseTxid);
    } catch (e) {
      // Ambiguous: the release may already have broadcast. Do NOT delete the sentinel blindly — verify.
      const v = await verifyPegoutRelease(key, doneEntry(key));
      if (v.status === 'confirmed') { markDone(key, v.txid); err('PEG-OUT', key, 'RPC errored but release DID broadcast — recorded tx', v.txid); }
      else if (v.status === 'absent') { clearSentinel(key); err('PEG-OUT release failed (not broadcast) for', key, '- will retry -', e.message); }
      else { err('PEG-OUT release AMBIGUOUS for', key, '- keeping sentinel, NO retry until verified -', e.message, '/', v.reason); }
    }
  }
}

// ---- boot reconcile ---------------------------------------------------------
// On startup, resolve every placeholder-done entry (sentinel set, no final txid) a crash may have left:
// find the real tx and complete the record, or (only if provably not broadcast) clear it so the next
// scan does ONE safe retry. Anything we cannot attribute stays pending (fail closed) for a human.
async function reconcileOnBoot() {
  const keys = Object.keys(STATE.done);
  let pend = 0;
  for (const key of keys) {
    const e = doneEntry(key);
    if (!e || e.stage !== 'pending') continue;
    pend++;
    const chain = key.split(':', 1)[0];
    const label = chain === 'btc' ? 'peg-in' : chain === 'seq' ? 'peg-out' : 'unknown';
    const v = chain === 'btc' ? await verifyPeginCredit(key, e)
            : chain === 'seq' ? await verifyPegoutRelease(key, e)
            : { status: 'unknown', reason: 'unrecognized chain in done key' };
    if (v.status === 'confirmed') { markDone(key, v.txid); log('boot reconcile:', label, key, 'completed from chain, tx', v.txid); }
    else if (v.status === 'absent') { clearSentinel(key); log('boot reconcile:', label, key, 'never broadcast — cleared for one safe retry'); }
    else { err('boot reconcile:', label, key, 'inconclusive — leaving pending:', v.reason); }
  }
  if (pend) log('boot reconcile: examined', pend, 'pending entr' + (pend === 1 ? 'y' : 'ies'));
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

function main() {
  const CFG = JSON.parse(readFileSync(CFG_PATH, 'utf8'));
  SEQ = CFG.seq; BTC = CFG.btc; HTTPCFG = CFG.http || {};
  SEQ_MIN_CONF = Number(SEQ.min_conf ?? 1);
  BTC_MIN_CONF = Number(BTC.min_conf ?? 2);
  POLL_MS = Number(CFG.poll_ms || 15000);
  seqrpc = (m, p) => rpc(SEQ.rpc, m, p, SEQ.wallet);
  btcrpc = (m, p) => rpc(BTC.rpc, m, p, BTC.wallet);
  saveState = defaultSaveState;
  STATE = loadState();
  server.listen(HTTPCFG.port || 9987, HTTPCFG.host || '127.0.0.1', async () => {
    log('listening http://' + (HTTPCFG.host || '127.0.0.1') + ':' + (HTTPCFG.port || 9987),
        '| SBTC', SEQ.sbtc_asset, '| poll', POLL_MS + 'ms', '| btc min-conf', BTC_MIN_CONF, '| seq min-conf', SEQ_MIN_CONF);
    // Reconcile crash-left placeholders against the chain BEFORE the first scan, so a wedged peg is
    // completed (or safely re-armed) rather than stuck, and nothing is ever double-actioned.
    try { await reconcileOnBoot(); } catch (e) { err('boot reconcile failed:', e.message); }
    tick();
    setInterval(tick, POLL_MS);
  });
}

// ---- test hook --------------------------------------------------------------
// Lets a unit test drive the scan/reconcile logic against a mock chain, with no config file, no disk
// writes and no server. Not used in production (main() alone runs when executed directly).
function __configureForTest(opts = {}) {
  if (opts.state) STATE = opts.state;
  if (opts.seqrpc) seqrpc = opts.seqrpc;
  if (opts.btcrpc) btcrpc = opts.btcrpc;
  if (opts.seq) SEQ = opts.seq;
  if (opts.btc) BTC = opts.btc;
  saveState = opts.saveState || (() => {});
  if (opts.seqMinConf !== undefined) SEQ_MIN_CONF = Number(opts.seqMinConf);
  if (opts.btcMinConf !== undefined) BTC_MIN_CONF = Number(opts.btcMinConf);
}

export {
  scanPegins, scanPegouts, reconcileOnBoot,
  verifyPeginCredit, verifyPegoutRelease, earmarkedPegoutUtxos,
  doneEntry, isCompleted, doneKey, PEGIN_MARKER,
  __configureForTest,
};

// Run the service only when executed directly (not when imported by a test).
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();
