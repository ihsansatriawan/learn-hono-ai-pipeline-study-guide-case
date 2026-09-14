import { env } from "../config/env";

export const QUEUE_NAME = "study-guide-queue";

const host = env.REDIS_HOST;
const port = env.REDIS_PORT;

/**
 * Worker: BullMQ requires maxRetriesPerRequest: null, because the blocking
 * commands a Worker uses must be allowed to wait indefinitely.
 */
export const workerConnection = {
  host,
  port,
  maxRetriesPerRequest: null,
} as const;

/**
 * Producer (API): the opposite. If Redis is down, `queue.add` MUST fail fast so
 * the router can mark the job FAILED and answer 503 — see ADR-0005.
 *
 * Using the Worker configuration here would make HTTP requests hang forever
 * instead of being rejected, leaving PENDING rows behind with no reason given.
 */
export const queueConnection = {
  host,
  port,
  enableOfflineQueue: false,
  maxRetriesPerRequest: 3,
  commandTimeout: 5_000,
} as const;
