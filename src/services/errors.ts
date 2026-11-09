/**
 * Integration error type and HTTP status mapping (SPEC §2.9).
 *
 * Handlers catch `AppError` and render either the plain-text error body or the
 * diagnostics JSON envelope. Unknown exceptions become `internal_error`; their
 * messages/stack are never sent to the client.
 */

import type { ErrorCode } from '../types';

export const ERROR_STATUS: Readonly<Record<ErrorCode, number>> = {
  invalid_request: 400,
  invalid_boolean: 400,
  invalid_regex: 400,
  invalid_source: 400,
  blocked_upstream: 400,
  unsupported_target: 400,
  unsupported_ruleset_type: 400,
  conflicting_params: 400,
  invalid_config: 400,
  invalid_template: 400,
  too_many_sources: 400,
  upstream_too_large: 413,
  no_nodes: 422,
  upstream_status: 502,
  upstream_network: 502,
  upstream_timeout: 504,
  internal_error: 500,
};

export function errorStatus(code: ErrorCode): number {
  return ERROR_STATUS[code];
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;

  constructor(code: ErrorCode, message: string, status = errorStatus(code)) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
  }
}

interface CodedError {
  code?: unknown;
  message?: unknown;
}

function hasStringCode(value: unknown): value is CodedError & { code: string } {
  return typeof value === 'object' && value !== null && typeof (value as CodedError).code === 'string';
}

/**
 * Normalize an exception into an `AppError`.
 *
 * Other modules expose their own error classes (`EmitterError`,
 * `InvalidRegexError`); mapping is intentionally by `.code` so integration does
 * not need to import their internals.
 */
export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;

  if (hasStringCode(error)) {
    const message =
      typeof error.message === 'string' && error.message !== ''
        ? error.message
        : 'request could not be processed';
    switch (error.code) {
      case 'invalid_regex':
        return new AppError('invalid_regex', message);
      case 'invalid_config':
        return new AppError('invalid_config', message);
      case 'invalid_template':
        return new AppError('invalid_template', message);
      case 'E_OUTPUT_TOO_LARGE':
        return new AppError('internal_error', 'generated output exceeds the size limit');
      case 'E_EMIT_INVALID':
        return new AppError('internal_error', 'generated YAML failed validation');
      default:
        break;
    }
    // Fetch/rule codes reach integration as warnings; a fatal one is an internal
    // condition unless it was already wrapped in AppError.
  }

  return new AppError('internal_error', 'internal error');
}
