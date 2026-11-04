import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { readCommittedSpec } from '../testing/openapi-contract';
import { OPENAPI_SPEC_PATH, renderOpenApiSpec } from './openapi';

const SNAPSHOT_FIELDS = [
  'changed',
  'description',
  'fetchedAt',
  'price',
  'summary',
  'summaryModel',
  'summaryProvider',
  'summaryStatus',
  'tagline',
  'title',
];

describe('OpenAPI spec', () => {
  beforeAll(() => {
    Logger.overrideLogger(false);
  });

  it('is up to date with the code (npm run openapi:generate to refresh it)', async () => {
    const committed = readFileSync(OPENAPI_SPEC_PATH, 'utf8');

    expect(committed).toBe(await renderOpenApiSpec());
  });

  it.each<['get' | 'post' | 'delete', string, string[]]>([
    ['get', '/api/competitors', ['200', '500', '503']],
    ['post', '/api/competitors', ['201', '400', '409', '422', '500', '503']],
    ['delete', '/api/competitors/{id}', ['204', '404', '500', '503']],
    ['get', '/api/competitors/{id}/snapshots', ['200', '400', '404', '500', '503']],
    ['get', '/healthz', ['200', '503']],
  ])('declares the responses of %s %s', (method, path, statuses) => {
    const operation = readCommittedSpec().paths[path]?.[method];

    expect(Object.keys(operation?.responses ?? {}).sort()).toEqual(statuses);
  });

  it('declares every snapshot field as required, and no internal ones', () => {
    const schema = readCommittedSpec().components?.schemas?.Snapshot;

    expect(Object.keys(schema?.properties ?? {}).sort()).toEqual(SNAPSHOT_FIELDS);
    expect([...(schema?.required ?? [])].sort()).toEqual(SNAPSHOT_FIELDS);
  });

  it.each(['summary', 'summaryProvider', 'summaryModel'])(
    'declares snapshot %s as a nullable string',
    (field) => {
      const schema = readCommittedSpec().components?.schemas?.Snapshot;

      expect(schema?.properties?.[field]).toEqual(
        expect.objectContaining({ type: 'string', nullable: true }),
      );
    },
  );

  it('declares the summary status as a closed, named set', () => {
    const schemas = readCommittedSpec().components?.schemas;

    expect(schemas?.SummaryStatus).toEqual(
      expect.objectContaining({
        enum: ['none', 'pending', 'done', 'failed'],
      }),
    );
    expect(JSON.stringify(schemas?.Snapshot?.properties?.summaryStatus)).toContain(
      '#/components/schemas/SummaryStatus',
    );
  });

  it('declares ?limit= as an optional positive integer', () => {
    const operation =
      readCommittedSpec().paths['/api/competitors/{id}/snapshots']?.get;

    expect(
      operation?.parameters?.find((parameter) => parameter.name === 'limit'),
    ).toEqual(
      expect.objectContaining({
        in: 'query',
        required: false,
        schema: expect.objectContaining({ type: 'integer', minimum: 1 }) as unknown,
      }),
    );
  });

  it('declares the POST body with a required id', () => {
    const operation = readCommittedSpec().paths['/api/competitors']?.post;

    expect(JSON.stringify(operation?.requestBody)).toContain(
      '#/components/schemas/AddCompetitor',
    );
    expect(readCommittedSpec().components?.schemas?.AddCompetitor?.required).toEqual([
      'id',
    ]);
  });
});
