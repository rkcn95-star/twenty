export type ErrorCode = 'validation' | 'forbidden' | 'not_found' | 'conflict';

export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}
