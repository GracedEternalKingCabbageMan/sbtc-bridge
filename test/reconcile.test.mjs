// Deterministic crash-safety tests for the SBTC bridge: no live node, all chain/RPC mocked.
//
// They pin the two invariants the fix must hold simultaneously:
//   AT-MOST-ONCE   an ambiguous failure AFTER broadcast (tx relayed, RPC response lost) must NOT
//                  produce a second SBTC mint / a second reserve release.
//   AT-LEAST-ONCE  a genuine pre-broadcast failure, and a crash-left placeholder, must NOT wedge:
//                  the action is safely (re)done / completed.
//
// Run: node --test test/reconcile.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  scanPegins, scanPegouts, reconcileOnBoot,
  doneEntry, doneKey, PEGIN_MARKER, __configureForTest,
} from '../bridge.mjs';

const SBTC = 'SBTC_ASSET_ID';
const FEE = 'FEE_ASSET_ID';
const SEQ_CFG = { sbtc_asset: SBTC, fee_asset: FEE };
const BTC_CFG = { change_addr: 'reserveChange', fee_sat_vb: 2 };

function freshState() { return { pegins: {}, pegouts: {}, done: {}, next_index: 0 }; }

// ---- mock Sequentia (Elements) node -----------------------------------------
// sendMode: 'ok' (broadcast + return txid) | 'lose' (broadcast then throw = response lost) |
//           'fail' (throw before any broadcast).
function makeSeqNode({ held = 0, sendMode = 'ok' } = {}) {
  const node = { held, sendMode, wallet: [], utxos: [], calls: {} };
  node.seqrpc = async (method, params) => {
    node.calls[method] = (node.calls[method] || 0) + 1;
    if (method === 'getbalance') return { [SBTC]: node.held };
    if (method === 'reissueasset') { node.held += Number(params[1]); return 'reissue-' + node.calls.reissueasset; }
    if (method === 'sendtoaddress') {
      const [address, amount, comment] = params;
      const txid = 'seqsend-' + node.calls.sendtoaddress;
      if (node.sendMode === 'fail') throw new Error('ECONNREFUSED before broadcast');
      node.wallet.push({ txid, category: 'send', comment, address, amount });     // <-- the broadcast
      if (node.sendMode === 'lose') throw new Error('socket hang up (response lost after broadcast)');
      return txid;
    }
    if (method === 'listtransactions') return node.wallet.slice().reverse();       // newest first, like the real RPC
    if (method === 'listunspent') return node.utxos;
    throw new Error('unexpected seq rpc ' + method);
  };
  return node;
}

// ---- mock Bitcoin node ------------------------------------------------------
// releaseMode: 'ok' | 'lose' (broadcast then throw) | 'fail' (throw before broadcast).
function makeBtcNode({ pegins = [], releaseMode = 'ok', input = 'reserveUTXO' } = {}) {
  const node = { pegins, releaseMode, input, decodeSeq: 0, walletTxs: new Set(), spent: new Set(), calls: {} };
  node.btcrpc = async (method, params) => {
    node.calls[method] = (node.calls[method] || 0) + 1;
    if (method === 'listunspent') return node.pegins;
    if (method === 'walletcreatefundedpsbt') return { psbt: 'psbt0' };
    if (method === 'walletprocesspsbt') return { psbt: 'psbt1' };
    if (method === 'finalizepsbt') return { complete: true, hex: 'DEADBEEF' };
    if (method === 'decoderawtransaction') { node.decodeSeq++; return { txid: 'relTx-' + node.decodeSeq, vin: [{ txid: node.input, vout: 0 }] }; }
    if (method === 'sendrawtransaction') {
      const txid = 'relTx-' + node.decodeSeq;                                       // matches the txid just persisted
      if (node.releaseMode === 'fail') throw new Error('ECONNREFUSED before broadcast');
      node.walletTxs.add(txid); node.spent.add(node.input + ':0');                  // <-- the broadcast
      if (node.releaseMode === 'lose') throw new Error('socket hang up (response lost after broadcast)');
      return txid;
    }
    if (method === 'gettransaction') { const id = params[0]; if (node.walletTxs.has(id)) return { txid: id, confirmations: 0 }; throw new Error('Invalid or non-wallet transaction id'); }
    if (method === 'gettxout') { return node.spent.has(params[0] + ':' + params[1]) ? null : { value: 1, confirmations: 6 }; }
    throw new Error('unexpected btc rpc ' + method);
  };
  return node;
}

// =============================================================================
// PEG-IN
// =============================================================================

