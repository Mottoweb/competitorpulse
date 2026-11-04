import { Module } from '@nestjs/common';
import { PollerModule } from '../poller/poller.module';
import { SourceModule } from '../source/source.module';
import { CompetitorsController } from './competitors.controller';
import { CompetitorsService } from './competitors.service';

@Module({
  imports: [PollerModule, SourceModule],
  controllers: [CompetitorsController],
  providers: [CompetitorsService],
})
export class CompetitorsModule {}
