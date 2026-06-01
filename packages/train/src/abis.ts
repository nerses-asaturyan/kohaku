import { parseAbi, parseAbiParameters } from 'viem';

/**
 * TRAIN protocol surface used by the bridge (signatures copied verbatim from the
 * POC's `src/Train.sol` / scripts — we reference TRAIN, we do not fork it).
 */
export const TRAIN_ABI = parseAbi([
  'function userLock((bytes32 hashlock,uint256 amount,uint256 rewardAmount,uint48 timelockDelta,uint48 rewardTimelockDelta,uint48 quoteExpiry,address refundTo,address recipient,address token,string rewardToken,string rewardRecipient,string srcChain) params,(string dstChain,string dstAddress,uint256 dstAmount,string dstToken) dst,bytes userData,bytes solverData) payable',
  'function solverLock((bytes32 hashlock,uint256 amount,uint256 reward,uint48 timelockDelta,uint48 rewardTimelockDelta,address refundTo,address recipient,address rewardRecipient,address token,address rewardToken,string srcChain) params,(string dstChain,string dstAddress,uint256 dstAmount,string dstToken) dst,bytes data) payable returns (uint256)',
  'function redeemUser(bytes32 hashlock,uint256 secret)',
  'function redeemSolver(bytes32 hashlock,uint256 index,uint256 secret)',
  'function refundUser(bytes32 hashlock)',
  'function refundSolver(bytes32 hashlock,uint256 index)',
  'function getSolverLockCount(bytes32 hashlock) view returns (uint256)',
  'function getSolverLock(bytes32 hashlock,uint256 index) view returns ((uint256 secret,uint256 amount,uint256 reward,address sender,uint48 timelock,uint48 rewardTimelock,address recipient,uint8 status,address rewardRecipient,address token,address rewardToken) lock)',
]);

/** Destination atomic redeem+shield wrapper (POC `src/ShieldedReceiver.sol`). */
export const SHIELDED_RECEIVER_ABI = parseAbi([
  'function redeemAndShield(bytes32 hashlock,uint256 index,uint256 r,address trainToken,(bytes32 npk,(uint8 tokenType,address tokenAddress,uint256 tokenSubID) token,bytes32[3] encryptedBundle,bytes32 shieldKey) template)',
  'event ShieldedRedeemed(bytes32 indexed hashlock,uint256 indexed index,address indexed broadcaster,address trainToken,uint256 amount)',
]);

export const ERC20_ABI = parseAbi([
  'function approve(address spender,uint256 amount) returns (bool)',
  'function allowance(address owner,address spender) view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
]);

/** RailgunSmartWallet.shield(ShieldRequest[]) — used to DECODE `prepareShield` calldata for the template. */
export const RAILGUN_SHIELD_ABI = parseAbi([
  'function shield(((bytes32 npk,(uint8 tokenType,address tokenAddress,uint256 tokenSubID) token,uint120 value) preimage,(bytes32[3] encryptedBundle,bytes32 shieldKey) ciphertext)[] requests)',
]);

/** LockStatus enum from `src/Train.sol`. */
export const LOCK_STATUS = { Empty: 0, Pending: 1, Refunded: 2, Redeemed: 3 } as const;

/**
 * ABI parameters for the HTLC binding hash:
 *   secret = keccak256(abi.encode(uint256 r, address dstTrainToken, ShieldRequestTemplate template))
 * Field order MUST match `ShieldedReceiver.computeBinding` and the POC's TEMPLATE_ABI.
 */
export const BINDING_PARAMS = parseAbiParameters(
  'uint256, address, (bytes32 npk, (uint8 tokenType, address tokenAddress, uint256 tokenSubID) token, bytes32[3] encryptedBundle, bytes32 shieldKey)',
);
