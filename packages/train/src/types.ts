import type { Address, Hex } from 'viem';

/**
 * Bridge asset kind. We bridge WETH-as-ERC20 end-to-end (a Railgun "native"
 * balance is shielded as WETH), so `erc20` is the supported path; `native`
 * is reserved for parity with the POC.
 */
export type XChainKind = 'erc20' | 'native';

/**
 * Railgun shield-request template recovered from a `prepareShield` calldata
 * (`shield(ShieldRequest[])`). The destination `ShieldedReceiver` binds the
 * HTLC secret to this template and re-uses it to shield the payout.
 *
 * JSON-safe: `tokenSubID` is a decimal string (convert to bigint when encoding).
 * Note: `shieldKey` is a PUBLIC key — there is no `shieldPrivateKey`.
 */
export type ShieldRequestTemplate = {
  npk: Hex;
  token: { tokenType: number; tokenAddress: Address; tokenSubID: string };
  encryptedBundle: [Hex, Hex, Hex];
  shieldKey: Hex;
};

/** Lifecycle of a single bridge, persisted to `host.storage`. */
export enum BridgeState {
  Created = 'CREATED',
  SourceLocked = 'SOURCE_LOCKED',
  Filled = 'FILLED',
  Completed = 'COMPLETED',
  TimedOut = 'TIMED_OUT',
  Refunded = 'REFUNDED',
  Failed = 'FAILED',
}

/**
 * Everything needed to submit the source lock and complete on the destination.
 * Fully JSON-serializable (bigints as decimal strings, addresses/hashes as hex).
 */
export type BridgeIntent = {
  kind: XChainKind;
  createdAt: string;

  // HTLC binding (secret = keccak256(abi.encode(r, dstTrainToken, template))).
  r: string; // uint256 decimal
  secret: string; // uint256 decimal
  hashlock: Hex; // bytes32, = sha256(secret)
  template: ShieldRequestTemplate;

  // Routing + tokens.
  srcChainId: number; // 421614 (Arbitrum Sepolia)
  dstChainId: number; // 11155111 (Ethereum Sepolia)
  srcTrainAddress: Address; // Train on the source chain (from the Station quote)
  dstTrainToken: Address; // destination Train lock token (== shieldToken, WETH on dst)
  shieldToken: Address; // token shielded into the dst 0zk (WETH on dst)
  shieldedReceiverAddress: Address; // ShieldedReceiver on the dst chain
  railgunAddress: string; // destination 0zk recipient

  // Source userLock (already encoded with the binding hashlock substituted).
  unshieldToken: Address; // source WETH (ERC20) to unshield
  lockAmount: string; // uint256 decimal, WETH locked on the source Train
  grossUnshield: string; // uint256 decimal, amount to unshield (fee + buffer on top)
  userLockCalldata: Hex; // encoded Train.userLock(...)
  userLockValueWei: string; // "0" on the WETH/ERC20 path

  // Bookkeeping.
  solverId?: string;
  quoteExpiry?: string; // absolute unix seconds
  timelockDelta?: string; // seconds
};

/** A tracked bridge: intent + current state + on-chain references. */
export type BridgeHandle = {
  hashlock: Hex;
  state: BridgeState;
  intent: BridgeIntent;
  srcTxHash?: Hex;
  solverIndex?: string;
  dstTxHash?: Hex;
  refundTxHash?: Hex;
  timelock?: string; // absolute unix seconds of the source lock, once known
  createdAt: string;
  updatedAt: string;
  error?: string;
};

export type BridgeProgress = {
  step: BridgeState;
  current: number;
  total: number;
  note?: string;
};

export type BridgeCallbacks = {
  onStateChange?: (handle: BridgeHandle) => void;
  onProgress?: (p: BridgeProgress) => void;
};

/** Decoded `Train.userLock` params (positional tuple → named). */
export type UserLockParams = {
  hashlock: Hex;
  amount: bigint;
  rewardAmount: bigint;
  timelockDelta: bigint;
  rewardTimelockDelta: bigint;
  quoteExpiry: bigint;
  refundTo: Address;
  recipient: Address;
  token: Address;
  rewardToken: string;
  rewardRecipient: string;
  srcChain: string;
};

export type DestinationInfo = {
  dstChain: string;
  dstAddress: string;
  dstAmount: bigint;
  dstToken: string;
};
