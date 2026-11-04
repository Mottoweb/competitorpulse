import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  DocumentBuilder,
  SwaggerModule,
  type OpenAPIObject,
} from '@nestjs/swagger';
import { join } from 'node:path';
import { AppModule } from '../app.module';

/** The committed spec. Only meaningful when running from source. */
export const OPENAPI_SPEC_PATH = join(__dirname, '../../openapi.json');

// Not /api itself, which stays a JSON 404 like any other unknown API path.
const SWAGGER_PATH = 'api/docs';

export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  return SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('CompetitorPulse API')
      .setDescription('Tracks competitor listings and summarises their changes.')
      .setVersion('1.0.0')
      .build(),
  );
}

/** Serves the UI at /api/docs and the document at /api/docs-json. */
export function setupSwagger(app: INestApplication): void {
  SwaggerModule.setup(SWAGGER_PATH, app, buildOpenApiDocument(app));
}

/**
 * The spec's committed text. Preview mode reads the routes and decorators without
 * creating any provider, so this needs no database, config or LLM key.
 */
export async function renderOpenApiSpec(): Promise<string> {
  const app = await NestFactory.create(AppModule, {
    preview: true,
    logger: false,
  });
  const document = buildOpenApiDocument(app);
  await app.close();
  return `${JSON.stringify(document, null, 2)}\n`;
}
