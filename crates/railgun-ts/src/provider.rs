use std::str::FromStr;

use alloy::primitives::{Address, Bytes, U256};
use eip_1193_provider::tx_data::TxData;
use railgun::{account::address::RailgunAddress, caip::AssetId, provider::RailgunProvider};
use serde::{Deserialize, Serialize};
use tsify::Tsify;
use userop_kit::railgun::TailCall;
use userop_kit_ts::{bundler::JsBundler, signable_user_operation::JsSignableUserOperation};
use wasm_bindgen::{JsError, prelude::wasm_bindgen};

use crate::{
    shield_builder::JsShieldBuilder, signer::JsRailgunSigner,
    transaction_builder::JsTransactionBuilder,
};

/// Interfaces with the RAILGUN protocol.
#[wasm_bindgen(js_name = "RailgunProvider")]
pub struct JsRailgunProvider {
    inner: RailgunProvider,
}

#[derive(Tsify, Serialize)]
#[tsify(into_wasm_abi)]
#[serde(transparent)]
pub struct Balances(Vec<(AssetId, u128)>);

/// An asset + amount for a RelayAdapt unshield/re-shield (amount `0` re-shields the
/// entire remaining balance of that asset).
#[derive(Tsify, Deserialize)]
#[tsify(from_wasm_abi)]
#[serde(rename_all = "camelCase")]
pub struct JsAssetAmount {
    pub asset: AssetId,
    #[tsify(type = "bigint")]
    pub amount: u128,
}

/// A cross-contract call executed by the RelayAdapt multicall (msg.sender == RelayAdapt).
#[derive(Tsify, Deserialize)]
#[tsify(from_wasm_abi)]
#[serde(rename_all = "camelCase")]
pub struct JsRelayCall {
    #[tsify(type = "`0x${string}`")]
    pub to: Address,
    #[tsify(type = "`0x${string}`")]
    pub data: Bytes,
    #[tsify(type = "bigint")]
    pub value: u128,
}

/// Request for `prepareRelayAdaptUnshield`. `minGasLimit` is placed verbatim in
/// `actionData.minGasLimit` (use the reduced value, e.g. 3_050_000).
#[derive(Tsify, Deserialize)]
#[tsify(from_wasm_abi)]
#[serde(rename_all = "camelCase")]
pub struct RelayAdaptUnshieldRequest {
    pub unshields: Vec<JsAssetAmount>,
    pub calls: Vec<JsRelayCall>,
    pub reshields: Vec<JsAssetAmount>,
    pub require_success: bool,
    #[tsify(type = "bigint")]
    pub min_gas_limit: u128,
}

impl JsRailgunProvider {
    pub fn new(inner: RailgunProvider) -> Self {
        Self { inner }
    }
}

#[wasm_bindgen(js_class = "RailgunProvider")]
impl JsRailgunProvider {
    /// Register a signer with the provider. The provider will index and track
    /// UTXOs for the associated address.
    pub async fn register(&mut self, account: &JsRailgunSigner) -> Result<(), JsError> {
        self.inner
            .register(account.inner())
            .await
            .map_err(|e| JsError::new(&e.to_string()))
    }

    /// Syncs the provider to the latest block.
    pub async fn sync(&mut self) -> Result<(), JsError> {
        self.inner
            .sync()
            .await
            .map_err(|e| JsError::new(&e.to_string()))
    }

    /// Returns the balance for the given address.
    ///
    /// If POI is enabled, only returns the spendable balance according to the POI provider.
    pub async fn balance(&mut self, address: RailgunAddress) -> Balances {
        let balances = self.inner.balance(address.clone()).await;
        Balances(balances.into_iter().collect())
    }

    /// Helper to create a shield builder.
    pub fn shield(&self) -> JsShieldBuilder {
        JsShieldBuilder {
            inner: self.inner.shield(),
        }
    }

    /// Helper to create a transaction builder.
    pub fn transact(&self) -> JsTransactionBuilder {
        JsTransactionBuilder {
            inner: self.inner.transact(),
        }
    }

    /// Build a transaction builder into a proved, signable transaction.
    pub async fn build(&mut self, builder: JsTransactionBuilder) -> Result<TxData, JsError> {
        let mut rng = rand::rng();
        let proved_tx = self
            .inner
            .build(builder.inner, &mut rng)
            .await
            .map_err(|e| JsError::new(&e.to_string()))?;
        Ok(proved_tx.tx_data)
    }

    /// Build a transaction builder into a broadcastable 7702 UserOperation.
    ///
    /// Constructs a UserOperation sent from the `delegatorAddress` that executes the provided
    /// transaction, with an additional fee note transfer to cover the bundler fees. The
    /// `fee_payer` is the signer that will authorize the fee note transfer to the bundler's
    /// address for the estimated fee amount in `fee_token`.
    #[wasm_bindgen(js_name = "prepareUserOp")]
    pub async fn prepare_userop(
        &mut self,
        builder: JsTransactionBuilder,
        bundler: &JsBundler,
        #[wasm_bindgen(js_name = "delegatorAddress", unchecked_param_type = "`0x${string}`")]
        delegator_address: String,
        #[wasm_bindgen(js_name = "feePayer")] fee_payer: &JsRailgunSigner,
        #[wasm_bindgen(js_name = "feeToken", unchecked_param_type = "`0x${string}`")]
        fee_token: String,
        #[wasm_bindgen(js_name = "tailCalls")] tail_calls: Option<Vec<TailCall>>,
    ) -> Result<JsSignableUserOperation, JsError> {
        let delegator_address =
            Address::from_str(&delegator_address).map_err(|e| JsError::new(&e.to_string()))?;
        let fee_token = Address::from_str(&fee_token).map_err(|e| JsError::new(&e.to_string()))?;
        let tail_calls = tail_calls.unwrap_or_default();
        let mut rng = rand::rng();

        let signable = self
            .inner
            .prepare_userop(
                builder.inner.clone(),
                bundler.inner().as_ref(),
                delegator_address,
                fee_payer.inner(),
                fee_token,
                tail_calls,
                &mut rng,
            )
            .await
            .map_err(|e| JsError::new(&e.to_string()))?;
        Ok(JsSignableUserOperation::new(signable))
    }

    /// Prepares a self-broadcastable RelayAdapt cross-contract unshield: unshields to the
    /// RelayAdapt contract, runs `calls`, then re-shields `reshields` back to `from`'s own
    /// 0zk address. Returns `RelayAdapt.relay(...)` calldata as a `TxData` for a funded EOA
    /// broadcaster (the broadcaster pays gas but never custodies the funds).
    #[wasm_bindgen(js_name = "prepareRelayAdaptUnshield")]
    pub async fn prepare_relay_adapt_unshield(
        &mut self,
        from: &JsRailgunSigner,
        req: RelayAdaptUnshieldRequest,
    ) -> Result<TxData, JsError> {
        let reshield_recipient = from.address();
        let unshields = req.unshields.into_iter().map(|a| (a.asset, a.amount)).collect();
        let user_calls = req
            .calls
            .into_iter()
            .map(|c| (c.to, c.data, U256::from(c.value)))
            .collect();
        let reshields = req
            .reshields
            .into_iter()
            .map(|a| (reshield_recipient.clone(), a.asset, a.amount))
            .collect();
        let mut rng = rand::rng();

        self.inner
            .prepare_relay_adapt_unshield(
                from.inner(),
                unshields,
                user_calls,
                reshields,
                req.require_success,
                req.min_gas_limit,
                &mut rng,
            )
            .await
            .map_err(|e| JsError::new(&e.to_string()))
    }
}
