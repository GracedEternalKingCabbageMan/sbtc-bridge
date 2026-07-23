// Deterministic fund-safety test for the SBTC bridge: a peg-in must NEVER cannibalize a peg-out.
//
// The hole (pre-existing, separate from the crash-safety work): peg-out RETURN addresses are ordinary
// addresses in the SAME Sequentia wallet, so a returned SBTC lands as a spendable wallet UTXO. The
// peg-in credit does whole-wallet coin selection and the recycle-float math counts the whole balance,
// and tick() runs scanPegins BEFORE scanPegouts — so a peg-in coexisting with a freshly-confirmed but
// not-yet-released peg-out return could spend that return, silently dropping the peg-out (user loses
// their BTC). The fix earmarks owed returns: it LOCKS them out of the credit's coin selection AND
// excludes their value from the recyclable float.
//
// Unlike reconcile.test.mjs, this mock models the SBTC wallet at the UTXO level — coin selection skips
// locked outputs, getbalance counts them, reissue adds fresh spendable supply, sendtoaddress consumes
// what it selects. That makes the test fail if EITHER half of the fix is removed:
//   * drop the lock            -> greedy selection (return is the oldest UTXO) consumes the return ->
//                                 scanPegouts finds nothing -> the peg-out never releases.
//   * drop the float exclusion -> we under-mint, the credit can only reach the locked return ->
//                                 sendtoaddress fails 'Insufficient funds' -> the peg-in never credits.
//
// Run: node --test test/cannibalize.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  scanPegins, scanPegouts,
  doneEntry, doneKey, isCompleted, earmarkedPegoutUtxos, __configureForTest,
} from '../bridge.mjs';

const SBTC = 'SBTC_ASSET_ID';
const FEE = 'FEE_ASSET_ID';
const SEQ_CFG = { sbtc_asset: SBTC, fee_asset: FEE };
const BTC_CFG = { change_addr: 'reserveChange', fee_sat_vb: 2 };

const SATS = (btc) => Math.round(Number(btc) * 1e8);
function freshState() { return { pegins: {}, pegouts: {}, done: {}, next_index: 0 }; }

// ---- faithful Sequentia (Elements) SBTC wallet ------------------------------
// Models UTXOs, locks, coin selection and reissuance so the fund-safety guarantees are actually
// exercised (not merely asserted around a no-op mock).
//   sbtc:   [{ txid, vout, address, amount, asset, locked }]   — the wallet's SBTC outputs
// getbalance counts every SBTC output (locked included, like bitcoind). listunspent reports them all
// (locked outputs are still listed). sendtoaddress selects ONLY unlocked outputs, oldest first.
function makeSeqWallet({ sbtc = [] } = {}) {
  const node = { sbtc: sbtc.map((u) => ({ locked: false, asset: SBTC, ...u })), wallet: [], reissued: [], consumed: [], calls: {}, mint: 0 };
  node.find = (txid, vout) => node.sbtc.find((u) => u.txid === txid && u.vout === vout);
  node.seqrpc = async (method, params) => {
    node.calls[method] = (node.calls[method] || 0) + 1;
    if (method === 'getbalance') {
      let bal = 0; for (const u of node.sbtc) if (u.asset === SBTC) bal += u.amount;
      return { [SBTC]: bal };
    }
    if (method === 'listunspent') {
      const [, , addrs, , opts] = params;                                  // [minconf, max, addrs, incWatch, {asset}]
      const wantAsset = opts && opts.asset;
      return node.sbtc
        .filter((u) => (!wantAsset || u.asset === wantAsset) && (!addrs || !addrs.length || addrs.includes(u.address)))
        .map((u) => ({ txid: u.txid, vout: u.vout, address: u.address, amount: u.amount, asset: u.asset })); // locked ARE listed
    }
    if (method === 'lockunspent') {
      const [unlock, outpoints] = params;
      if (unlock === true && !outpoints) { for (const u of node.sbtc) u.locked = false; return true; }
      for (const op of outpoints || []) { const u = node.find(op.txid, op.vout); if (u) u.locked = (unlock === false); }
      return true;
    }
    if (method === 'reissueasset') {
      const amount = Number(params[1]);
      node.reissued.push(amount);
      const txid = 'mint-' + (++node.mint);
      node.sbtc.push({ txid, vout: 0, address: 'bridgeMint', amount, asset: SBTC, locked: false });   // fresh spendable supply
      return txid;
    }
    if (method === 'sendtoaddress') {
      const [address, amount, comment] = params;
      const target = SATS(amount);
      // Coin selection: unlocked SBTC only, oldest-first (insertion order) — a locked output is untouchable.
      const picked = []; let acc = 0;
      for (const u of node.sbtc) {
        if (u.asset !== SBTC || u.locked) continue;
        picked.push(u); acc += SATS(u.amount);
        if (acc >= target) break;
      }
      if (acc < target) throw new Error('Insufficient funds');                                        // fail closed
      for (const u of picked) { node.consumed.push(u.txid + ':' + u.vout); node.sbtc.splice(node.sbtc.indexOf(u), 1); }
      if (acc > target) node.sbtc.push({ txid: 'change-' + node.calls.sendtoaddress, vout: 0, address: 'bridgeChange', amount: (acc - target) / 1e8, asset: SBTC, locked: false });
      const txid = 'seqsend-' + node.calls.sendtoaddress;
      node.wallet.push({ txid, category: 'send', comment, address, amount });
      return txid;
    }
    if (method === 'listtransactions') return node.wallet.slice().reverse();
    throw new Error('unexpected seq rpc ' + method);
  };
  return node;
}

