import { DEFAULT_TRAIN_STATION_URL } from './config';

/** Minimal Station response surface we depend on (the SDK ships hard-to-import .d.ts). */
export type TrainNetwork = {
  caip2Id: string;
  chainId: string;
  trainContract: string;
  nativeTokenAddress: string;
  tokens?: { symbol: string; contract: string; decimals: number }[];
};

export type TrainQuote = {
  signature: string;
  receiveAmount: string;
  sourceSolverAddress: string;
  destinationSolverAddress: string;
  quoteExpirationTimestampInSeconds: number;
  timelockTimeSpanInSeconds: number;
  route: {
    source: { network: string; tokenDecimals?: number };
    destination: { network: string; tokenSymbol: string; tokenContract: string };
  };
  reward: {
    amount: string;
    rewardTimelockTimeSpanInSeconds: number;
    rewardToken: string;
    rewardRecipientAddress: string;
  };
};

// `solver.id` is quoted to avoid the repo's bare-`id` identifier lint rule.
export type SolverQuote = { solver: { 'id'?: string; name?: string }; isBest: boolean; quote?: TrainQuote };
export type AggregatedQuoteResponse = { quotes: SolverQuote[]; errors?: { solverId: string; message: string }[] };

export type QuoteRequest = {
  amount: string; // smallest unit
  sourceNetwork: string; // CAIP-2
  sourceTokenContract?: string;
  destinationNetwork: string; // CAIP-2
  destinationTokenContract?: string;
  includeReward?: boolean;
};

export interface TrainApi {
  getNetworks(): Promise<TrainNetwork[]>;
  getQuote(p: QuoteRequest): Promise<AggregatedQuoteResponse>;
}

/** Human label for a solver quote (id, else name, else "unknown"). */
export function solverLabel(sq: SolverQuote): string {
  return sq.solver?.['id'] ?? sq.solver?.name ?? 'unknown';
}

/** Lazily load `@train-protocol/sdk`'s `TrainApiClient` (kept dynamic so bundling never hard-fails on it). */
export async function loadTrainApi(baseUrl: string = DEFAULT_TRAIN_STATION_URL): Promise<TrainApi> {
  const sdk = (await import('@train-protocol/sdk')) as unknown as {
    TrainApiClient: new (c: { baseUrl: string }) => TrainApi;
  };

  if (!sdk?.TrainApiClient) throw new Error('@train-protocol/sdk did not export TrainApiClient');

  return new sdk.TrainApiClient({ baseUrl });
}
