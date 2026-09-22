import type { PipeTransform } from '@nestjs/common';
import type { z } from 'zod';
import { ValidationError } from '../errors.js';

/** Validates and converts request input with a zod schema; rejects unknown shapes. */
export class ZodPipe<S extends z.ZodType> implements PipeTransform<unknown, z.infer<S>> {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.infer<S> {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new ValidationError('INVALID_REQUEST', 'The request is invalid', {
        issues: result.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }
    return result.data;
  }
}