test('peg-in: ambiguous failure AFTER broadcast does not double-mint', async () => {
  const state = freshState();
  state.pegins['depAddrA'] = { seq_recipient: 'seqRcptA', created: 0 };
  const seq = makeSeqNode({ held: 0, sendMode: 'lose' });                            // relayed, then response lost
  const btc = makeBtcNode({ pegins: [{ txid: 'depA', vout: 0, address: 'depAddrA', amount: 0.5 }] });
  __configureForTest({ state, seqrpc: seq.seqrpc, btcrpc: btc.btcrpc, seq: SEQ_CFG, btc: BTC_CFG });

  await scanPegins();
  const key = doneKey('btc', 'depA', 0);
  assert.equal(seq.calls.sendtoaddress, 1, 'sent exactly once');
  assert.equal(seq.wallet.length, 1, 'one credit broadcast');
  assert.deepEqual(doneEntry(key), { stage: 'done', txid: 'seqsend-1', at: doneEntry(key).at }, 'record completed with real txid');

  // A subsequent scan of the same still-unspent deposit must NOT re-credit.
  seq.sendMode = 'ok';
  await scanPegins();
  assert.equal(seq.calls.sendtoaddress, 1, 'no second send on re-scan');
  assert.equal(seq.wallet.length, 1, 'still exactly one credit — no unbacked SBTC');
});

test('peg-in: genuine pre-broadcast failure clears sentinel and retries exactly once', async () => {
  const state = freshState();
  state.pegins['depAddrB'] = { seq_recipient: 'seqRcptB', created: 0 };
  const seq = makeSeqNode({ held: 0, sendMode: 'fail' });                            // nothing broadcast
  const btc = makeBtcNode({ pegins: [{ txid: 'depB', vout: 0, address: 'depAddrB', amount: 0.25 }] });
  __configureForTest({ state, seqrpc: seq.seqrpc, btcrpc: btc.btcrpc, seq: SEQ_CFG, btc: BTC_CFG });

  const key = doneKey('btc', 'depB', 0);
  await scanPegins();
  assert.equal(seq.wallet.length, 0, 'nothing broadcast');
  assert.equal(doneEntry(key), undefined, 'sentinel cleared for a safe retry (not wedged)');

  seq.sendMode = 'ok';
  await scanPegins();
  assert.equal(seq.wallet.length, 1, 'retried and credited exactly once');
  assert.equal(doneEntry(key).stage, 'done');
  assert.equal(doneEntry(key).txid, 'seqsend-2');
});

test('peg-in boot reconcile: placeholder whose credit DID broadcast is completed', async () => {
  const state = freshState();
  const key = doneKey('btc', 'depC', 0);
  state.done[key] = { stage: 'pending', txid: null, at: 1 };                         // crash between sentinel and final txid
  const seq = makeSeqNode({});
  seq.wallet.push({ txid: 'seqsend-real', category: 'send', comment: PEGIN_MARKER(key), address: 'seqRcptC', amount: 0.1 });
  const btc = makeBtcNode({});
  __configureForTest({ state, seqrpc: seq.seqrpc, btcrpc: btc.btcrpc, seq: SEQ_CFG, btc: BTC_CFG });

  await reconcileOnBoot();
  assert.equal(doneEntry(key).stage, 'done', 'wedged placeholder resolved from chain');
  assert.equal(doneEntry(key).txid, 'seqsend-real');
});

test('peg-in boot reconcile: placeholder that never broadcast is cleared for retry', async () => {
  const state = freshState();
  const key = doneKey('btc', 'depD', 0);
  state.done[key] = { stage: 'pending', txid: null, at: 1 };
  const seq = makeSeqNode({});                                                       // empty wallet: no marked send
  const btc = makeBtcNode({});
  __configureForTest({ state, seqrpc: seq.seqrpc, btcrpc: btc.btcrpc, seq: SEQ_CFG, btc: BTC_CFG });

  await reconcileOnBoot();
  assert.equal(doneEntry(key), undefined, 'never-broadcast placeholder cleared for a safe retry');
});

test('peg-in: legacy string placeholder is NOT auto-retried (fail closed)', async () => {
  const state = freshState();
  const key = doneKey('btc', 'depE', 0);
  state.done[key] = 'crediting';                                                     // old code, no marker to attribute
  const seq = makeSeqNode({});                                                       // wallet empty (marker never existed)
  const btc = makeBtcNode({});
  __configureForTest({ state, seqrpc: seq.seqrpc, btcrpc: btc.btcrpc, seq: SEQ_CFG, btc: BTC_CFG });

  await reconcileOnBoot();
  assert.notEqual(doneEntry(key), undefined, 'legacy placeholder left in place, never cleared');
  assert.equal(doneEntry(key).stage, 'pending', 'still pending — a human must reconcile, no double-credit risk');
});

// =============================================================================
// PEG-OUT
// =============================================================================

