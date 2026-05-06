import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { BlockParserService } from './block-parser.service.js';

describe('BlockParserService', () => {
  let tempThemeDir: string | null = null;

  afterEach(async () => {
    if (tempThemeDir) {
      await rm(tempThemeDir, { recursive: true, force: true });
      tempThemeDir = null;
    }
  });

  it('resolves pattern-backed shared parts without dropping translated php text', async () => {
    tempThemeDir = await mkdtemp(join(tmpdir(), 'block-parser-profolio-'));

    await mkdir(join(tempThemeDir, 'patterns'), { recursive: true });
    await mkdir(join(tempThemeDir, 'parts'), { recursive: true });
    await mkdir(join(tempThemeDir, 'templates'), { recursive: true });
    await writeFile(join(tempThemeDir, 'theme.json'), '{}');
    await writeFile(
      join(tempThemeDir, 'patterns', 'header.php'),
      `<?php
/**
 * Title: Header
 * Slug: profolio-fse/header
 */
?>
<!-- wp:group -->
<div class="wp-block-group"><!-- wp:buttons -->
<div class="wp-block-buttons"><!-- wp:button -->
<div class="wp-block-button"><a class="wp-block-button__link" href="#"><?php echo esc_html__( 'Get Started', 'profolio-fse' ); ?></a></div>
<!-- /wp:button --></div>
<!-- /wp:buttons --></div>
<!-- /wp:group -->
`,
    );
    await writeFile(
      join(tempThemeDir, 'patterns', 'footer.php'),
      `<?php
/**
 * Title: Footer
 * Slug: profolio-fse/footer
 */
?>
<!-- wp:group -->
<div class="wp-block-group"><!-- wp:heading -->
<h2><?php echo esc_html__( 'Let\\'s Work Together', 'profolio-fse' ); ?></h2>
<!-- /wp:heading -->
<!-- wp:image -->
<figure class="wp-block-image"><img src="<?php echo esc_url( get_template_directory_uri() ); ?>/assets/images/arrow-up.png" alt="" /></figure>
<!-- /wp:image --></div>
<!-- /wp:group -->
`,
    );
    await writeFile(
      join(tempThemeDir, 'parts', 'header.html'),
      '<!-- wp:pattern {"slug":"profolio-fse/header"} /-->',
    );
    await writeFile(
      join(tempThemeDir, 'parts', 'footer.html'),
      '<!-- wp:pattern {"slug":"profolio-fse/footer"} /-->',
    );
    await writeFile(
      join(tempThemeDir, 'templates', 'index.html'),
      '<!-- wp:template-part {"slug":"header","theme":"profolio-fse"} /--><!-- wp:template-part {"slug":"footer","theme":"profolio-fse"} /-->',
    );

    const service = new BlockParserService();
    const result = await service.parse(tempThemeDir);

    const headerMarkup =
      result.parts.find((part) => part.name === 'header')?.markup ?? '';
    const footerMarkup =
      result.parts.find((part) => part.name === 'footer')?.markup ?? '';

    expect(headerMarkup).toContain('Get Started');
    expect(footerMarkup).toContain("Let's Work Together");
    expect(footerMarkup).toContain('/assets/images/arrow-up.png');
    expect(footerMarkup).not.toContain('<?php');
  });
});
