import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { Prisma } from '@prisma/client';
import type { Request, Response } from 'express';
import { type ApiFailure, ErrorCode } from '@helmet/types';
import { AppException } from './app.exception';

const STATUS_CODE_MAP: Partial<Record<number, ErrorCode>> = {
  [HttpStatus.BAD_REQUEST]: ErrorCode.BAD_REQUEST,
  [HttpStatus.UNAUTHORIZED]: ErrorCode.UNAUTHORIZED,
  [HttpStatus.FORBIDDEN]: ErrorCode.FORBIDDEN,
  [HttpStatus.NOT_FOUND]: ErrorCode.NOT_FOUND,
  [HttpStatus.CONFLICT]: ErrorCode.CONFLICT,
  [HttpStatus.TOO_MANY_REQUESTS]: ErrorCode.RATE_LIMITED,
  [HttpStatus.SERVICE_UNAVAILABLE]: ErrorCode.SERVICE_UNAVAILABLE,
};

/**
 * Converts every thrown error into the standard failure envelope. Internal details and stack
 * traces are logged server-side only and never returned to the client.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  constructor(private readonly exposeInternalMessages = false) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request & { id?: string }>();
    const { status, body } = this.toFailure(exception);
    if (req?.id) body.error.requestId = String(req.id);

    if (status >= 500) {
      const err = exception instanceof Error ? exception : new Error(String(exception));
      this.logger.error(
        { err: { name: err.name, message: err.message, stack: err.stack }, requestId: req?.id },
        'Unhandled error',
      );
    }
    if (res.headersSent) return;
    res.status(status).json(body);
  }

  toFailure(exception: unknown): { status: number; body: ApiFailure } {
    if (exception instanceof AppException) {
      return this.build(
        exception.getStatus(),
        exception.code,
        exception.message,
        exception.details,
      );
    }
    if (exception instanceof ThrottlerException) {
      return this.build(
        HttpStatus.TOO_MANY_REQUESTS,
        ErrorCode.RATE_LIMITED,
        'Too many requests. Please try again shortly.',
      );
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();
      const code =
        STATUS_CODE_MAP[status] ??
        (status >= 500 ? ErrorCode.INTERNAL_ERROR : ErrorCode.BAD_REQUEST);
      if (typeof response === 'object' && response !== null) {
        const r = response as { message?: unknown; code?: string; details?: unknown };
        // class-validator produces an array of messages.
        if (Array.isArray(r.message)) {
          return this.build(
            status,
            ErrorCode.VALIDATION_ERROR,
            'Request validation failed.',
            r.message,
          );
        }
        const message = typeof r.message === 'string' ? r.message : exception.message;
        return this.build(status, r.code ?? code, message, r.details);
      }
      return this.build(status, code, typeof response === 'string' ? response : exception.message);
    }
    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === 'P2002') {
        return this.build(
          HttpStatus.CONFLICT,
          ErrorCode.CONFLICT,
          'A record with the same unique value already exists.',
        );
      }
      if (exception.code === 'P2025') {
        return this.build(
          HttpStatus.NOT_FOUND,
          ErrorCode.NOT_FOUND,
          'The requested resource was not found.',
        );
      }
    }
    const message =
      this.exposeInternalMessages && exception instanceof Error
        ? exception.message
        : 'An unexpected error occurred.';
    return this.build(HttpStatus.INTERNAL_SERVER_ERROR, ErrorCode.INTERNAL_ERROR, message);
  }

  private build(status: number, code: string, message: string, details?: unknown) {
    const body: ApiFailure = { success: false, error: { code, message } };
    if (details !== undefined) body.error.details = details;
    return { status, body };
  }
}
