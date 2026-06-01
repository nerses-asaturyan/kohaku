# @kohaku-eth/train

Private cross-chain bridge — a Railgun shielded balance on **Arbitrum Sepolia** is
moved, via the **TRAIN** protocol (HTLC/PreHTLC intent + solver), into a Railgun
shielded balance on **Ethereum Sepolia**, with **no bridged funds ever resting in
a cleartext EOA**.

Peer package (not published; `private: true`). It **consumes** `@kohaku-eth/railgun`,
`@kohaku-eth/provider`, `@kohaku-eth/plugins`, and `@train-protocol/sdk`; it does
**not** fork TRAIN or the POC — it references the deployed TRAIN + `ShieldedReceiver`
contracts and ports the POC at `railgun-htlc` (the spec).

## Flow

```
createBridgeIntent ─▶ submitIntent ─▶ trackFill ─▶ completeShield
   (bind + quote)     (source spend)  (poll solver)  (dst redeem+shield)
                            │
                            └─ no fill before timelock ─▶ refundBridge
```

1. **createBridgeIntent** (dst = Eth-Sepolia): mint a Railgun shield template
   (`prepareShield` → decode `shield(ShieldRequest[])`), derive the HTLC binding
   `secret = keccak256(abi.encode(r, dstToken, template))`, `hashlock = sha256(secret)`,
   fetch a TRAIN Station quote and build the bound `userLock` calldata.
2. **submitIntent** (source = Arb-Sepolia): one proved Railgun **RelayAdapt
   cross-contract** tx that unshields WETH, runs `[approve(TRAIN), userLock(...)]`
   atomically, and re-shields change — broadcast (gas-paid) by a **non-custodial
   funded EOA**. (See "RelayAdapt dependency" below.)
3. **trackFill** (dst): poll TRAIN `getSolverLock*` for the solver's `Pending` lock
   (recipient == ShieldedReceiver, token == dstTrainToken) until found or timeout.
4. **completeShield** (dst): broadcast `ShieldedReceiver.redeemAndShield(...)` via a
   funded gas relayer — redeems the solver lock and shields the payout into the
   user's Eth-Sepolia `0zk`. Verified trustlessly via **Helios** (`kind:'sepolia'`).
5. **refundBridge** (source): on timeout, `TRAIN.refundUser(hashlock)` (timelock-gated).

State is a JSON-serializable `BridgeHandle` persisted to `host.storage`
(`CREATED → SOURCE_LOCKED → FILLED → COMPLETED`, or `… → TIMED_OUT → REFUNDED`).

## Usage

```ts
import { createTrainBridge } from '@kohaku-eth/train';

const bridge = createTrainBridge({
  src: { host: arbHost, railgun: arbRailgun, broadcaster: arbEoaSigner },  // Arbitrum Sepolia
  dst: { host: ethHost, railgun: ethRailgun, relayer: ethEoaSigner },      // Ethereum Sepolia (Helios provider)
  onStateChange: (h) => store.dispatch(bridgeUpdated(h)),
});

const handle = await bridge.start({ amount: 1_000_000_000_000_000n, refundTo });
await bridge.track(handle);     // resolves FILLED or TIMED_OUT
await bridge.complete(handle);  // -> COMPLETED (Helios-verified)
// on timeout: await bridge.refund(handle);

bridge.listBridges();           // in-flight bridges across reloads
```

Each step is independently callable (Redux-thunk friendly) and resumable from a
persisted handle (`bridge.loadBridge(hashlock)`).

### Host wiring (UI/extension)

Build each `Host = { network, storage, keystore, provider }` from
`@kohaku-eth/provider` (the **dst provider should be Helios**, `bypassLogs:true`),
a `MnemonicKeystore`, browser `localStorage`-backed storage, and `network.fetch`.
The package never constructs providers/signers itself — they are injected.

## RelayAdapt dependency (source spend)

The atomic source spend needs a Railgun **RelayAdapt cross-contract** primitive
(unshield → ordered calls → re-shield) that `@kohaku-eth/railgun` does not expose
yet. `submitIntent` calls an injected `relayAdaptUnshield` function:

- **Default**: `relayAdaptUnshieldViaPlugin(srcRailgun)` calls
  `railgun.prepareRelayAdaptUnshield(...)`. Until that ships it throws a clear error.
- **Override**: pass your own `src.relayAdaptUnshield` to `createTrainBridge`.

The railgun extension is well-scoped (the Rust already has `BoundParams.adaptContract` /
`adaptParams` fields and a `RelayAdapt` ABI with `multicall`): set the unshield
recipient to RelayAdapt, compute the `adaptParams` hash over the calls, bind it into
the transact `boundParams`, build the `RelayAdapt.multicall` calldata, and return a
self-broadcastable `TxData`. Mirrors railgun-community's `populateProvedCrossContractCalls`.

## Configuration

`src/config.ts` holds the chain registry. Source = Arbitrum Sepolia (421614),
destination = Ethereum Sepolia (11155111); the `ShieldedReceiver` is deployed at
`0x4DB9263e0f9536777cAb3ea31D61C10D56bD604C` on Eth-Sepolia. WETH is bridged as an
ERC20 end-to-end. The TRAIN Station URL defaults to the public testnet Station
(override via `trainStationUrl`).

## Build / test

```bash
pnpm --filter @kohaku-eth/train test    # unit tests (network-free)
pnpm --filter @kohaku-eth/train build   # tsup (needs @kohaku-eth/railgun built first)
```

Note: `@kohaku-eth/railgun` builds via `wasm-pack` and must be built before this
package's `tsup` (it provides the consumed types). The unit tests are independent of
that build (the `@kohaku-eth/*` imports are type-only).
