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

/** Helios-verifiable (ethereum kind). Has both a Train contract and a ShieldedReceiver → can be source OR destination. */
export const ETHEREUM_SEPOLIA: TrainChainConfig = {
  chainId: 11155111,
  caip2: 'eip155:11155111',
  railgunProxy: getAddress('0xeCFCf3b4eC647c4Ca6D49108b311b7a7C9543fea'),
  relayAdapt: getAddress('0x7e3d929EbD5bDC84d02Bd3205c777578f33A214D'),
  weth: getAddress('0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14'),
  // Train this chain's ShieldedReceiver was deployed against. As SOURCE, the Station /networks
  // trainContract overrides this at quote time; this is the fallback.
  trainContract: getAddress('0x8cEa9E4Bee95c6029A41750F66f13Cf50c918Ce6'),
  shieldedReceiver: getAddress('0x4DB9263e0f9536777cAb3ea31D61C10D56bD604C'),
};

/** Linea Sepolia. Full Railgun + Train + ShieldedReceiver stack deployed → can be source OR destination. */
export const LINEA_SEPOLIA: TrainChainConfig = {
  chainId: 59141,
  caip2: 'eip155:59141',
  railgunProxy: getAddress('0xD6C73faEB021253007C833d742F34A2C5Fe2bA55'),
  relayAdapt: getAddress('0x05dba0BcBF7a3c7f13173c607ED4624F7CB13C53'),
  weth: getAddress('0x06565ed324Ee9fb4DB0FF80B7eDbE4Cb007555a3'),
  trainContract: getAddress('0x473d2032f0389075c5067D972b250Fe8437588B3'),
  shieldedReceiver: getAddress('0x550651a0Eb9ABe14774E6fa90D63a7D9b605111c'),
};

/** Base Sepolia (opstack — Helios-verifiable via the default consensus endpoint). Full Railgun +
 *  Train + ShieldedReceiver stack deployed → can be source OR destination. */
export const BASE_SEPOLIA: TrainChainConfig = {
  chainId: 84532,
  caip2: 'eip155:84532',
  railgunProxy: getAddress('0x31b1bAf7171F196F0798062dA8f8078D521B1f8b'),
  relayAdapt: getAddress('0x1691fe4E90A723ed077F2010F3931609D92aE6aB'),
  weth: getAddress('0x4200000000000000000000000000000000000006'),
  // Matches the Station /networks trainContract for eip155:84532 (overridden at quote time anyway).
  trainContract: getAddress('0x1573acd71a67440ba25f9fae9388b5b94e1ab881'),
  shieldedReceiver: getAddress('0xbbaefcb0ee512358b6c82f2eb4e1847cc10a310f'),
};

export const TRAIN_CHAINS: Record<number, TrainChainConfig> = {
  [ETHEREUM_SEPOLIA.chainId]: ETHEREUM_SEPOLIA,
  [LINEA_SEPOLIA.chainId]: LINEA_SEPOLIA,
  [BASE_SEPOLIA.chainId]: BASE_SEPOLIA,
};

export function trainChain(chainId: number): TrainChainConfig {
  const config = TRAIN_CHAINS[chainId];

  if (!config) throw new Error(`Unsupported TRAIN chain id ${chainId}`);

  return config;
}

/** Default direction: Ethereum Sepolia (source) → Linea Sepolia (destination). */
export const DEFAULT_SOURCE_CHAIN_ID = ETHEREUM_SEPOLIA.chainId;
export const DEFAULT_DEST_CHAIN_ID = LINEA_SEPOLIA.chainId;

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
