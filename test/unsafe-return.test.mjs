// Deterministic fund-safety test for the SBTC bridge: a peg-in must NEVER cannibalize a peg-out return
// that is still 0-conf / "unsafe" at the earmark snapshot but confirms mid-tick.
//
// The hole (round-3, on top of the earmark/lock + honest-freeFloat fix): earmarkedPegoutUtxos enumerated
// owed returns with listunspent's DEFAULT include_unsafe (false), so a return that is still 0-conf — and
// therefore "unsafe" (an incoming transfer from an external key) — was NOT enumerated. It was neither
// locked out of coin selection nor subtracted from the recyclable float. The credit loop then re-reads the
// balance via getbalance each iteration while the Sequentia chain advances; the instant that return confirms
// mid-loop it becomes spendable-and-unlocked, and the peg-in's whole-wallet coin selection consumes it —
// silently dropping the peg-out (that user loses their BTC). The fix enumerates with include_unsafe=true so
// the return is earmarked (locked + float-excluded) from the moment it appears, at any confirmation depth;
// the lock is by outpoint, so it persists when the return later confirms.
//
// This mock models the "unsafe" attribute at the UTXO level: listunspent OMITS unsafe outputs unless
// include_unsafe=true; getbalance re-reads the wallet and (modelling the chain advancing this tick) CONFIRMS
// the 0-conf return, flipping it safe-and-spendable; sendtoaddress spends only unlocked, safe outputs. The
// test fails if the fix is reverted (include_unsafe back to false):
//   * the direct earmark call returns nothing        -> the return is left unlocked and in the float, and
//   * scanPegins then under-mints and coin selection consumes the just-confirmed return -> the peg-out
//     never releases.
//
// Run: node --test test/unsafe-return.test.mjs

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

