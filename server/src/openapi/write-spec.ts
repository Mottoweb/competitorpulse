import 'reflect-metadata';
import { writeFileSync } from 'node:fs';
import { OPENAPI_SPEC_PATH, renderOpenApiSpec } from './openapi';

async function main(): Promise<void> {
  writeFileSync(OPENAPI_SPEC_PATH, await renderOpenApiSpec());
}

void main();
