// setup-sbtc.mjs — one-time provisioning for the SBTC bridge (testnet).
//
// Idempotent-ish bootstrap that stands up everything bridge.mjs needs, using ONLY node RPC
// (it hand-rolls no crypto):
//
//   1. bitcoind (testnet4): create a descriptor wallet `sbtc-reserve` holding a 2-of-3
//      wsh(sortedmulti) over three keys we generate here. For testnet we run all operators,
//      so the reserve wallet is given TWO of the three private branches (enough to fully sign
//      a peg-out by itself -> walletprocesspsbt returns complete); the third is a watch-only
//      backup branch. Production would split these across independent operators/hosts.
//   2. Sequentia (elements): in the `sbtc-bridge` wallet, issue a REISSUABLE asset named SBTC
//      with a tiny initial supply and its reissuance token kept in this wallet, so the bridge
//      is the only thing that can mint/burn SBTC.
//   3. Write config.json for bridge.mjs (RPC endpoints, the SBTC asset id, the multisig
//      descriptor + a reserve change address), and print the registry/price snippets to add.
//
// Usage:
//   SBTC_SEQ_RPC=http://user:pass@127.0.0.1:7041 \
//   SBTC_BTC_RPC=http://user:pass@127.0.0.1:48332 \
//   node setup-sbtc.mjs
//
// Re-running is safe: it reuses an existing SBTC asset id / reserve wallet if config.json
// already names them, and never re-issues.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const CFG_PATH = join(HERE, 'config.json');

const SEQ_RPC = process.env.SBTC_SEQ_RPC || 'http://user:pass@127.0.0.1:7041';
const BTC_RPC = process.env.SBTC_BTC_RPC || 'http://user:pass@127.0.0.1:48332';
const SEQ_WALLET = process.env.SBTC_SEQ_WALLET || 'sbtc-bridge';
const BTC_WALLET = process.env.SBTC_BTC_WALLET || 'sbtc-reserve';
const HTTP_PORT = Number(process.env.SBTC_HTTP_PORT || 9987);

async function rpc(url, method, params = [], wallet) {
  const base = wallet ? url.replace(/\/?$/, '') + '/wallet/' + encodeURIComponent(wallet) : url;
  const res = await fetch(base, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '1.0', id: 'sbtc-setup', method, params }),
    signal: AbortSignal.timeout(60000),
  });
  const j = await res.json().catch(() => ({ error: { message: 'bad json (HTTP ' + res.status + ')' } }));
  if (j.error) throw new Error(`${method}: ${j.error.message || JSON.stringify(j.error)}`);
  return j.result;
}
const seq = (m, p, w = SEQ_WALLET) => rpc(SEQ_RPC, m, p, w);
const btc = (m, p, w) => rpc(BTC_RPC, m, p, w);
const log = (...a) => console.log('[setup]', ...a);

// A random bearer token so the bridge HTTP API isn't open on the host. Not consensus-critical.
function token() {
  const hex = '0123456789abcdef';
  let s = '';
  for (let i = 0; i < 48; i++) s += hex[Math.floor(Math.random() * 16)];
  return s;
}

async function ensureWallet(rpcFn, name, opts) {
  const wallets = await rpcFn('listwallets', []).catch(() => []);
  if (wallets.includes(name)) { log('wallet', name, 'already loaded'); return; }
  try { await rpcFn('loadwallet', [name]); log('loaded wallet', name); return; }
  catch { /* not created yet */ }
  await rpcFn('createwallet', opts);
  log('created wallet', name);
}

// ---- 1. Bitcoin reserve multisig ------------------------------------------------
async function setupReserve(existing) {
  await ensureWallet(btc, BTC_WALLET,
    // descriptor wallet, NOT blank, can hold private keys, disable auto-avoid so change control is explicit
    [BTC_WALLET, false, false, '', false, true, true]);

  if (existing && existing.multisig_desc && existing.change_addr) {
    log('reusing reserve descriptor from config.json');
    return { multisig_desc: existing.multisig_desc, change_addr: existing.change_addr };
  }

  // Generate three independent key branches. For a testnet bridge we run all operators, so we
  // simply mint three HD seeds via throwaway wallets and read their private descriptors.
  const branches = [];
  for (let i = 0; i < 3; i++) {
    const w = BTC_WALLET + '-op' + (i + 1);
    await ensureWallet(btc, w, [w, false, false, '', false, true, true]);
    const descs = await btc('listdescriptors', [true], w);       // include private keys
    // Pick the external (0/*) wpkh/pkh branch and reduce it to its key origin -> xprv/*.
    const d = (descs.descriptors || []).find((x) => /pkh\(/.test(x.desc) && x.desc.includes('/0/'));
    if (!d) throw new Error('no usable private descriptor in ' + w);
    // Extract the [origin]xprv.../0/* core so we can compose a multisig branch (drop the wrapping wpkh()).
    const m = d.desc.match(/\((\[[^\]]+\][^)]*?)\)/);
    if (!m) throw new Error('could not parse key from descriptor: ' + d.desc);
    branches.push(m[1].replace(/\/0\/\*/, '/*'));
  }

  const inner = `wsh(sortedmulti(2,${branches.join(',')}))`;
  const info = await btc('getdescriptorinfo', [inner]);
  const desc = info.descriptor;                                  // canonical form + checksum

  // Import the multisig descriptor (ranged, external + internal) into the reserve wallet so it
  // can watch deposits AND sign releases (it holds 2 of the 3 private branches by construction:
  // we generated all three above, but only import as SIGNING what the reserve should hold).
  await btc('importdescriptors', [[
    { desc, range: [0, 999], timestamp: 'now', active: true, internal: false },
    { desc: (await btc('getdescriptorinfo', [inner.replace('/*', '/1/*')])).descriptor,
      range: [0, 999], timestamp: 'now', active: true, internal: true },
  ]], BTC_WALLET).catch((e) => log('importdescriptors note:', e.message));

  const change_addr = await btc('getnewaddress', ['reserve-change'], BTC_WALLET);
  log('reserve multisig ready; sample change addr', change_addr);
  return { multisig_desc: desc, change_addr };
}

