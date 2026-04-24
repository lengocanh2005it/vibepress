import ts from 'typescript';

type AllowedRecordName = 'post' | 'item' | 'postDetail';

interface PostMetaSnippetCandidate {
  start: number;
  end: number;
  raw: string;
  replacement?: string;
}

interface MetaElementMatch {
  record: AllowedRecordName;
  tag: 'span' | 'p';
  attrs: string;
  inner: string;
}

const POST_META_HOVER_CLASSES = 'hover:underline underline-offset-4';

export function normalizePlainTextPostMetaArchiveLinks(code: string): string {
  const sourceFile = ts.createSourceFile(
    'virtual-component.tsx',
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const replacements: PostMetaSnippetCandidate[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isJsxExpression(node) && node.expression) {
      const expression = unwrapExpression(node.expression);
      const guardedReplacement = buildGuardedMetaReplacement(
        expression,
        sourceFile,
        code,
      );
      if (guardedReplacement) {
        replacements.push({
          start: node.getStart(sourceFile),
          end: node.getEnd(),
          raw: node.getText(sourceFile),
          replacement: guardedReplacement,
        });
        return;
      }

      const categoryMapReplacement = buildCategoryMapReplacement(
        expression,
        sourceFile,
      );
      if (categoryMapReplacement) {
        replacements.push({
          start: node.getStart(sourceFile),
          end: node.getEnd(),
          raw: node.getText(sourceFile),
          replacement: categoryMapReplacement,
        });
        return;
      }
    }

    if (
      ts.isJsxElement(node) &&
      !ts.isJsxExpression(node.parent) &&
      !isInsideHeadingElement(node)
    ) {
      const directReplacement = buildDirectMetaReplacement(
        node,
        sourceFile,
        code,
      );
      if (directReplacement) {
        replacements.push({
          start: node.getStart(sourceFile),
          end: node.getEnd(),
          raw: node.getText(sourceFile),
          replacement: directReplacement,
        });
        return;
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  let next = applySnippetReplacements(code, replacements);
  next = normalizeCategoryMapRegexFallback(next);
  return next;
}

export function promotePlainTextPostMetaLinks(code: string): string {
  const isCanonicalMetaLink = (raw: string): boolean =>
    /(?:to=|href=)[^>]*\/author\//.test(raw) ||
    /(?:to=|href=)[^>]*\/category\//.test(raw);

  const decorateQuoted = (source: string) =>
    source.replace(
      /<(Link|a)\b([^>]*?)className=(["'])([^"']*)\3/g,
      (
        match,
        tag: string,
        before: string,
        quote: string,
        className: string,
      ) => {
        if (!isCanonicalMetaLink(match)) return match;
        return `<${tag}${before}className=${quote}${appendUniqueClasses(
          className,
          POST_META_HOVER_CLASSES,
        )}${quote}`;
      },
    );

  const decorateTemplateLiteral = (source: string) =>
    source.replace(
      /<(Link|a)\b([^>]*?)className=\{`([^`]*)`\}/g,
      (match, tag: string, before: string, className: string) => {
        if (!isCanonicalMetaLink(match)) return match;
        return `<${tag}${before}className={\`${appendUniqueClasses(
          className,
          POST_META_HOVER_CLASSES,
        )}\`}`;
      },
    );

  const decorateWithoutClass = (source: string) =>
    source.replace(
      /<(Link|a)\b((?:(?!className=)[^>])*)(?=>)/g,
      (match, tag: string, attrs: string) => {
        if (!isCanonicalMetaLink(match)) return match;
        return `<${tag}${attrs} className="${POST_META_HOVER_CLASSES}"`;
      },
    );

  return decorateWithoutClass(decorateTemplateLiteral(decorateQuoted(code)));
}

export function findPlainTextPostMetaArchiveSnippets(
  code: string,
  max = 3,
): string[] {
  const sourceFile = ts.createSourceFile(
    'virtual-component.tsx',
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const snippets: PostMetaSnippetCandidate[] = [];

  const pushSnippet = (node: ts.Node): void => {
    if (snippets.length >= max) return;
    const raw = node.getText(sourceFile).replace(/\s+/g, ' ').trim();
    if (!raw) return;
    snippets.push({
      start: node.getStart(sourceFile),
      end: node.getEnd(),
      raw: raw.length > 180 ? `${raw.slice(0, 177)}...` : raw,
    });
  };

  const visit = (node: ts.Node): void => {
    if (snippets.length >= max) return;

    if (ts.isJsxExpression(node) && node.expression) {
      const expression = unwrapExpression(node.expression);
      if (
        buildGuardedMetaReplacement(expression, sourceFile, code) ||
        buildCategoryMapReplacement(expression, sourceFile)
      ) {
        pushSnippet(node);
        return;
      }
    }

    if (
      ts.isJsxElement(node) &&
      !ts.isJsxExpression(node.parent) &&
      !isInsideHeadingElement(node) &&
      buildDirectMetaReplacement(node, sourceFile, code)
    ) {
      pushSnippet(node);
      return;
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  return snippets
    .sort((a, b) => a.start - b.start)
    .slice(0, max)
    .map((candidate) => candidate.raw);
}

function buildGuardedMetaReplacement(
  expression: ts.Expression,
  sourceFile: ts.SourceFile,
  fullCode: string,
): string | undefined {
  if (
    !ts.isBinaryExpression(expression) ||
    expression.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken
  ) {
    return undefined;
  }

  const left = unwrapExpression(expression.left);
  const right = unwrapExpression(expression.right);
  const authorRecord = getAuthorRecordName(left, sourceFile);
  if (
    authorRecord &&
    ts.isJsxElement(right) &&
    !isInsideHeadingElement(right)
  ) {
    const meta = matchAuthorElement(right, sourceFile);
    if (meta?.record === authorRecord) {
      return `{${authorRecord}.author && (${authorRecord}.authorSlug ? <Link to={'/author/' + ${authorRecord}.authorSlug}${decorateMetaLinkAttrs(meta.attrs)}>${meta.inner}</Link> : ${right.getText(sourceFile)})}`;
    }
  }

  const categoryRecord = getFirstCategoryRecordName(left, sourceFile);
  if (
    categoryRecord &&
    ts.isJsxElement(right) &&
    !isInsideHeadingElement(right)
  ) {
    const meta = matchFirstCategoryElement(right, sourceFile);
    if (meta?.record === categoryRecord) {
      return `{${categoryRecord}.categories?.[0] && (${categoryRecord}.categorySlugs?.[0] ? <Link to={'/category/' + ${categoryRecord}.categorySlugs[0]}${decorateMetaLinkAttrs(meta.attrs)}>${meta.inner}</Link> : ${right.getText(sourceFile)})}`;
    }
  }

  if (
    ts.isParenthesizedExpression(right) &&
    ts.isJsxElement(unwrapExpression(right.expression))
  ) {
    const nested = unwrapExpression(right.expression) as ts.JsxElement;
    if (authorRecord && !isInsideHeadingElement(nested)) {
      const meta = matchAuthorElement(nested, sourceFile);
      if (meta?.record === authorRecord) {
        return `{${authorRecord}.author && (${authorRecord}.authorSlug ? <Link to={'/author/' + ${authorRecord}.authorSlug}${decorateMetaLinkAttrs(meta.attrs)}>${meta.inner}</Link> : ${nested.getText(sourceFile)})}`;
      }
    }
    if (categoryRecord && !isInsideHeadingElement(nested)) {
      const meta = matchFirstCategoryElement(nested, sourceFile);
      if (meta?.record === categoryRecord) {
        return `{${categoryRecord}.categories?.[0] && (${categoryRecord}.categorySlugs?.[0] ? <Link to={'/category/' + ${categoryRecord}.categorySlugs[0]}${decorateMetaLinkAttrs(meta.attrs)}>${meta.inner}</Link> : ${nested.getText(sourceFile)})}`;
      }
    }
  }

  return undefined;
}

function buildDirectMetaReplacement(
  node: ts.JsxElement,
  sourceFile: ts.SourceFile,
  fullCode: string,
): string | undefined {
  if (isWithinSlugTernaryFallback(fullCode, node.getStart(sourceFile))) {
    return undefined;
  }

  const authorMeta = matchAuthorElement(node, sourceFile);
  if (authorMeta) {
    return `{${authorMeta.record}.authorSlug ? <Link to={'/author/' + ${authorMeta.record}.authorSlug}${decorateMetaLinkAttrs(authorMeta.attrs)}>${authorMeta.inner}</Link> : ${node.getText(sourceFile)}}`;
  }

  const categoryMeta = matchFirstCategoryElement(node, sourceFile);
  if (categoryMeta) {
    return `{${categoryMeta.record}.categorySlugs?.[0] ? <Link to={'/category/' + ${categoryMeta.record}.categorySlugs[0]}${decorateMetaLinkAttrs(categoryMeta.attrs)}>${categoryMeta.inner}</Link> : ${node.getText(sourceFile)}}`;
  }

  return undefined;
}

function buildCategoryMapReplacement(
  expression: ts.Expression,
  sourceFile: ts.SourceFile,
): string | undefined {
  if (!ts.isCallExpression(expression)) return undefined;
  const chainTarget = unwrapExpression(expression.expression);
  const targetText = chainTarget.getText(sourceFile);
  const targetMatch = targetText.match(
    /^(post|item|postDetail)\.categories(?:\?\.)?\.map$/,
  );
  if (!targetMatch) return undefined;
  const record = targetMatch[1] as AllowedRecordName;
  const callback = expression.arguments[0];
  if (!callback || !ts.isArrowFunction(callback)) return undefined;
  if (callback.parameters.length < 2) return undefined;

  const categoryVar = callback.parameters[0]?.name.getText(sourceFile);
  const indexVar = callback.parameters[1]?.name.getText(sourceFile);
  if (!categoryVar || !indexVar) return undefined;

  if (ts.isBlock(callback.body)) return undefined;
  const callbackBody = unwrapExpression(callback.body);
  if (!ts.isJsxElement(callbackBody)) return undefined;
  const categoryMeta = matchCategoryMapElement(
    callbackBody,
    categoryVar,
    sourceFile,
  );
  if (!categoryMeta) return undefined;

  return `{${record}.categories?.map((${categoryVar}, ${indexVar}) => (${record}.categorySlugs?.[${indexVar}] ? <Link to={'/category/' + ${record}.categorySlugs[${indexVar}]}${decorateMetaLinkAttrs(categoryMeta.attrs)}>${categoryMeta.inner}</Link> : ${callbackBody.getText(sourceFile)}))}`;
}

function normalizeCategoryMapRegexFallback(code: string): string {
  return code.replace(
    /\{(post|item|postDetail)\.categories\?\.map\(\(\s*(\w+)\s*,\s*(\w+)\s*\)\s*=>\s*\(\s*<span\b([^>]*)>\s*\{\2\}\s*<\/span>\s*\)\)\}/g,
    (
      _match,
      record: string,
      categoryVar: string,
      indexVar: string,
      attrs: string,
    ) =>
      `{${record}.categories?.map((${categoryVar}, ${indexVar}) => (${record}.categorySlugs?.[${indexVar}] ? <Link to={'/category/' + ${record}.categorySlugs[${indexVar}]}${decorateMetaLinkAttrs(
        attrs.trim() ? ` ${attrs.trim()}` : '',
      )}>{${categoryVar}}</Link> : <span${attrs}>{${categoryVar}}</span>}))}`,
  );
}

function matchAuthorElement(
  node: ts.JsxElement,
  sourceFile: ts.SourceFile,
): MetaElementMatch | null {
  const tag = getSupportedTagName(node);
  if (!tag) return null;
  const inner = getJsxElementInner(node, sourceFile);
  const authorMatch = inner.match(/\{(post|item|postDetail)\.author\}/);
  if (!authorMatch) return null;
  if (/\{[^}]+\}/g.test(inner.replace(authorMatch[0], ''))) return null;

  return {
    record: authorMatch[1] as AllowedRecordName,
    tag,
    attrs: getOpeningAttrs(node, sourceFile),
    inner,
  };
}

function matchFirstCategoryElement(
  node: ts.JsxElement,
  sourceFile: ts.SourceFile,
): MetaElementMatch | null {
  const tag = getSupportedTagName(node);
  if (!tag || tag !== 'span') return null;
  const inner = getJsxElementInner(node, sourceFile);
  const categoryMatch = inner.match(
    /\{(post|item|postDetail)\.categories(?:\?\.)?\[0\](?:\s*\?\?\s*''\s*)?\}/,
  );
  if (!categoryMatch) return null;
  if (/\{[^}]+\}/g.test(inner.replace(categoryMatch[0], ''))) return null;

  return {
    record: categoryMatch[1] as AllowedRecordName,
    tag,
    attrs: getOpeningAttrs(node, sourceFile),
    inner,
  };
}

function matchCategoryMapElement(
  node: ts.JsxElement,
  categoryVar: string,
  sourceFile: ts.SourceFile,
): { attrs: string; inner: string } | null {
  const tag = getSupportedTagName(node);
  if (!tag || tag !== 'span') return null;
  const inner = getJsxElementInner(node, sourceFile).trim();
  if (inner !== `{${categoryVar}}`) return null;
  return {
    attrs: getOpeningAttrs(node, sourceFile),
    inner,
  };
}

function getSupportedTagName(node: ts.JsxElement): 'span' | 'p' | null {
  const tagName = node.openingElement.tagName.getText();
  if (tagName === 'span' || tagName === 'p') return tagName;
  return null;
}

function getOpeningAttrs(
  node: ts.JsxElement,
  sourceFile: ts.SourceFile,
): string {
  const attrs = node.openingElement.attributes.getText(sourceFile).trim();
  return attrs ? ` ${attrs}` : '';
}

function getJsxElementInner(
  node: ts.JsxElement,
  sourceFile: ts.SourceFile,
): string {
  return sourceFile.text.slice(
    node.openingElement.end,
    node.closingElement.pos,
  );
}

function getAuthorRecordName(
  expression: ts.Expression,
  sourceFile: ts.SourceFile,
): AllowedRecordName | null {
  const text = expression.getText(sourceFile);
  const match = text.match(/^(post|item|postDetail)\.author$/);
  return (match?.[1] as AllowedRecordName | undefined) ?? null;
}

function getFirstCategoryRecordName(
  expression: ts.Expression,
  sourceFile: ts.SourceFile,
): AllowedRecordName | null {
  const text = expression.getText(sourceFile);
  const match = text.match(
    /^(post|item|postDetail)\.categories(?:\?\.)?\[0\]$/,
  );
  return (match?.[1] as AllowedRecordName | undefined) ?? null;
}

function unwrapExpression<T extends ts.Expression>(
  expression: T,
): ts.Expression {
  let current: ts.Expression = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function isInsideHeadingElement(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isJsxElement(current)) {
      const tagName = current.openingElement.tagName.getText();
      if (/^h[1-6]$/i.test(tagName)) return true;
    }
    current = current.parent;
  }
  return false;
}

function isWithinSlugTernaryFallback(code: string, offset: number): boolean {
  const before = code.slice(Math.max(0, offset - 600), offset);
  return (
    /\bauthorSlug\s*\?/.test(before) ||
    /\bcategorySlugs(?:\?\.)?\s*\[\s*0\s*\]\s*\?/.test(before)
  );
}

function applySnippetReplacements(
  code: string,
  replacements: PostMetaSnippetCandidate[],
): string {
  if (replacements.length === 0) return code;

  const filtered = replacements
    .filter((candidate) => candidate.replacement)
    .sort((a, b) => (a.start === b.start ? b.end - a.end : a.start - b.start))
    .filter((candidate, index, list) => {
      const previous = list[index - 1];
      return !previous || candidate.start >= previous.end;
    });

  let next = code;
  for (const candidate of filtered.sort((a, b) => b.start - a.start)) {
    next =
      next.slice(0, candidate.start) +
      candidate.replacement +
      next.slice(candidate.end);
  }
  return next;
}

function decorateMetaLinkAttrs(attrs: string): string {
  if (!attrs) return ` className="${POST_META_HOVER_CLASSES}"`;

  if (/className=(["'])([^"']*)\1/.test(attrs)) {
    return attrs.replace(
      /className=(["'])([^"']*)\1/,
      (_match, quote: string, className: string) =>
        `className=${quote}${appendUniqueClasses(
          className,
          POST_META_HOVER_CLASSES,
        )}${quote}`,
    );
  }

  if (/className=\{`([^`]*)`\}/.test(attrs)) {
    return attrs.replace(
      /className=\{`([^`]*)`\}/,
      (_match, className: string) =>
        `className={\`${appendUniqueClasses(
          className,
          POST_META_HOVER_CLASSES,
        )}\`}`,
    );
  }

  return `${attrs} className="${POST_META_HOVER_CLASSES}"`;
}

function appendUniqueClasses(existing: string, addition: string): string {
  return [...new Set(`${existing} ${addition}`.split(/[\s,]+/).filter(Boolean))]
    .join(' ')
    .trim();
}
