---
"@kohaku-eth/railgun": minor
---

Add Arbitrum Sepolia (chain 421614) support. Registers `ChainConfig::arbitrum_sepolia()` (Railgun proxy `0x9Bfa…`, RelayAdapt `0x4B24…`, WETH `0x980B…`) and wires it into `from_chain_id`. Because Arbitrum Sepolia has no Railgun subsquid indexer, `createRailgunPlugin` now builds the UTXO syncer conditionally — it includes the subsquid syncer (and enables POI) only when the chain has a `subsquidEndpoint`, otherwise it syncs **RPC-only**. Adds a tunable `rpcBatchDelayMs` (alongside `rpcBatchSize`) to `RailgunPluginConfig` and the `UtxoSyncer.rpc` binding so RPC-only chains can lower the inter-batch delay for a feasible from-deployment sync. This unblocks `@kohaku-eth/train`'s Arbitrum-Sepolia source chain.