test('peg-out: ambiguous failure AFTER broadcast does not double-release', async () => {
  const state = freshState();
  state.pegouts['seqRetAddrA'] = { btc_dest: 'btcDestA', created: 0 };
  const seq = makeSeqNode({});
  seq.utxos = [{ txid: 'retA', vout: 0, address: 'seqRetAddrA', amount: 0.4, asset: SBTC }];
  const btc = makeBtcNode({ releaseMode: 'lose', input: 'reserveA' });               // relayed, then response lost
  __configureForTest({ state, seqrpc: seq.seqrpc, btcrpc: btc.btcrpc, seq: SEQ_CFG, btc: BTC_CFG });

  const key = doneKey('seq', 'retA', 0);
  await scanPegouts();
  assert.equal(btc.calls.sendrawtransaction, 1, 'broadcast attempted once');
  assert.equal(btc.walletTxs.size, 1, 'one reserve release on-chain');
  assert.equal(doneEntry(key).stage, 'done');
  assert.equal(doneEntry(key).txid, 'relTx-1', 'record completed with the real release txid');

  // Re-scan the same still-present return UTXO: must NOT release reserve again.
  btc.releaseMode = 'ok';
  await scanPegouts();
  assert.equal(btc.calls.sendrawtransaction, 1, 'no second broadcast');
  assert.equal(btc.walletTxs.size, 1, 'still exactly one release — no double-spend of the reserve');
});

test('peg-out: pre-broadcast failure with unspent inputs clears sentinel and retries once', async () => {
  const state = freshState();
  state.pegouts['seqRetAddrB'] = { btc_dest: 'btcDestB', created: 0 };
  const seq = makeSeqNode({});
  seq.utxos = [{ txid: 'retB', vout: 0, address: 'seqRetAddrB', amount: 0.3, asset: SBTC }];
  const btc = makeBtcNode({ releaseMode: 'fail', input: 'reserveB' });               // nothing broadcast
  __configureForTest({ state, seqrpc: seq.seqrpc, btcrpc: btc.btcrpc, seq: SEQ_CFG, btc: BTC_CFG });

  const key = doneKey('seq', 'retB', 0);
  await scanPegouts();
  assert.equal(btc.walletTxs.size, 0, 'nothing broadcast');
  assert.equal(doneEntry(key), undefined, 'sentinel cleared (not wedged)');

  btc.releaseMode = 'ok';
  await scanPegouts();
  assert.equal(btc.walletTxs.size, 1, 'retried and released exactly once');
  assert.equal(doneEntry(key).stage, 'done');
});

test('peg-out boot reconcile: placeholder whose release DID broadcast is completed', async () => {
  const state = freshState();
  const key = doneKey('seq', 'retC', 0);
  state.done[key] = { stage: 'pending', txid: 'relTx-boot', inputs: [{ txid: 'reserveC', vout: 0 }], at: 1 };
  const seq = makeSeqNode({});
  const btc = makeBtcNode({ input: 'reserveC' });
  btc.walletTxs.add('relTx-boot'); btc.spent.add('reserveC:0');                       // it really is on-chain
  __configureForTest({ state, seqrpc: seq.seqrpc, btcrpc: btc.btcrpc, seq: SEQ_CFG, btc: BTC_CFG });

  await reconcileOnBoot();
  assert.equal(doneEntry(key).stage, 'done', 'placeholder resolved from chain (user got their BTC, record fixed)');
  assert.equal(doneEntry(key).txid, 'relTx-boot');
});

test('peg-out boot reconcile: placeholder that never broadcast (inputs unspent) is cleared', async () => {
  const state = freshState();
  const key = doneKey('seq', 'retD', 0);
  state.done[key] = { stage: 'pending', txid: 'relTx-ghost', inputs: [{ txid: 'reserveD', vout: 0 }], at: 1 };
  const seq = makeSeqNode({});
  const btc = makeBtcNode({ input: 'reserveD' });                                     // walletTxs empty, reserveD:0 unspent
  __configureForTest({ state, seqrpc: seq.seqrpc, btcrpc: btc.btcrpc, seq: SEQ_CFG, btc: BTC_CFG });

  await reconcileOnBoot();
  assert.equal(doneEntry(key), undefined, 'never-broadcast placeholder cleared for a safe retry');
});

test('peg-out boot reconcile: input spent by an UNKNOWN tx stays pending (fail closed)', async () => {
  const state = freshState();
  const key = doneKey('seq', 'retE', 0);
  state.done[key] = { stage: 'pending', txid: 'relTx-mine', inputs: [{ txid: 'reserveE', vout: 0 }], at: 1 };
  const seq = makeSeqNode({});
  const btc = makeBtcNode({ input: 'reserveE' });
  btc.spent.add('reserveE:0');                                                        // input gone, but our txid is NOT in walletTxs
  __configureForTest({ state, seqrpc: seq.seqrpc, btcrpc: btc.btcrpc, seq: SEQ_CFG, btc: BTC_CFG });

  await reconcileOnBoot();
  assert.equal(doneEntry(key).stage, 'pending', 'ambiguous reserve movement never triggers a second release');
});
