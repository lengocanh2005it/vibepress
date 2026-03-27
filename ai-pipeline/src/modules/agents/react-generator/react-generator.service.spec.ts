import { ConfigService } from '@nestjs/config';
import { LlmFactoryService } from '../../../common/llm/llm-factory.service';
import { DbContentResult } from '../db-content/db-content.service';
import { BlockParseResult } from '../block-parser/block-parser.service';
import { ReactGeneratorService } from './react-generator.service';
import { StyleResolverService } from '../style-resolver/style-resolver.service';
import { ValidatorService } from '../validator/validator.service';

describe('ReactGeneratorService', () => {
  it('passes resolved FSE spacing JSON to the generation prompt', async () => {
    const chat = jest.fn().mockResolvedValue({
      text: `import React from 'react';

function Home() {
  return <div />;
}

export default Home;`,
      inputTokens: 10,
      outputTokens: 10,
    });

    const service = new ReactGeneratorService(
      {
        getModel: () => 'test-model',
        chat,
      } as unknown as LlmFactoryService,
      {
        get: () => 0,
      } as unknown as ConfigService,
      new StyleResolverService(),
      {
        checkCodeStructure: () => ({ isValid: true }),
      } as unknown as ValidatorService,
    );

    const theme: BlockParseResult = {
      type: 'fse',
      themeJson: null,
      themeName: 'Test Theme',
      tokens: {
        colors: [],
        fonts: [],
        fontSizes: [],
        spacing: [{ slug: '40', size: '32px' }],
      },
      templates: [
        {
          name: 'home',
          markup:
            '<!-- wp:group {"style":{"spacing":{"padding":"var:preset|spacing|40","margin":"1rem 2rem"}}} --><p>Hello</p><!-- /wp:group -->',
        },
      ],
      parts: [],
    };

    const content: DbContentResult = {
      siteInfo: {
        siteName: 'Demo Site',
        siteUrl: 'https://example.com',
        blogDescription: 'Demo description',
      },
      posts: [],
      pages: [],
      menus: [],
    } as DbContentResult;

    await service.generate({
      theme,
      content,
      jobId: 'test-job',
    });

    const userPrompt = chat.mock.calls[0][0].userPrompt as string;

    expect(userPrompt).toContain(
      '"padding":{"top":"32px","right":"32px","bottom":"32px","left":"32px"}',
    );
    expect(userPrompt).toContain(
      '"margin":{"top":"1rem","right":"2rem","bottom":"1rem","left":"2rem"}',
    );
    expect(userPrompt).not.toContain(
      '<!-- wp:group {"style":{"spacing":{"padding":"var:preset|spacing|40","margin":"1rem 2rem"}}} -->',
    );
  });
});
