import { Module } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { FixtureListingSource, loadFixtures } from './fixture-listing-source';
import { LISTING_SOURCE } from './listing-source';

@Module({
  providers: [
    {
      provide: LISTING_SOURCE,
      inject: [DataSource],
      useFactory: (dataSource: DataSource) =>
        new FixtureListingSource(dataSource, loadFixtures()),
    },
  ],
  exports: [LISTING_SOURCE],
})
export class SourceModule {}