// ---- Bitcoin node: peg-in deposits + reserve release ------------------------
function makeBtcNode({ pegins = [], input = 'reserveUTXO' } = {}) {
  const node = { pegins, input, decodeSeq: 0, walletTxs: new Set(), spent: new Set(), calls: {} };
  node.btcrpc = async (method, params) => {
    node.calls[method] = (node.calls[method] || 0) + 1;
    if (method === 'listunspent') return node.pegins;                          // scanPegins: confirmed deposits
    if (method === 'walletcreatefundedpsbt') return { psbt: 'psbt0' };
    if (method === 'walletprocesspsbt') return { psbt: 'psbt1' };
    if (method === 'finalizepsbt') return { complete: true, hex: 'DEADBEEF' };
    if (method === 'decoderawtransaction') { node.decodeSeq++; return { txid: 'relTx-' + node.decodeSeq, vin: [{ txid: node.input, vout: 0 }] }; }
    if (method === 'sendrawtransaction') { const txid = 'relTx-' + node.decodeSeq; node.walletTxs.add(txid); node.spent.add(node.input + ':0'); return txid; }
    if (method === 'gettransaction') { const id = params[0]; if (node.walletTxs.has(id)) return { txid: id }; throw new Error('Invalid or non-wallet transaction id'); }
    if (method === 'gettxout') { return node.spent.has(params[0] + ':' + params[1]) ? null : { value: 1 }; }
    throw new Error('unexpected btc rpc ' + method);
  };
  return node;
}

// =============================================================================

test('peg-in with a coexisting UNRELEASED peg-out return does not consume it; the peg-out still releases', async () => {
  const state = freshState();
  state.pegins['depAddr'] = { seq_recipient: 'seqRcpt', created: 0 };
  state.pegouts['retAddr'] = { btc_dest: 'btcDest', created: 0 };

  // The ONLY SBTC in the wallet is a confirmed 0.4 peg-out return, not yet released (its done key is absent).
  const seq = makeSeqWallet({ sbtc: [{ txid: 'retTx', vout: 0, address: 'retAddr', amount: 0.4 }] });
  const btc = makeBtcNode({ pegins: [{ txid: 'depTx', vout: 0, address: 'depAddr', amount: 0.5 }], input: 'reserveX' });
  __configureForTest({ state, seqrpc: seq.seqrpc, btcrpc: btc.btcrpc, seq: SEQ_CFG, btc: BTC_CFG });

  const peginKey = doneKey('btc', 'depTx', 0);
  const pegoutKey = doneKey('seq', 'retTx', 0);

  // --- scanPegins runs FIRST (the dangerous ordering) ---
  await scanPegins();

  // The owed return was earmarked: locked out of coin selection, its value excluded from the float,
  // so the credit minted the FULL 0.5 (not 0.5 - 0.4) from fresh supply.
  assert.deepEqual(seq.reissued, [0.5], 'minted the full need — the owed return was excluded from float');
  assert.ok(!seq.consumed.includes('retTx:0'), 'the peg-out return was NOT spent by the peg-in credit');
  assert.ok(seq.find('retTx', 0), 'the peg-out return UTXO is still in the wallet after the peg-in');
  assert.equal(doneEntry(peginKey).stage, 'done', 'peg-in credited exactly once');
  assert.equal(seq.wallet.length, 1, 'one credit broadcast to the recipient');
  assert.equal(seq.wallet[0].address, 'seqRcpt');
  assert.equal(seq.wallet[0].amount, 0.5, 'recipient credited 1:1');

  // --- scanPegouts runs SECOND: the return survived, so the peg-out releases its reserve BTC ---
  await scanPegouts();
  assert.equal(btc.walletTxs.size, 1, 'reserve BTC released for the peg-out (the return was never cannibalized)');
  assert.ok(isCompleted(pegoutKey), 'peg-out completed — the user got their BTC');
});

