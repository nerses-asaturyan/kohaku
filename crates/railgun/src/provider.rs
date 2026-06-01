use std::{collections::HashMap, sync::Arc};

use alloy::{
    primitives::{Address, Bytes, FixedBytes, U256, aliases::U192},
    sol_types::SolCall,
};
use eip_1193_provider::provider::{Eip1193Error, Eip1193Provider};
use eip_1193_provider::tx_data::TxData;
use rand::Rng;
use serde::Serialize;
use thiserror::Error;
use tracing::{info, warn};
use userop_kit::{
    builder::UserOperationBuilder,
    bundler::{Bundler, BundlerError},
    railgun::{PAYMASTER_MASTER_PUBLIC_KEY, PAYMASTER_VIEWING_PUBLIC_KEY, TailCall},
    signable_user_operation::SignableUserOperation,
};

use crate::{
    abis::railgun::{RailgunSmartWallet, RelayAdapt, ShieldRequest, get_relay_adapt_params},
    account::{address::RailgunAddress, signer::RailgunSigner},
    caip::AssetId,
    chain_config::ChainConfig,
    circuit::groth16_prover::Groth16Prover,
    crypto::keys::{ByteKey, MasterPublicKey, ViewingPublicKey},
    indexer::utxo_indexer::{UtxoIndexer, UtxoIndexerError},
    note::{Note, encrypt::encrypt_shield, utxo::UtxoNote},
    poi::{
        provider::{PoiProvider, PoiProviderError},
        types::PoiStatus,
    },
    transact::{
        ShieldBuilder, TransactionBuilder, TransactionBuilderError,
        proved_transaction::{ProvedOperation, ProvedTx},
    },
};

#[derive(Debug, Serialize)]
#[cfg_attr(js, derive(tsify::Tsify))]
pub struct BalanceEntry {
    pub asset: AssetId,
    pub poi_status: Option<PoiStatus>,
    pub amount: u128,
}

/// Interfaces with the RAILGUN protocol.
pub struct RailgunProvider {
    chain: ChainConfig,
    provider: Arc<dyn Eip1193Provider>,
    utxo_indexer: UtxoIndexer,
    prover: Groth16Prover,
    poi_provider: Option<PoiProvider>,
}

