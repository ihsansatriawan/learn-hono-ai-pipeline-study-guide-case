/**
 * Taksonomi kegagalan pipeline — lihat docs/adr/0001.
 *
 * Worker memutuskan retry berdasarkan kelas error, bukan isi pesannya.
 * Error yang tidak dikenali diperlakukan sebagai transient.
 */

/** Kegagalan permanen: mengulang pekerjaan yang sama tidak akan mengubah hasilnya. */
export class PermanentPipelineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentPipelineError";
  }
}

/** Source Text tidak memuat cukup materi untuk membentuk Study Guide. */
export class UnprocessableSourceError extends PermanentPipelineError {
  constructor(message: string) {
    super(message);
    this.name = "UnprocessableSourceError";
  }
}

/**
 * Output sebuah langkah tidak sejajar dengan konsep dari langkah pertama.
 * Transient: model meleset sekali, percobaan berikutnya punya peluang lengkap.
 */
export class MisalignedStepOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MisalignedStepOutputError";
  }
}

export function isPermanentFailure(error: unknown): boolean {
  return error instanceof PermanentPipelineError;
}

export function describeFailure(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return `UnknownError: ${String(error)}`;
}
