/**
 * Event hash-chain verification monitor (US-021C).
 *
 * Verifies the workspace event chain in bounded batches (startup once + a
 * periodic timer, see config `HASH_CHAIN_VERIFY_*`) and exposes a coarse status
 * for `GET /health`. Verification NEVER blocks startup and NEVER exposes event
 * payloads or secrets — a mismatch is reported only as `seq` + `aggregateId`.
 *
 * The timer follows the project rule for background timers: `unref()`'d, cleared
 * on graceful shutdown, and observable via structured logs
 * (`hashchain.timer.started` / `hashchain.timer.cleared`) so `verify:docker` can
 * assert its lifecycle without inference.
 */
import type { EventStore } from '@agentmesh/core';
import type { Logger } from 'pino';

import { serializeError } from '../logging.js';

export type HashChainStatus = 'ok' | 'mismatch' | 'unchecked';

export interface HashChainMismatch {
  seq: number;
  aggregateId: string;
}

export interface HashChainState {
  status: HashChainStatus;
  /** Events examined by the most recent check. */
  checked: number;
  /** Wall-clock ms of the most recent check (null before the first run). */
  lastCheckedAt: number | null;
  /** First broken link, if any (never carries payload/secret data). */
  mismatch: HashChainMismatch | null;
}

export class HashChainMonitor {
  #state: HashChainState = {
    status: 'unchecked',
    checked: 0,
    lastCheckedAt: null,
    mismatch: null,
  };
  #timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly events: EventStore,
    private readonly logger?: Logger,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get state(): HashChainState {
    return this.#state;
  }

  isRunning(): boolean {
    return this.#timer !== undefined;
  }

  /** Run one verification pass and update the exposed state. */
  runCheck(): HashChainState {
    try {
      const result = this.events.verifyChain();
      if (result.valid) {
        this.#state = {
          status: 'ok',
          checked: result.checked,
          lastCheckedAt: this.now(),
          mismatch: null,
        };
        this.logger?.info?.({ checked: result.checked, msg: 'hashchain.verify.ok' });
      } else {
        const mismatch = result.mismatch;
        this.#state = {
          status: 'mismatch',
          checked: result.checked,
          lastCheckedAt: this.now(),
          mismatch:
            mismatch === undefined
              ? null
              : { seq: mismatch.seq, aggregateId: mismatch.aggregateId },
        };
        this.logger?.error?.({
          seq: mismatch?.seq,
          aggregateId: mismatch?.aggregateId,
          msg: 'hashchain.verify.mismatch',
        });
      }
    } catch (err) {
      // A verification failure is treated as "cannot confirm integrity".
      this.#state = {
        status: 'mismatch',
        checked: this.#state.checked,
        lastCheckedAt: this.now(),
        mismatch: this.#state.mismatch,
      };
      this.logger?.error?.({ err: serializeError(err), msg: 'hashchain.verify.failed' });
    }
    return this.#state;
  }

  startTimer(intervalMs: number): void {
    if (this.#timer !== undefined || intervalMs <= 0) return;
    const timer = setInterval(() => this.runCheck(), intervalMs);
    timer.unref?.();
    this.#timer = timer;
    this.logger?.info?.({ intervalMs, msg: 'hashchain.timer.started' });
  }

  stopTimer(): void {
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
      this.logger?.info?.({ msg: 'hashchain.timer.cleared' });
    }
  }
}
