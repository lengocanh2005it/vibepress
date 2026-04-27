import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ConfigService } from '@nestjs/config';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();

  app.enableCors({
    origin: 'http://localhost:5173',
    credentials: true,
  });

  const configService = app.get<ConfigService>(ConfigService);

  const port = configService.get<string>('port', '3001');

  let fatalShutdownInProgress = false;
  const closeAfterFatalError = async (reason: string, error: unknown) => {
    if (fatalShutdownInProgress) return;
    fatalShutdownInProgress = true;

    const message =
      error instanceof Error ? error.stack || error.message : String(error);
    logger.error(`Fatal ${reason} detected. Closing Nest application.`, message);

    try {
      await app.close();
    } finally {
      process.exit(1);
    }
  };

  process.once('uncaughtException', (error) => {
    void closeAfterFatalError('uncaughtException', error);
  });

  process.once('unhandledRejection', (reason) => {
    void closeAfterFatalError('unhandledRejection', reason);
  });

  await app.listen(port);
}
bootstrap();
