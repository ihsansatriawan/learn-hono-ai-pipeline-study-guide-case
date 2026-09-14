/**
 * Pipeline failure taxonomy — see docs/adr/0001.
 *
 * The worker decides whether to retry based on the error class, not the message
 * text. Unrecognised errors are treated as transient.
 */

/** Permanent failure: repeating the same work will not change the outcome. */
export class PermanentPipelineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentPipelineError";
  }
}

/** The source text does not carry enough material to form a Study Guide. */
export class UnprocessableSourceError extends PermanentPipelineError {
  constructor(message: string) {
    super(message);
    this.name = "UnprocessableSourceError";
  }
}

/**
 * The Study Job reached a final status while the pipeline was still running —
 * the reconciler closed it, so the finished guide has nowhere to go. Permanent:
 * `FAILED` is final, and repeating the pipeline would only rebuild a guide that
 * still has nowhere to go. See docs/adr/0006.
 */
export class StudyJobAlreadyFinalError extends PermanentPipelineError {
  constructor(message: string) {
    super(message);
    this.name = "StudyJobAlreadyFinalError";
  }
}

/**
 * A step's output does not line up with the concepts from the first step.
 * Transient: the model slipped once, the next attempt has a chance to be whole.
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
