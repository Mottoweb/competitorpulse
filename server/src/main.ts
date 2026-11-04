import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { join } from 'node:path';
import { AppModule } from './app.module';
import { loadEnvFile, parseServerPort } from './config';
import { setupSwagger } from './openapi/openapi';

async function bootstrap(): Promise<void> {
  // The repo root's .env, from server/dist/src. Real variables win over the file,
  // and a deployed image has no file, so it relies on real variables.
  loadEnvFile(join(__dirname, '../../../.env'), process.env);

  const app = await NestFactory.create(AppModule);
  // Lets a stop signal finish the check in progress before the database closes.
  app.enableShutdownHooks();
  setupSwagger(app);
  const port = parseServerPort(process.env);
  await app.listen(port);
  new Logger('Bootstrap').log(`Listening on http://localhost:${port}`);
}

void bootstrap();
