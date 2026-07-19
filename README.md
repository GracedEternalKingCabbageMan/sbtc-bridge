# sbtc-bridge

An **independent, application-level** BTC ⇄ SBTC custody bridge for Sequentia. It is **not**
Elements' consensus peg and needs no consensus change — it is a standard lock-and-issue
bridge, no closer to consensus than any third-party bridge.

- **SBTC** is a normal, unprivileged, **reissuable** Sequentia asset; its reissuance token
  lives in this bridge's Sequentia wallet.
- **Reserve BTC** lives in a fixed **N-of-M operator multisig** on Bitcoin (testnet4), held
  as a descriptor wallet in bitcoind.
- **Native BTC stays the privileged asset** everywhere; SBTC is just a wrapper for the two
  use-cases in the design doc (resting DEX limit orders; confidential-tx wrapping).

It is a **trusted** bridge — a BTC peg cannot be trustless without Bitcoin covenants. Users
trust the N operators to keep the reserve 1:1 and not abscond.

Canonical design: `../SequentiaByClaude/doc/sequentia/sbtc-peg-design.md`.

## Flows
- **Peg-in**: `POST /pegin {seq_recipient}` → a fresh BTC deposit address. Send real BTC there;
  after confirmations the bridge **reissues SBTC 1:1** to `seq_recipient`.
- **Peg-out**: `POST /pegout {btc_dest}` → a fresh Sequentia address. Send SBTC there; after
  confirmations the bridge **releases reserve BTC 1:1** to `btc_dest` and **burns** the SBTC.
- `GET /status` → counts + reserve-vs-supply sanity.

SBTC is minted ONLY against a confirmed BTC deposit and burned on peg-out, so total SBTC supply
always equals the reserve BTC.

## Run
1. `cp config.example.json config.json` and fill in the Sequentia + bitcoind RPC, the SBTC asset
   id, and the reserve multisig descriptor/wallet (see the design doc's build steps).
2. `node bridge.mjs`

The bridge orchestrates the two node wallets over RPC and hand-rolls no crypto: the Sequentia
node signs the reissuance/send, bitcoind (holding the multisig descriptor) signs the reserve
release via PSBT.
