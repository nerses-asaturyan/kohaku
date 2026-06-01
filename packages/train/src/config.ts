import { type Address, getAddress } from 'viem';

export type TrainChainConfig = {
  chainId: number;
  /** CAIP-2 id used by TRAIN (e.g. "eip155:421614"). */
  caip2: string;
  railgunProxy: Address;
  relayAdapt: Address;
  weth: Address;
  /**
   * Canonical TRAIN contract on this chain. On the SOURCE chain the authoritative
   * address comes from the Station `/networks` response; this is the fallback.
   */
  trainContract: Address;
  /** Present on the DESTINATION chain — the deployed ShieldedReceiver. */
  shieldedReceiver?: Address;
};

/** SOURCE chain. Paymaster/7702-IMPL are NOT deployed here → source uses RelayAdapt + a funded EOA broadcaster. */
export const ARBITRUM_SEPOLIA: TrainChainConfig = {
  chainId: 421614,
  caip2: 'eip155:421614',
  railgunProxy: getAddress('0x9Bfa29dC6cA794b8A49bC928EB4F5bBD80CD5Ab9'),
  relayAdapt: getAddress('0x4B24c032569A45266F057EcE1Fd189a619D58ce6'),
  weth: getAddress('0x980B62Da83eFf3D4576C647993b0c1D7faf17c73'),
  // Source Train (POC DST_TRAIN_ADDRESS). The Station /networks trainContract overrides this at quote time.
  trainContract: getAddress('0x39c58617d355d8b432a3675714b93ec840872236'),
};

/** DESTINATION chain. Helios-verifiable; ShieldedReceiver deployed here. */
export const ETHEREUM_SEPOLIA: TrainChainConfig = {
  chainId: 11155111,
  caip2: 'eip155:11155111',
  railgunProxy: getAddress('0xeCFCf3b4eC647c4Ca6D49108b311b7a7C9543fea'),
  relayAdapt: getAddress('0x7e3d929EbD5bDC84d02Bd3205c777578f33A214D'),
  weth: getAddress('0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14'),
  // Destination Train that the ShieldedReceiver below was deployed against (POC TRAIN_ADDRESS).
  trainContract: getAddress('0x8cEa9E4Bee95c6029A41750F66f13Cf50c918Ce6'),
  shieldedReceiver: getAddress('0x4DB9263e0f9536777cAb3ea31D61C10D56bD604C'),
};

export const TRAIN_CHAINS: Record<number, TrainChainConfig> = {
  [ARBITRUM_SEPOLIA.chainId]: ARBITRUM_SEPOLIA,
  [ETHEREUM_SEPOLIA.chainId]: ETHEREUM_SEPOLIA,
};

export function trainChain(chainId: number): TrainChainConfig {
  const config = TRAIN_CHAINS[chainId];

  if (!config) throw new Error(`Unsupported TRAIN chain id ${chainId}`);

  return config;
}

/** Default direction: Arbitrum Sepolia (source) → Ethereum Sepolia (destination). */
export const DEFAULT_SOURCE_CHAIN_ID = ARBITRUM_SEPOLIA.chainId;
export const DEFAULT_DEST_CHAIN_ID = ETHEREUM_SEPOLIA.chainId;

/** Public Train testnet Station. Override with the `trainStationUrl` option. */
export const DEFAULT_TRAIN_STATION_URL = 'https://train-solver-station.dev.lb.layerswap.cloud';

// Railgun economics / safety constants (match the Sepolia/Arb proxies).
export const RAILGUN_UNSHIELD_FEE_BPS = 25n; // 0.25%
export const UNSHIELD_BUFFER_WEI = 10n; // absorb floor-division loss; swept back via reshield residue
export const UINT120_MAX = (1n << 120n) - 1n; // Railgun shield value cap

// Solver-fill polling defaults.
export const DEFAULT_DISCOVER_TIMEOUT_MS = 600_000;
export const DEFAULT_DISCOVER_INTERVAL_MS = 15_000;

export const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000';
