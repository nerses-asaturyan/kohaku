import type { TxData } from '@kohaku-eth/provider';
import type { RailgunPlugin } from '@kohaku-eth/railgun';
import type { Address, Hex } from 'viem';

import { extractShieldTemplate } from './binding';
import type { ShieldRequestTemplate } from './types';

/**
 * Generate a Railgun shield-request template for the destination payout by
 * populating a dummy 1-wei shield of `dstWeth` to the dst wallet's own 0zk and
 * decoding the resulting `shield(ShieldRequest[])` calldata. The HTLC secret is
 * bound to this template; the on-chain `ShieldedReceiver` re-uses it to shield
 * the payout into the same 0zk.
 */
export async function buildShieldTemplate(
  dstRailgun: RailgunPlugin,
  dstWeth: Address,
): Promise<{ template: ShieldRequestTemplate; railgunAddress: string }> {
  const txs = await dstRailgun.prepareShield({ asset: { __type: 'erc20', contract: dstWeth }, amount: 1n });

  for (const tx of txs) {
    try {
      const template = extractShieldTemplate(tx.data as Hex);
      const railgunAddress = await dstRailgun.instanceId();

      return { template, railgunAddress };
    } catch {
      // not the shield() call (e.g. an approve) — try the next tx
    }
  }
  throw new Error('could not extract a shield template from prepareShield() output');
}

export type RelayAdaptCall = { to: Address; value: bigint; data: Hex };

export type RelayAdaptUnshieldRequest = {
  /** ERC20 to unshield (WETH on the source). */
  unshieldToken: Address;
  /** Gross amount to unshield (net lock amount + fee + buffer). */
  grossAmount: bigint;
  /** 0zk address to receive re-shielded change (the source wallet itself). */
  reshieldTo: string;
  /** Ordered cross-contract calls executed by RelayAdapt after the unshield. */
  calls: RelayAdaptCall[];
};

/**
 * Produce a proved, self-broadcastable transaction that unshields `unshieldToken`
 * into RelayAdapt, runs `calls` (e.g. [approve, userLock]) atomically, and
 * re-shields the change — the source spend. Returned `TxData` is sent by a funded
 * (non-custodial) EOA broadcaster.
 */
export type RelayAdaptUnshieldFn = (req: RelayAdaptUnshieldRequest) => Promise<TxData>;

/** Method added to `@kohaku-eth/railgun` by the RelayAdapt extension (see plan). */
type RelayAdaptCapablePlugin = RailgunPlugin & {
  prepareRelayAdaptUnshield?: (req: {
    unshield: { asset: { __type: 'erc20'; contract: Address }; amount: bigint };
    reshieldTo: string;
    calls: RelayAdaptCall[];
  }) => Promise<TxData>;
};

/**
 * Adapt a `RailgunPlugin` to a `RelayAdaptUnshieldFn`. Until the RelayAdapt
 * cross-contract extension ships in `@kohaku-eth/railgun`, this throws a clear,
 * actionable error (the rest of the package still builds and unit-tests).
 */
export function relayAdaptUnshieldViaPlugin(railgun: RailgunPlugin): RelayAdaptUnshieldFn {
  const plugin = railgun as RelayAdaptCapablePlugin;

  return async (req) => {
    if (typeof plugin.prepareRelayAdaptUnshield !== 'function') {
      throw new Error(
        '@kohaku-eth/railgun does not expose prepareRelayAdaptUnshield (RelayAdapt cross-contract calls) yet. ' +
          'Build the railgun extension, or pass a custom `relayAdaptUnshield` to createTrainBridge/submitIntent.',
      );
    }

    return plugin.prepareRelayAdaptUnshield({
      unshield: { asset: { __type: 'erc20', contract: req.unshieldToken }, amount: req.grossAmount },
      reshieldTo: req.reshieldTo,
      calls: req.calls,
    });
  };
}
