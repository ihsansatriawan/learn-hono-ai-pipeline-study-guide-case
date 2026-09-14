/**
 * Recovers Study Jobs the queue has lost — see docs/adr/0006.
 *
 * PostgreSQL is the source of truth, so recovery is scanned from PostgreSQL.
 * BullMQ's own machinery (the stalled check, retries, the delayed set) is driven
 * from Redis and can only recover jobs Redis still knows about; a row that never
 * reached the queue is invisible to it forever.
 *
 * The sweep asks Redis what it holds and acts on the answer. Age only decides
 * when a row is worth a question — it never decides the row's fate:
 *
 *   state                                  PENDING     PROCESSING
 *   waiting/active/delayed/prioritized     leave       leave
 *   unknown                                heal        close
 *   completed/failed                       close       close
 */
import type { JobState } from "bullmq";
import { queue, enqueueStudyGuideJob } from "./queue";
import { describeFailure } from "../errors";
import { findStaleStudyJobs, markFailed } from "../modules/study-job/repository";

export const SWEEP_EVERY_MS = 60_000;

/**
 * How long a row must sit before the reconciler bothers asking about it. Only a
 * cost knob: a row that is genuinely in flight answers `active` or `waiting` and
 * is left alone whatever this number is. Measured end-to-end durations run to
 * 243s, so a smaller value merely buys pointless questions, not wrong answers.
 */
export const STALE_AFTER_MS = 2 * 60_000;

/** Bounds one sweep after a long outage, rather than dragging the whole backlog in at once. */
export const SWEEP_BATCH = 100;

/** States that mean the queue still holds the job, so nobody else should touch it. */
const STILL_HELD: ReadonlySet<string> = new Set([
  "waiting",
  "waiting-children",
  "active",
  "delayed",
  "prioritized",
]);

function abandonedReason(status: "PENDING" | "PROCESSING", state: JobState | "unknown") {
  if (state === "unknown") {
    return "Abandoned: a worker claimed this study job and never finished it; the queue no longer holds it.";
  }
  return `Abandoned: the queue finished this study job as "${state}", but no study guide was ever stored.`;
}

async function reconcile(status: "PENDING" | "PROCESSING", olderThan: Temporal.Instant) {
  const stale = await findStaleStudyJobs(status, olderThan, SWEEP_BATCH);

  let healed = 0;
  let closed = 0;

  for (const job of stale) {
    let state: JobState | "unknown";
    try {
      state = await queue.getJobState(job.id);
    } catch (error) {
      // Without an answer from Redis there is no authority to act on. Leave the
      // row exactly as it is; the next sweep asks again.
      console.warn(`[reconciler] Could not ask Redis about ${job.id}: ${describeFailure(error)}`);
      continue;
    }

    if (STILL_HELD.has(state)) continue;

    // Nothing has started work on it, so however old it is, it goes back in the queue.
    if (state === "unknown" && status === "PENDING") {
      try {
        await enqueueStudyGuideJob(job.id);
        healed += 1;
        console.log(`[reconciler] Study job ${job.id} was missing from the queue; re-enqueued.`);
      } catch (error) {
        // Still PENDING, so the next sweep tries again.
        console.warn(`[reconciler] Could not re-enqueue ${job.id}: ${describeFailure(error)}`);
      }
      continue;
    }

    // A claimed job is closed, not re-run: how far it got is unknowable, and the
    // attempts the system was willing to spend have already been spent.
    if (await markFailed(job.id, abandonedReason(status, state))) {
      closed += 1;
      console.warn(`[reconciler] Study job ${job.id} (${status}, queue: ${state}) closed as FAILED.`);
    }
  }

  return { seen: stale.length, healed, closed };
}

export async function sweepOnce() {
  const olderThan = Temporal.Now.instant().subtract({ milliseconds: STALE_AFTER_MS });

  const pending = await reconcile("PENDING", olderThan);
  const processing = await reconcile("PROCESSING", olderThan);

  return {
    seen: pending.seen + processing.seen,
    healed: pending.healed,
    closed: pending.closed + processing.closed,
  };
}

export function startReconciler() {
  let running = false;

  const tick = async () => {
    // A sweep that outlives its interval must not be joined by the next one.
    if (running) return;
    running = true;

    try {
      const { seen, healed, closed } = await sweepOnce();
      if (seen > 0) {
        console.log(`[reconciler] Swept ${seen} stale study job(s): ${healed} healed, ${closed} closed.`);
      }
    } catch (error) {
      // A sweep must never take the worker down with it.
      console.error(`[reconciler] Sweep failed: ${describeFailure(error)}`);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), SWEEP_EVERY_MS);
  timer.unref();

  console.log(
    `[reconciler] Sweeping every ${SWEEP_EVERY_MS / 1_000}s for study jobs stale beyond ${STALE_AFTER_MS / 1_000}s.`,
  );

  return () => clearInterval(timer);
}