// ---- Sequentia (Elements) SBTC wallet, WITH the "unsafe" (0-conf) attribute ---
// sbtc: [{ txid, vout, address, amount, asset, locked, safe }]
//   safe=false models a still-0-conf / unsafe output (an incoming external transfer).
// listunspent      OMITS unsafe outputs unless include_unsafe (param 4) is true — exactly bitcoind/Elements.
// getbalance       models the chain advancing THIS tick: it CONFIRMS every unsafe output (safe -> true),
//                  then counts the whole SBTC balance (locked included, like bitcoind).
// sendtoaddress    selects ONLY unlocked AND safe outputs, oldest first; a locked output is untouchable.
// reissueasset     adds fresh spendable (safe) supply.
function makeSeqWallet({ sbtc = [] } = {}) {
  const node = { sbtc: sbtc.map((u) => ({ locked: false, safe: true, asset: SBTC, ...u })), wallet: [], reissued: [], consumed: [], calls: {}, mint: 0 };
  node.find = (txid, vout) => node.sbtc.find((u) => u.txid === txid && u.vout === vout);
  node.seqrpc = async (method, params) => {
    node.calls[method] = (node.calls[method] || 0) + 1;
    if (method === 'getbalance') {
      for (const u of node.sbtc) if (u.safe === false) u.safe = true;      // the chain advanced this tick: the 0-conf return confirmed
      let bal = 0; for (const u of node.sbtc) if (u.asset === SBTC) bal += u.amount;
      return { [SBTC]: bal };
    }
    if (method === 'listunspent') {
      const [, , addrs, includeUnsafe, opts] = params;                     // [minconf, max, addrs, include_unsafe, {asset}]
      const wantAsset = opts && opts.asset;
      return node.sbtc
        .filter((u) => (!wantAsset || u.asset === wantAsset)
                    && (!addrs || !addrs.length || addrs.includes(u.address))
                    && (includeUnsafe === true || u.safe !== false))       // unsafe outputs listed ONLY when include_unsafe=true
        .map((u) => ({ txid: u.txid, vout: u.vout, address: u.address, amount: u.amount, asset: u.asset }));  // locked ARE listed
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
      node.sbtc.push({ txid, vout: 0, address: 'bridgeMint', amount, asset: SBTC, locked: false, safe: true });  // fresh spendable supply
      return txid;
    }
    if (method === 'sendtoaddress') {
      const [address, amount, comment] = params;
      const target = SATS(amount);
      // Coin selection: unlocked AND safe SBTC only, oldest-first — a locked or unsafe output is untouchable.
      const picked = []; let acc = 0;
      for (const u of node.sbtc) {
        if (u.asset !== SBTC || u.locked || u.safe === false) continue;
        picked.push(u); acc += SATS(u.amount);
        if (acc >= target) break;
      }
      if (acc < target) throw new Error('Insufficient funds');                                        // fail closed
      for (const u of picked) { node.consumed.push(u.txid + ':' + u.vout); node.sbtc.splice(node.sbtc.indexOf(u), 1); }
      if (acc > target) node.sbtc.push({ txid: 'change-' + node.calls.sendtoaddress, vout: 0, address: 'bridgeChange', amount: (acc - target) / 1e8, asset: SBTC, locked: false, safe: true });
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

test('earmarkedPegoutUtxos enumerates a still-0-conf / "unsafe" peg-out return (include_unsafe=true)', async () => {
  const state = freshState();
  state.pegouts['retAddr'] = { btc_dest: 'btcDest', created: 0 };
  // The owed return is 0-conf / unsafe: listunspent's DEFAULT (include_unsafe=false) would hide it.
  const seq = makeSeqWallet({ sbtc: [{ txid: 'retTx', vout: 0, address: 'retAddr', amount: 0.4, safe: false }] });
  const btc = makeBtcNode();
  __configureForTest({ state, seqrpc: seq.seqrpc, btcrpc: btc.btcrpc, seq: SEQ_CFG, btc: BTC_CFG });

  const earmark = await earmarkedPegoutUtxos();
  assert.equal(earmark.outpoints.length, 1, 'the 0-conf/unsafe return IS enumerated (include_unsafe=true)');
  assert.deepEqual(earmark.outpoints[0], { txid: 'retTx', vout: 0 });
  assert.equal(earmark.sats, SATS(0.4), 'its full value is earmarked, at 0-conf');
});

test('a 0-conf peg-out return that confirms mid-tick is locked + float-excluded and NOT consumed by a coexisting peg-in', async () => {
  const state = freshState();
  state.pegins['depAddr'] = { seq_recipient: 'seqRcpt', created: 0 };
  state.pegouts['retAddr'] = { btc_dest: 'btcDest', created: 0 };

  // The ONLY SBTC in the wallet is a peg-out return that is still 0-conf / unsafe at the snapshot instant,
  // not yet released (its done key is absent). getbalance (called inside the credit loop) will confirm it
  // mid-tick, modelling the Sequentia chain advancing while the credit is being built.
  const seq = makeSeqWallet({ sbtc: [{ txid: 'retTx', vout: 0, address: 'retAddr', amount: 0.4, safe: false }] });
  const btc = makeBtcNode({ pegins: [{ txid: 'depTx', vout: 0, address: 'depAddr', amount: 0.5 }], input: 'reserveX' });
  __configureForTest({ state, seqrpc: seq.seqrpc, btcrpc: btc.btcrpc, seq: SEQ_CFG, btc: BTC_CFG });

  const peginKey = doneKey('btc', 'depTx', 0);
  const pegoutKey = doneKey('seq', 'retTx', 0);

  // --- scanPegins runs FIRST (the dangerous ordering) ---
  await scanPegins();

  // The still-0-conf return was earmarked despite being "unsafe": locked out of coin selection AND excluded
  // from the recyclable float, so the credit minted the FULL 0.5 from fresh supply. When getbalance confirmed
  // the return mid-loop it stayed locked (lock is by outpoint), so coin selection could not reach it.
  assert.deepEqual(seq.reissued, [0.5], 'minted the full need — the unsafe return was excluded from float');
  assert.ok(!seq.consumed.includes('retTx:0'), 'the peg-out return was NOT spent by the peg-in credit');
  assert.ok(seq.find('retTx', 0), 'the peg-out return UTXO is still in the wallet after the peg-in');
  assert.equal(doneEntry(peginKey).stage, 'done', 'peg-in credited exactly once');
  assert.equal(seq.wallet.length, 1, 'one credit broadcast to the recipient');
  assert.equal(seq.wallet[0].address, 'seqRcpt');
  assert.equal(seq.wallet[0].amount, 0.5, 'recipient credited 1:1');

  // --- scanPegouts runs SECOND: the return survived (and has since confirmed), so the reserve BTC releases ---
  await scanPegouts();
  assert.equal(btc.walletTxs.size, 1, 'reserve BTC released for the peg-out (the return was never cannibalized)');
  assert.ok(isCompleted(pegoutKey), 'peg-out completed — the user got their BTC');
});