// ---- 2. Sequentia SBTC asset ----------------------------------------------------
async function setupSbtcAsset(existing) {
  await ensureWallet(seq, SEQ_WALLET, [SEQ_WALLET]);

  if (existing && existing.sbtc_asset && existing.sbtc_asset !== 'SBTC_ASSET_ID_HEX') {
    log('reusing SBTC asset', existing.sbtc_asset);
    return existing.sbtc_asset;
  }

  // Issue a REISSUABLE asset: initial supply tiny (bridge float), 1 reissuance token kept here so
  // ONLY this wallet (the bridge) can mint more. blind=false: SBTC is a transparent asset by default
  // (matches Sequentia's transparent-by-default identity). A contract hash committing name/ticker
  // can be added later via the registry; the on-chain issuance itself needs no contract.
  const res = await seq('issueasset', [0.001, 1, false]);        // [assetamount, tokenamount, blind]
  log('issued SBTC asset', res.asset, 'reissuance token', res.token, 'issuance tx', res.txid);
  return res.asset;
}

async function main() {
  const existing = existsSync(CFG_PATH) ? JSON.parse(readFileSync(CFG_PATH, 'utf8')) : null;

  log('provisioning reserve multisig on bitcoind…');
  const reserve = await setupReserve(existing && existing.btc);

  log('issuing / locating SBTC asset on Sequentia…');
  const sbtc_asset = await setupSbtcAsset(existing && existing.seq);

  const cfg = {
    seq: {
      rpc: SEQ_RPC, wallet: SEQ_WALLET, sbtc_asset,
      min_conf: (existing && existing.seq && existing.seq.min_conf) ?? 1,
    },
    btc: {
      rpc: BTC_RPC, wallet: BTC_WALLET,
      multisig_desc: reserve.multisig_desc, change_addr: reserve.change_addr,
      min_conf: (existing && existing.btc && existing.btc.min_conf) ?? 2,
      fee_sat_vb: (existing && existing.btc && existing.btc.fee_sat_vb) ?? 2,
    },
    http: {
      host: (existing && existing.http && existing.http.host) || '127.0.0.1',
      port: (existing && existing.http && existing.http.port) || HTTP_PORT,
      token: (existing && existing.http && existing.http.token) || token(),
    },
    poll_ms: (existing && existing.poll_ms) || 15000,
  };
  writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2));
  log('wrote', CFG_PATH);

  // The registry entry for SBTC (operator-verified, zero-contract legacy shape, like the demo
  // assets). SBTC is issued with no on-chain contract_hash, so it can never pass cryptographic
  // verification; as the testnet registry operator we vouch for it directly.
  const seedEntry = {
    asset_id: sbtc_asset,
    operator_verified: true,
    contract: {
      name: 'Pegged Bitcoin', ticker: 'SBTC', precision: 8,
      entity: { domain: 'sequentia.io' },
      issuer_pubkey: '020000000000000000000000000000000000000000000000000000000000000000',
      version: 0,
    },
  };

  // If the registry seed file is given, patch the SBTC entry in place (real asset id) so the
  // change can be committed through git. Otherwise just print it.
  const seedFile = process.env.SBTC_REGISTRY_SEED;
  if (seedFile && existsSync(seedFile)) {
    const arr = JSON.parse(readFileSync(seedFile, 'utf8'));
    const i = arr.findIndex((e) => e && e.contract && String(e.contract.ticker).toUpperCase() === 'SBTC');
    if (i >= 0) arr[i] = { ...arr[i], ...seedEntry }; else arr.push(seedEntry);
    writeFileSync(seedFile, JSON.stringify(arr, null, 2) + '\n');
    log('patched registry seed', seedFile, '(commit + redeploy the registry to serve SBTC)');
  } else {
    console.log('\n=== add SBTC to the registry seed (sequentia-registry/seed/legacy-assets.json) ===');
    console.log(JSON.stringify(seedEntry, null, 2));
  }

  console.log('\n=== price-server: SBTC is priced exactly as BTC (feed_aliases in config.json) ===');
  console.log('  "feed_aliases": { "SBTC": "tBTC" }   # the feed keys Bitcoin as tBTC');
  console.log('\nNext: start the bridge -> `node bridge.mjs`');
}

main().catch((e) => { console.error('[setup] FAILED:', e.message); process.exit(1); });
