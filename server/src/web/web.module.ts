import { Module } from '@nestjs/common';
import { ServeStaticModule } from '@nestjs/serve-static';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// Without this limit, an unknown API path would answer 200 with the app's HTML.
// Not serve-static's `exclude` option: its error handler answers 404 to any error
// on an excluded path, which turned the 400 for malformed JSON into a 404.
const APP_ROUTES = /^(?!\/api(?:\/|$)|\/healthz\/?$)/;

function resolveWebRoot(env: NodeJS.ProcessEnv): string {
  if (env.WEB_DIST_DIR !== undefined) {
    return env.WEB_DIST_DIR;
  }
  // The compiled file sits one level deeper than its source.
  const fromSource = join(__dirname, '../../../web/dist');
  const fromDist = join(__dirname, '../../../../web/dist');
  return existsSync(fromDist) ? fromDist : fromSource;
}

@Module({
  imports: [
    // A factory, so the path is read after main.ts has loaded .env.
    ServeStaticModule.forRootAsync({
      useFactory: () => [
        {
          rootPath: resolveWebRoot(process.env),
          renderPath: APP_ROUTES,
        },
      ],
    }),
  ],
})
export class WebModule {}
