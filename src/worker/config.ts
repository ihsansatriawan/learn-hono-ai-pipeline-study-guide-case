import { env } from "../config/env";

export const QUEUE_NAME = "study-guide-queue";

const host = env.REDIS_HOST;
const port = env.REDIS_PORT;

/**
 * Worker: BullMQ mensyaratkan maxRetriesPerRequest: null, karena perintah
 * blocking yang dipakai Worker harus boleh menunggu tanpa batas.
 */
export const workerConnection = {
  host,
  port,
  maxRetriesPerRequest: null,
} as const;

/**
 * Producer (API): kebalikannya. Kalau Redis mati, `queue.add` HARUS gagal cepat
 * supaya router bisa menandai job FAILED dan membalas 503 — lihat ADR-0005.
 *
 * Memakai konfigurasi Worker di sini membuat permintaan HTTP menggantung
 * selamanya alih-alih ditolak, dan meninggalkan baris PENDING tanpa alasan.
 */
export const queueConnection = {
  host,
  port,
  enableOfflineQueue: false,
  maxRetriesPerRequest: 3,
  commandTimeout: 5_000,
} as const;
