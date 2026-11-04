import { BadRequestException, type PipeTransform } from '@nestjs/common';
import type { z } from 'zod';

/** Turns untrusted request data into a typed value, or a 400 naming what's wrong. */
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: z.ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      const messages = result.error.issues.map((issue) => issue.message);
      throw new BadRequestException(messages.join('; '));
    }
    return result.data;
  }
}