#[derive(Debug, Error)]
pub enum RailgunProviderError {
    #[error("Utxo indexer error: {0}")]
    UtxoIndexer(#[from] UtxoIndexerError),
    #[error("Build error: {0}")]
    Build(#[from] TransactionBuilderError),
    #[error("POI provider error: {0}")]
    PoiProvider(#[from] PoiProviderError),
    #[error("Unable to construct valid note configuration for fee payment")]
    FeeNoteNotFound,
    #[error("Signer Error: {0}")]
    Signer(#[from] alloy::signers::Error),
    #[error("Bundler error: {0}")]
    Bundler(#[from] BundlerError),
    #[error("RPC error: {0}")]
    Rpc(#[from] Eip1193Error),
    #[error("Other: {0}")]
    Other(Box<dyn std::error::Error + Send + Sync>),
}

impl RailgunProvider {
    pub(crate) async fn new(
        chain: ChainConfig,
        provider: Arc<dyn Eip1193Provider>,
        utxo_indexer: UtxoIndexer,
        prover: Groth16Prover,
        poi_provider: Option<PoiProvider>,
    ) -> Result<Self, RailgunProviderError> {
        Ok(Self {
            chain,
            provider,
            utxo_indexer,
            prover,
            poi_provider,
        })
    }

    /// Register a signer with the provider. The provider will index and track
    /// UTXOs for the associated address.
    pub async fn register(
        &mut self,
        signer: Arc<dyn RailgunSigner>,
    ) -> Result<(), RailgunProviderError> {
        self.utxo_indexer.register(signer).await?;
        Ok(())
    }

    /// Syncs the provider to the latest block.
    pub async fn sync(&mut self) -> Result<(), RailgunProviderError> {
        self.sync_to(u64::MAX).await
    }

    /// Syncs the provider to the specified block.
    pub async fn sync_to(&mut self, to_block: u64) -> Result<(), RailgunProviderError> {
        self.utxo_indexer.sync_to(to_block).await?;

        if let Some(poi_provider) = &mut self.poi_provider {
            poi_provider.sync_to(&self.prover, to_block).await?;
        }

        Ok(())
    }

    /// Returns the balance for the given address.
    ///
    /// If POI is enabled, only returns the spendable balance according to the POI provider.
    pub async fn balance(&mut self, address: RailgunAddress) -> HashMap<AssetId, u128> {
        let unspent = self.unspent(address).await;

        let mut balance_map = HashMap::new();
        for note in unspent {
            let asset = note.asset();
            let value = note.value();
            *balance_map.entry(asset).or_insert(0) += value;
        }

        balance_map
    }

    /// Helper to create a shield builder.
    pub fn shield(&self) -> ShieldBuilder {
        ShieldBuilder::new(self.chain.clone())
    }

    /// Helper to create a transaction builder.
    pub fn transact(&self) -> TransactionBuilder {
        TransactionBuilder::new()
    }

    /// Build a transaction builder into a proved, signable transaction.
    pub async fn build<R: Rng>(
        &mut self,
        builder: TransactionBuilder,
        rng: &mut R,
    ) -> Result<ProvedTx, RailgunProviderError> {
        let operations = self.build_operation(builder, rng).await?;
        if let Some(poi_provider) = &mut self.poi_provider {
            poi_provider.register_ops(&operations).await?;
        }

        let proved_tx = ProvedTx::new(self.chain.railgun_smart_wallet, operations);
        Ok(proved_tx)
    }

    /// Build a transaction builder into a broadcastable 7702 UserOperation.
    ///
    /// Constructs a UserOperation sent from the `delegator_address` that executes the provided
    /// transaction, with an additional fee note transfer to cover the bundler fees. The
    /// `fee_payer` is the signer that will authorize the fee note transfer to the bundler's
    /// address for the estimated fee amount in `fee_token`.
    pub async fn prepare_userop<R: Rng>(
        &mut self,
        builder: TransactionBuilder,
        bundler: &dyn Bundler,
        delegator_address: Address,
        fee_payer: Arc<dyn RailgunSigner>,
        fee_token: Address,
        tail_calls: Vec<TailCall>,
        rng: &mut R,
    ) -> Result<SignableUserOperation, RailgunProviderError> {
        if fee_token != self.chain.wrapped_base_token {
            return Err(RailgunProviderError::Other(Box::new(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "Currently only the wrapped base token is supported for fee payment",
            ))));
        }

        let fee_asset = AssetId::Erc20(fee_token);

        // 7702 authorization
        let auth_nonce = self
            .provider
            .transaction_count(delegator_address, None)
            .await?;
        let sender_nonce_key = U192::ZERO;

        //? Initial arbitrary estimation of fee note value.
        //? IMPORTANT: Needs to be high enough to not cause a revert. Most
        //? bundlers seem to use a fixed maxCost value for estimation (IE 27_000_000
        //? for pimlico). Setting this too low causes an unrecoverable estimation
        //? failure.
        let mut fee_value = 100_000_000;

        info!("Iteratively building UserOperation to converge on accurate fee estimate");
        for _ in 0..5 {
            let broadcast_builder = builder.clone().transfer(
                fee_payer.clone(),
                RailgunAddress::from_public_keys(
                    MasterPublicKey::from_bytes(*PAYMASTER_MASTER_PUBLIC_KEY),
                    ViewingPublicKey::from_bytes(*PAYMASTER_VIEWING_PUBLIC_KEY),
                    crate::account::chain::ChainId::evm(self.chain.id),
                ),
                fee_asset,
                fee_value,
                "fee",
            );
            info!(
                "Building broadcast transaction with fee value: {}",
                fee_value
            );
            let mut operations = self.build_operation(broadcast_builder, rng).await?;
            let poi_operations = operations.clone();

            // Remove the fee note from the operations
            let fee_operation = take_fee_operation(&mut operations, fee_asset, fee_value)?;
            let fee_note = get_fee_note(&fee_operation, fee_asset, fee_value)?;

            // Construct UserOp Calldata
            let fee_calldata: Bytes = RailgunSmartWallet::transactCall {
                _transactions: vec![fee_operation.transaction],
            }
            .abi_encode()
            .into();

            let railgun_tail_call = TailCall::new(
                self.chain.railgun_smart_wallet,
                RailgunSmartWallet::transactCall {
                    _transactions: operations.into_iter().map(|op| op.transaction).collect(),
                }
                .abi_encode()
                .into(),
            );
            let mut tail_calls = tail_calls.clone();
            tail_calls.insert(0, railgun_tail_call);

            // Construct UserOperation
            let builder = UserOperationBuilder::new_railgun(
                self.chain.id,
                delegator_address,
                auth_nonce,
                fee_calldata.clone(),
                userop_kit::railgun::FeeCommitment {
                    random: fee_note.random().into(),
                    asset: fee_token,
                    value: fee_value,
                },
            )
            .with_provider_nonce(self.provider.as_ref(), sender_nonce_key)
            .await?
            .with_tail_calls(tail_calls)
            .with_gas_estimate(bundler)
            .await?;
            let mut signable = builder.build();

            // TODO: See if we can unify these two buffers into a single safety
            // margin
            //
            // The bundler seems to find the exact minimum call_gas_limit with
            // no margin.
            // Add 10% headroom so the implementation doesn't sporadically OOG.
            signable.user_op.call_gas_limit = signable.user_op.call_gas_limit * 11 / 10;

            // Add a 10% headroom to the fee estimate to ensure buffer if prices change
            // slightly between estimation and execution
            let total_gas = signable.user_op.total_gas_limit();
            let new_fee = total_gas * signable.user_op.max_fee_per_gas;
            let new_fee = (new_fee * 11) / 10;

            let delta = new_fee.abs_diff(fee_value);
            fee_value = new_fee;

            if delta <= new_fee / 100 {
                // 1% tolerance
                info!("Fee converged at {}", new_fee);
                if let Some(poi_provider) = &mut self.poi_provider {
                    poi_provider.register_ops(&poi_operations).await?;
                }
                return Ok(signable);
            }
            info!("Fee updated to {}, delta: {}", new_fee, delta);
        }

        return Err(RailgunProviderError::Other(Box::new(std::io::Error::new(
            std::io::ErrorKind::Other,
            "Failed to converge on fee estimate",
        ))));
    }

    /// Prepares a self-broadcastable RelayAdapt cross-contract unshield.
    ///
    /// Unshields each `(asset, value)` from `from` to the RelayAdapt contract, runs
    /// `user_calls` inside the RelayAdapt multicall (msg.sender == RelayAdapt), then
    /// re-shields `reshields` back into the pool (use `value = 0` to re-shield the entire
    /// remaining balance of that token). Returns calldata for
    /// `RelayAdapt.relay(transactions, actionData)`, to be broadcast by a funded EOA — the
    /// broadcaster pays gas but never custodies the unshielded funds.
    ///
    /// `min_gas_limit` is the value placed verbatim in `actionData.minGasLimit`
    /// (railgun-community uses the requested minimum minus 150_000, e.g. 3_050_000 by
    /// default); the broadcast envelope `gasLimit` must be at least the un-reduced minimum
    /// (e.g. 3_200_000). The same `actionData` instance is used for both the bound
    /// `adaptParams` and the final `relay` calldata, satisfying the on-chain MITM check.
    pub async fn prepare_relay_adapt_unshield<R: Rng>(
        &mut self,
        from: Arc<dyn RailgunSigner>,
        unshields: Vec<(AssetId, u128)>,
        user_calls: Vec<(Address, Bytes, U256)>,
        reshields: Vec<(RailgunAddress, AssetId, u128)>,
        require_success: bool,
        min_gas_limit: u128,
        rng: &mut R,
    ) -> Result<TxData, RailgunProviderError> {
        let relay = self.chain.relay_adapt_contract;

        // (a) Build the unshield operations to the RelayAdapt contract (unproved).
        let mut builder = self.transact();
        for (asset, value) in &unshields {
            builder = builder.unshield(from.clone(), relay, asset.clone(), *value)?;
        }
        let in_notes = self.all_unspent().await;
        let operations = builder.build_operations(&in_notes, rng)?;

        // (b) Per-operation nullifiers (pre-proof), in operation order -> bytes32[][].
        // Must align with each on-chain Transaction.nullifiers (same note.nullifier, same order).
        let nullifiers_per_tx: Vec<Vec<FixedBytes<32>>> = operations
            .iter()
            .map(|op| {
                op.in_notes()
                    .iter()
                    .map(|n| FixedBytes::<32>::from(n.nullifier.to_be_bytes::<32>()))
                    .collect()
            })
            .collect();

        // (c) Re-shield requests, appended as a single RelayAdapt.shield call AFTER the user calls.
        let shield_requests = reshields
            .into_iter()
            .map(|(recipient, asset, value)| encrypt_shield(recipient, asset, value, rng))
            .collect::<Result<Vec<ShieldRequest>, _>>()
            .map_err(TransactionBuilderError::Encryption)?;

        let mut calls: Vec<RelayAdapt::Call> = user_calls
            .into_iter()
            .map(|(to, data, value)| RelayAdapt::Call { to, data, value })
            .collect();
        if !shield_requests.is_empty() {
            calls.push(RelayAdapt::Call {
                to: relay,
                data: RelayAdapt::shieldCall {
                    _shieldRequests: shield_requests,
                }
                .abi_encode()
                .into(),
                value: U256::ZERO,
            });
        }

        // (d) ActionData + adaptParams. The SAME action_data feeds the hash and the relay calldata.
        let mut random = [0u8; 31];
        rng.fill(&mut random[..]);
        let action_data = RelayAdapt::ActionData {
            random: FixedBytes::<31>::from(random),
            requireSuccess: require_success,
            minGasLimit: U256::from(min_gas_limit),
            calls,
        };
        let adapt_params =
            get_relay_adapt_params(nullifiers_per_tx, operations.len(), action_data.clone());

        // (e) Prove each operation with the RelayAdapt adapt params bound into BoundParams.
        let proved = TransactionBuilder::prove(
            &self.prover,
            &self.utxo_indexer.utxo_trees,
            self.chain.id,
            &operations,
            Some((relay, adapt_params)),
            rng,
        )
        .await?;
        if let Some(poi_provider) = &mut self.poi_provider {
            poi_provider.register_ops(&proved).await?;
        }

        // (f) Assemble RelayAdapt.relay(transactions, actionData) -> self-broadcastable TxData.
        let transactions = proved.iter().map(|op| op.transaction.clone()).collect();
        let calldata = RelayAdapt::relayCall {
            _transactions: transactions,
            _actionData: action_data,
        }
        .abi_encode();
        Ok(TxData::new(relay, calldata.into(), U256::ZERO))
    }

    async fn all_unspent(&mut self) -> Vec<UtxoNote> {
        let addresses = self.utxo_indexer.registered();
        let mut all_notes = Vec::new();

        for address in addresses {
            let mut notes = self.unspent(address).await;
            all_notes.append(&mut notes);
        }
        all_notes
    }

    async fn unspent(&mut self, address: RailgunAddress) -> Vec<UtxoNote> {
        let notes = self.utxo_indexer.unspent(address);

        let Some(poi_provider) = &mut self.poi_provider else {
            return notes;
        };

        let mut spendable_notes = Vec::new();
        for note in notes {
            let status = poi_provider
                .status(note.blinded_commitment.into(), note.commitment_type)
                .await;
            match status {
                Ok(PoiStatus::Valid) => spendable_notes.push(note),
                Ok(status) => {
                    info!("Note {} not spendable: {status:?}", note);
                    continue;
                }
                Err(e) => {
                    warn!("Error checking POI for note {}: {}", note, e);
                    continue;
                }
            }
        }

        spendable_notes
    }

    async fn build_operation<R: Rng>(
        &mut self,
        builder: TransactionBuilder,
        rng: &mut R,
    ) -> Result<Vec<ProvedOperation>, RailgunProviderError> {
        let in_notes = self.all_unspent().await;
        let operations = builder
            .build(
                &self.prover,
                self.chain.id,
                &in_notes,
                &self.utxo_indexer.utxo_trees,
                rng,
            )
            .await?;

        Ok(operations)
    }
}

/// Takes the operation containing the fee note, removing it from the provided operations vector.
fn take_fee_operation(
    operations: &mut Vec<ProvedOperation>,
    fee_asset: AssetId,
    fee_value: u128,
) -> Result<ProvedOperation, RailgunProviderError> {
    let Some(fee_note_pos) = operations.iter().position(|o| {
        o.inner
            .out_notes()
            .iter()
            .any(|n| is_fee_note(n, fee_asset, fee_value))
    }) else {
        return Err(RailgunProviderError::FeeNoteNotFound);
    };
    Ok(operations.remove(fee_note_pos))
}

/// Gets the fee note from the operation
fn get_fee_note(
    operation: &ProvedOperation,
    fee_asset: AssetId,
    fee_value: u128,
) -> Result<Box<dyn Note>, RailgunProviderError> {
    operation
        .inner
        .out_notes()
        .into_iter()
        .find(|n| is_fee_note(n, fee_asset, fee_value))
        .ok_or(RailgunProviderError::FeeNoteNotFound)
}

fn is_fee_note(note: &Box<dyn Note>, fee_asset: AssetId, fee_value: u128) -> bool {
    note.asset() == fee_asset && note.value() == fee_value && note.memo() == "fee"
}
