import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ConfigService } from '@nestjs/config';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.enableCors({
    origin: 'http://localhost:5173',
    credentials: true,
  });

  const configService = app.get<ConfigService>(ConfigService);

  const port = configService.get<string>('port', '3001');

  await app.listen(port);
}
bootstrap();
