import type { Host, Storage } from '@kohaku-eth/plugins';
import type { TxSigner } from '@kohaku-eth/provider';
import type { RailgunPlugin } from '@kohaku-eth/railgun';
import type { Hex } from 'viem';

import { completeShield } from './complete';
import { type CreateBridgeIntentArgs, createBridgeIntent } from './intent';
import { type RelayAdaptUnshieldFn, relayAdaptUnshieldViaPlugin } from './railgun';
import { refundBridge } from './refund';
import { reverifyShieldedRedeem } from './reverify';
import { listHandles, loadHandle } from './state';
import { submitIntent } from './submit';
import { trackFill } from './track';
import type { BridgeCallbacks, BridgeHandle, BridgeIntent } from './types';

export type TrainBridgeSide = {
  host: Host;
  railgun: RailgunPlugin;
};

export type TrainBridgeOpts = {
  /** Source side (Arbitrum Sepolia): provider + railgun + funded non-custodial broadcaster. */
  src: TrainBridgeSide & {
    broadcaster: TxSigner;
    /** Override the RelayAdapt source spend (default: via the railgun plugin's extension). */
    relayAdaptUnshield?: RelayAdaptUnshieldFn;
  };
  /** Destination side (Ethereum Sepolia): provider (Helios) + railgun + funded gas relayer. */
  dst: TrainBridgeSide & {
    relayer: TxSigner;
  };
  callbacks?: BridgeCallbacks;
  trainStationUrl?: string;
};

/** Args to start a bridge — everything `createBridgeIntent` needs except the wired-in pieces. */
export type StartBridgeArgs = Omit<CreateBridgeIntentArgs, 'dstRailgun' | 'trainStationUrl'>;

export type TrainBridge = {
  createIntent(args: StartBridgeArgs): Promise<BridgeIntent>;
  submit(intent: BridgeIntent, handle?: BridgeHandle): Promise<BridgeHandle>;
  /** Convenience: createIntent + submit. */
  start(args: StartBridgeArgs): Promise<BridgeHandle>;
  track(handle: BridgeHandle, opts?: { timeoutMs?: number; intervalMs?: number; signal?: AbortSignal }): Promise<BridgeHandle>;
  complete(handle: BridgeHandle, opts?: { verify?: boolean }): Promise<BridgeHandle>;
  /** Recovery: re-run destination verification on a FAILED handle whose redeem WAS broadcast
   *  (dstTxHash present); promotes FAILED → COMPLETED when the redeem checks out on-chain. */
  reverify(handle: BridgeHandle): Promise<BridgeHandle>;
  refund(handle: BridgeHandle): Promise<BridgeHandle>;
  loadBridge(hashlock: Hex): BridgeHandle | null;
  listBridges(): BridgeHandle[];
};

/**
 * UI/extension entry point — composes two `RailgunPlugin`s + TRAIN into a bridge.
 * Mirrors `createRailgunPlugin`/`createPPv1Plugin`: providers/signers are injected,
 * every step is independently callable and resumable, and all handle state is
 * persisted to a single storage (the source host's) so the UI can list/resume.
 */
export function createTrainBridge(opts: TrainBridgeOpts): TrainBridge {
  const { callbacks } = opts;
  // One canonical storage for the whole bridge lifecycle (src + dst steps).
  const storage: Storage = opts.src.host.storage;
  const relayAdaptUnshield = opts.src.relayAdaptUnshield ?? relayAdaptUnshieldViaPlugin(opts.src.railgun);

  const createIntent = (args: StartBridgeArgs): Promise<BridgeIntent> =>
    createBridgeIntent({ ...args, dstRailgun: opts.dst.railgun, trainStationUrl: opts.trainStationUrl });

  const submit = async (intent: BridgeIntent, handle?: BridgeHandle): Promise<BridgeHandle> => {
    const reshieldTo = await opts.src.railgun.instanceId();

    return submitIntent({
      srcHost: opts.src.host,
      broadcaster: opts.src.broadcaster,
      intent,
      relayAdaptUnshield,
      reshieldTo,
      handle,
      storage,
      callbacks,
    });
  };

  return {
    createIntent,
    submit,
    async start(args: StartBridgeArgs): Promise<BridgeHandle> {
      const intent = await createIntent(args);

      return submit(intent);
    },
    track: (handle, o) =>
      trackFill({ dstHost: opts.dst.host, handle, storage, callbacks, timeoutMs: o?.timeoutMs, intervalMs: o?.intervalMs, signal: o?.signal }),
    complete: (handle, o) =>
      completeShield({ dstHost: opts.dst.host, handle, relayer: opts.dst.relayer, storage, callbacks, verify: o?.verify }),
    reverify: (handle) => reverifyShieldedRedeem({ dstHost: opts.dst.host, handle, storage, callbacks }),
    refund: (handle) =>
      refundBridge({ srcHost: opts.src.host, handle, relayer: opts.src.broadcaster, storage, callbacks }),
    loadBridge: (hashlock) => loadHandle(storage, hashlock),
    listBridges: () => listHandles(storage),
  };
}
