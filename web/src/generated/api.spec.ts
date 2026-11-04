// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import openapiTS, { astToString, COMMENT_HEADER } from 'openapi-typescript';
import { describe, expect, it } from 'vitest';

const SPEC = new URL('../../../server/openapi.json', import.meta.url);
const GENERATED = new URL('./api.ts', import.meta.url);

describe('generated API types', () => {
  it('are up to date with the committed spec (npm run openapi:generate to refresh them)', async () => {
    const expected = COMMENT_HEADER + astToString(await openapiTS(SPEC));

    expect(readFileSync(fileURLToPath(GENERATED), 'utf8')).toBe(expected);
  });
});
