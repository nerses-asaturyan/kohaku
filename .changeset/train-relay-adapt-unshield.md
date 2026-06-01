---
"@kohaku-eth/railgun": minor
---

Add `RailgunPlugin.prepareRelayAdaptUnshield` (and the underlying `RailgunProvider.prepareRelayAdaptUnshield`, the `RelayAdapt.relay`/`ActionData` ABI, and `get_relay_adapt_params`): a self-broadcastable Railgun **RelayAdapt cross-contract unshield**. It atomically unshields an ERC20 (e.g. WETH) into the RelayAdapt contract, runs caller-supplied cross-contract calls inside the RelayAdapt multicall, and re-shields the change back to the wallet's own 0zk — returning `RelayAdapt.relay(...)` calldata for a funded EOA broadcaster (gas-only, non-custodial).

This enables spending a shielded balance on chains without the 4337 paymaster (e.g. Arbitrum Sepolia), and is consumed by `@kohaku-eth/train` for its private source-chain deposit. The `adaptParams` binding is byte-for-byte compatible with railgun-community's RelayAdapt V2 (`getRelayAdaptParams`), verified by native test vectors.