test('an already-RELEASED peg-out return is NOT earmarked and is still recyclable as float', async () => {
  // Guards against over-correcting: the fix must keep the recycle behaviour for returns whose reserve
  // BTC has already been released (they are free float, owed to no one).
  const state = freshState();
  state.pegins['depAddr2'] = { seq_recipient: 'seqRcpt2', created: 0 };
  state.pegouts['retAddrDone'] = { btc_dest: 'btcDone', created: 0 };
  const releasedKey = doneKey('seq', 'retDone', 0);
  state.done[releasedKey] = { stage: 'done', txid: 'relTx-old', at: 1 };            // its reserve BTC already went out

  const seq = makeSeqWallet({ sbtc: [{ txid: 'retDone', vout: 0, address: 'retAddrDone', amount: 0.3 }] });
  const btc = makeBtcNode({ pegins: [{ txid: 'depTx2', vout: 0, address: 'depAddr2', amount: 0.5 }], input: 'reserveY' });
  __configureForTest({ state, seqrpc: seq.seqrpc, btcrpc: btc.btcrpc, seq: SEQ_CFG, btc: BTC_CFG });

  const earmark = await earmarkedPegoutUtxos();
  assert.equal(earmark.outpoints.length, 0, 'a released return is free float — not earmarked');
  assert.equal(earmark.sats, 0);

  await scanPegins();
  assert.deepEqual(seq.reissued, [0.2], 'recycled the 0.3 free float, minting only the 0.2 shortfall');
  assert.ok(seq.consumed.includes('retDone:0'), 'the released return WAS recycled into the credit');
  assert.equal(doneEntry(doneKey('btc', 'depTx2', 0)).stage, 'done', 'peg-in credited');
  assert.equal(seq.wallet[0].amount, 0.5, 'recipient credited 1:1');
});

test('earmark scan failure fails closed — no peg-in credit, no cannibalization risk', async () => {
  const state = freshState();
  state.pegins['depAddr3'] = { seq_recipient: 'seqRcpt3', created: 0 };
  state.pegouts['retAddr3'] = { btc_dest: 'btcDest3', created: 0 };
  const seq = makeSeqWallet({ sbtc: [{ txid: 'retTx3', vout: 0, address: 'retAddr3', amount: 0.4 }] });
  // Force the earmark enumeration (seq listunspent) to fail: we must NOT credit while blind to what is owed.
  const realSeqrpc = seq.seqrpc;
  seq.seqrpc = async (m, p) => { if (m === 'listunspent') throw new Error('node down'); return realSeqrpc(m, p); };
  const btc = makeBtcNode({ pegins: [{ txid: 'depTx3', vout: 0, address: 'depAddr3', amount: 0.5 }], input: 'reserveZ' });
  __configureForTest({ state, seqrpc: seq.seqrpc, btcrpc: btc.btcrpc, seq: SEQ_CFG, btc: BTC_CFG });

  // The earmark now runs per-credit (right before each send), so a blind earmark fails THAT credit
  // closed (caught -> sentinel cleared -> retried next tick) rather than aborting the whole tick — but
  // the invariant is unchanged: NO credit is broadcast and NO SBTC is minted while the owed returns are
  // unknowable, so a peg-out return can never be cannibalized.
  await scanPegins();
  assert.equal(doneEntry(doneKey('btc', 'depTx3', 0)), undefined, 'sentinel cleared — nothing credited, retried next tick');
  assert.equal(seq.wallet.length, 0, 'no credit broadcast while earmarks are unknowable');
  assert.deepEqual(seq.reissued, [], 'no SBTC minted while blind to owed returns');
});
