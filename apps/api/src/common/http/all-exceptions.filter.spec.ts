import { BadRequestException, HttpStatus, NotFoundException } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { Prisma } from '@prisma/client';
import { ErrorCode } from '@helmet/types';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { AppException } from './app.exception';

describe('AllExceptionsFilter', () => {
  const prod = new AllExceptionsFilter(false);

  it('maps AppException to its code', () => {
    const { status, body } = prod.toFailure(
      AppException.conflict(
        ErrorCode.HELMET_ALREADY_ACTIVATED,
        'This helmet has already been activated.',
      ),
    );
    expect(status).toBe(409);
    expect(body).toEqual({
      success: false,
      error: {
        code: 'HELMET_ALREADY_ACTIVATED',
        message: 'This helmet has already been activated.',
      },
    });
  });

  it('maps validation errors with details', () => {
    const { status, body } = prod.toFailure(new BadRequestException(['email must be an email']));
    expect(status).toBe(400);
    expect(body.error.code).toBe(ErrorCode.VALIDATION_ERROR);
    expect(body.error.details).toEqual(['email must be an email']);
  });

  it('maps throttling and generic HTTP errors', () => {
    expect(prod.toFailure(new ThrottlerException()).body.error.code).toBe(ErrorCode.RATE_LIMITED);
    expect(prod.toFailure(new NotFoundException()).body.error.code).toBe(ErrorCode.NOT_FOUND);
  });

  it('maps Prisma unique violations to 409 without leaking the constraint', () => {
    const err = new Prisma.PrismaClientKnownRequestError(
      'Unique constraint failed on helmet_code',
      { code: 'P2002', clientVersion: 'x' },
    );
    const { status, body } = prod.toFailure(err);
    expect(status).toBe(HttpStatus.CONFLICT);
    expect(JSON.stringify(body)).not.toContain('helmet_code');
  });

  it('never leaks internal messages or stacks in production', () => {
    const { status, body } = prod.toFailure(new Error('connect ECONNREFUSED 10.0.0.5:5432'));
    expect(status).toBe(500);
    expect(body.error).toEqual({
      code: ErrorCode.INTERNAL_ERROR,
      message: 'An unexpected error occurred.',
    });
    expect(JSON.stringify(body)).not.toMatch(/stack|ECONNREFUSED/);
  });

  it('can expose internal messages in development', () => {
    expect(new AllExceptionsFilter(true).toFailure(new Error('boom')).body.error.message).toBe(
      'boom',
    );
  });
});
