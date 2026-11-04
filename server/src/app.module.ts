import { Module } from '@nestjs/common';
import { CompetitorsModule } from './competitors/competitors.module';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { PollerModule } from './poller/poller.module';
import { SummarizerModule } from './summarizer/summarizer.module';
import { WebModule } from './web/web.module';

@Module({
  imports: [
    DatabaseModule,
    PollerModule,
    SummarizerModule,
    CompetitorsModule,
    HealthModule,
    WebModule,
  ],
})
export class AppModule {}
