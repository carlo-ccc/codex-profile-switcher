export class AppError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.exitCode = options.exitCode ?? 1;
    this.cause = options.cause;
    this.details = options.details;
  }
}

export function toAppError(error, fallbackCode = "UNEXPECTED_ERROR") {
  if (error instanceof AppError) {
    return error;
  }

  return new AppError(fallbackCode, error?.message || String(error), {
    cause: error,
  });
}
