import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiInternalServerErrorResponse,
  ApiServiceUnavailableResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiQuery,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { ApiErrorDto } from '../openapi/api-error.dto';
import {
  AddCompetitorDto,
  CompetitorDto,
  SnapshotDto,
} from './competitors.dto';
import {
  addCompetitorSchema,
  CompetitorsService,
  snapshotLimitSchema,
} from './competitors.service';
import type {
  Competitor as CompetitorContract,
  Snapshot as SnapshotContract,
} from './contract';
import { ZodValidationPipe } from './zod-validation.pipe';

@ApiTags('competitors')
@ApiInternalServerErrorResponse({ type: ApiErrorDto })
@ApiServiceUnavailableResponse({ type: ApiErrorDto })
@Controller('api/competitors')
export class CompetitorsController {
  constructor(private readonly competitors: CompetitorsService) {}

  @Get()
  @ApiOkResponse({ type: [CompetitorDto] })
  list(): Promise<CompetitorContract[]> {
    return this.competitors.list();
  }

  @Post()
  @ApiCreatedResponse({ type: CompetitorDto })
  @ApiBadRequestResponse({ type: ApiErrorDto, description: 'Malformed id' })
  @ApiConflictResponse({ type: ApiErrorDto, description: 'Already tracked' })
  @ApiUnprocessableEntityResponse({
    type: ApiErrorDto,
    description: 'The source does not know this id',
  })
  add(
    @Body(new ZodValidationPipe(addCompetitorSchema))
    body: AddCompetitorDto,
  ): Promise<CompetitorContract> {
    return this.competitors.add(body.id);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiNoContentResponse({
    description: 'Removed, along with its snapshots and cursor',
  })
  @ApiNotFoundResponse({ type: ApiErrorDto, description: 'Not tracked' })
  remove(@Param('id') id: string): Promise<void> {
    return this.competitors.remove(id);
  }

  @Get(':id/snapshots')
  @ApiQuery({
    name: 'limit',
    required: false,
    type: 'integer',
    minimum: 1,
    description: 'Return only the newest rows. Full history without it.',
  })
  @ApiOkResponse({ type: [SnapshotDto], description: 'Newest first' })
  @ApiBadRequestResponse({ type: ApiErrorDto, description: 'Invalid limit' })
  @ApiNotFoundResponse({ type: ApiErrorDto, description: 'Not tracked' })
  snapshots(
    @Param('id') id: string,
    @Query('limit', new ZodValidationPipe(snapshotLimitSchema))
    limit: number | undefined,
  ): Promise<SnapshotContract[]> {
    return this.competitors.listSnapshots(id, limit);
  }
}
