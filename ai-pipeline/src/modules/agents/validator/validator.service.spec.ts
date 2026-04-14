import { ConfigService } from '@nestjs/config';
import { ValidatorService } from './validator.service.js';

describe('ValidatorService post meta contract', () => {
  let service: ValidatorService;

  beforeEach(() => {
    service = new ValidatorService(new ConfigService());
  });

  it('rejects plain-text post.author in post meta rows', () => {
    const result = service.checkCodeStructure(
      `import React from 'react';

export default function Example() {
  const post = {
    author: 'Jane Doe',
    authorSlug: 'jane-doe',
    categories: ['News'],
    categorySlugs: ['news'],
  };

  return <div><span>{post.author}</span></div>;
}
`,
    );

    expect(result.isValid).toBe(false);
    expect(result.error).toContain(
      'Post meta author/category labels must link',
    );
  });

  it('allows plain-text post.author when it is the page heading/title', () => {
    const result = service.checkCodeStructure(
      `import React from 'react';

export default function Example() {
  const post = {
    author: 'Jane Doe',
    authorSlug: 'jane-doe',
  };

  return <h1>{post.author}</h1>;
}
`,
    );

    expect(result.isValid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('still rejects plain-text post.categories[0] in post meta', () => {
    const result = service.checkCodeStructure(
      `import React from 'react';

export default function Example() {
  const post = {
    categories: ['News'],
    categorySlugs: ['news'],
  };

  return <div><span>{post.categories[0]}</span></div>;
}
`,
    );

    expect(result.isValid).toBe(false);
    expect(result.error).toContain(
      'Post meta author/category labels must link',
    );
  });
});
