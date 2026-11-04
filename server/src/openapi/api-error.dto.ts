import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger';

/** Nest's default error body. `message` is written to be shown to the user. */
@ApiSchema({ name: 'ApiError' })
export class ApiErrorDto {
  @ApiProperty()
  statusCode!: number;

  @ApiProperty()
  message!: string;

  @ApiPropertyOptional()
  error?: string;
}
