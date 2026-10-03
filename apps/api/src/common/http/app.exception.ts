import { HttpException, HttpStatus } from '@nestjs/common';
import { ErrorCode } from '@helmet/types';

/** Domain-level error with a stable machine-readable code. */
export class AppException extends HttpException {
  constructor(
    public readonly code: ErrorCode | string,
    message: string,
    status: HttpStatus = HttpStatus.BAD_REQUEST,
    public readonly details?: unknown,
  ) {
    super({ code, message, details }, status);
  }

  static notFound(code: ErrorCode, message: string): AppException {
    return new AppException(code, message, HttpStatus.NOT_FOUND);
  }

  static conflict(code: ErrorCode, message: string, details?: unknown): AppException {
    return new AppException(code, message, HttpStatus.CONFLICT, details);
  }

  static forbidden(message = 'You do not have permission to perform this action.'): AppException {
    return new AppException(ErrorCode.FORBIDDEN, message, HttpStatus.FORBIDDEN);
  }

  static unauthorized(
    code: ErrorCode = ErrorCode.UNAUTHORIZED,
    message = 'Authentication required.',
  ): AppException {
    return new AppException(code, message, HttpStatus.UNAUTHORIZED);
  }
}
