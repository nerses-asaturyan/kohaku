/**
 * @kohaku-eth/train — private cross-chain bridge.
 *
 * Railgun shielded pool (Arbitrum Sepolia) -> TRAIN protocol -> Railgun shielded
 * pool (Ethereum Sepolia). Atomic, non-custodial source spend via RelayAdapt; an
 * on-chain ShieldedReceiver completes the destination shield; Helios verifies the
 * destination. See the package README / plan for the full flow.
 */

export * from './types';
export * from './config';

export { computeBinding, extractShieldTemplate, templateToTuple } from './binding';
export { inverseUnshieldGross, ceilDiv } from './fees';

export { createBridgeIntent, type CreateBridgeIntentArgs } from './intent';
export { submitIntent, type SubmitIntentArgs } from './submit';
export { trackFill, type TrackFillArgs } from './track';
export { completeShield, type CompleteShieldArgs } from './complete';
export { refundBridge, type RefundBridgeArgs } from './refund';
export { verifyShieldedRedeem, type VerifyArgs, type VerifyResult } from './verify';

export {
  createTrainBridge,
  type TrainBridge,
  type TrainBridgeOpts,
  type TrainBridgeSide,
  type StartBridgeArgs,
} from './bridge';

export {
  buildShieldTemplate,
  relayAdaptUnshieldViaPlugin,
  type RelayAdaptUnshieldFn,
  type RelayAdaptUnshieldRequest,
  type RelayAdaptCall,
} from './railgun';

export {
  buildUserLock,
  mapQuoteToUserLock,
  substituteHashlock,
  loadTrainApi,
  type TrainApi,
  type TrainNetwork,
  type TrainQuote,
  type QuoteRequest,
  type BuiltUserLock,
  type UserLockMappingArgs,
  type FetchUserLockArgs,
} from './quote';

export {
  loadHandle,
  listHandles,
  saveHandle,
  newHandle,
  transition,
  canTransition,
  commit,
} from './state';

export { serializeHandle, deserializeHandle } from './serialize';

export { TRAIN_ABI, SHIELDED_RECEIVER_ABI, ERC20_ABI, RAILGUN_SHIELD_ABI, LOCK_STATUS } from './abis';
