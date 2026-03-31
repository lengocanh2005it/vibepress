import { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Ollama } from 'ollama';

export const OLLAMA_CLIENT = 'OLLAMA_CLIENT';

export const OllamaProvider: Provider = {
  provide: OLLAMA_CLIENT,
  inject: [ConfigService],
  useFactory: (configService: ConfigService) => {
    const host = configService.get<string>(
      'ollama.baseURL',
      'http://localhost:11434',
    );
    const isNgrok = host.includes('ngrok');
    return new Ollama({
      host,
      ...(isNgrok && {
        fetch: (url: RequestInfo, options?: RequestInit) =>
          fetch(url, {
            ...options,
            headers: {
              ...(options?.headers as Record<string, string>),
              'ngrok-skip-browser-warning': '1',
            },
          }),
      }),
    });
  },
};
