import { Injectable, Logger } from '@nestjs/common';
import { readFile, readdir } from 'fs/promises';
import { join, extname } from 'path';

export interface PhpParseResult {
  type: 'classic';
  templates: { name: string; html: string }[];
}

@Injectable()
export class PhpParserService {
  private readonly logger = new Logger(PhpParserService.name);

  async parse(themeDir: string): Promise<PhpParseResult> {
    this.logger.log(`Parsing classic PHP theme: ${themeDir}`);
    const entries = await readdir(themeDir);
    const phpFiles = entries.filter((f) => extname(f) === '.php');

    const templates = await Promise.all(
      phpFiles.map(async (file) => {
        const raw = await readFile(join(themeDir, file), 'utf-8');
        return { name: file, html: this.stripPhp(raw) };
      }),
    );

    return { type: 'classic', templates };
  }

  // Chuyển PHP tags thành comments có nghĩa để AI hiểu cấu trúc
  private stripPhp(source: string): string {
    return (
      source
        // PHP i18n functions INSIDE JSON string values → extract the first string literal
        // e.g. "<?php esc_html_e( 'Team', 'domain' ); ?>" → "Team"
        .replace(
          /"<\?php\s+(?:esc_html_e|esc_attr_e|esc_html|esc_attr|__|_e)\s*\(\s*'([^']+)'[\s\S]*?\?>"/g,
          '"$1"',
        )
        // PHP i18n echoes in HTML content → extract the string literal as plain text
        // e.g. <?php esc_html_e( 'A commitment to innovation', 'domain' ); ?> → A commitment to innovation
        // e.g. <?php echo esc_html( 'text' ); ?> → text
        .replace(
          /<\?php\s+(?:esc_html_e|_e)\s*\(\s*'([^']+)'[\s\S]*?\?>/g,
          '$1',
        )
        .replace(
          /<\?php\s+echo\s+(?:esc_html|esc_attr|__)\s*\(\s*'([^']+)'[\s\S]*?\?>/g,
          '$1',
        )
        // get_header(), get_footer(), get_sidebar() → gợi ý component
        .replace(
          /<?php\s+get_header\([^)]*\)\s*;?\s*\?>/g,
          '{/* WP: <Header /> */}',
        )
        .replace(
          /<?php\s+get_footer\([^)]*\)\s*;?\s*\?>/g,
          '{/* WP: <Footer /> */}',
        )
        .replace(
          /<?php\s+get_sidebar\([^)]*\)\s*;?\s*\?>/g,
          '{/* WP: <Sidebar /> */}',
        )
        // wp_nav_menu() → navigation hint (must run BEFORE catch-all)
        .replace(
          /<\?php[\s\S]*?wp_nav_menu[\s\S]*?\?>/g,
          '{/* WP: <Navigation /> */}',
        )
        // The Loop
        .replace(
          /<?php\s+while\s*\(\s*have_posts\(\)\s*\)[^?]*\?>/g,
          '{/* WP: loop start — map over posts[] */}',
        )
        .replace(/<?php\s+endwhile\s*;?\s*\?>/g, '{/* WP: loop end */}')
        // Common template tags → data hints
        .replace(
          /<?php\s+the_title\([^)]*\)\s*;?\s*\?>/g,
          '{/* WP: post.title */}',
        )
        .replace(
          /<?php\s+the_content\([^)]*\)\s*;?\s*\?>/g,
          '{/* WP: post.content (HTML) */}',
        )
        .replace(
          /<?php\s+the_excerpt\([^)]*\)\s*;?\s*\?>/g,
          '{/* WP: post.excerpt */}',
        )
        .replace(
          /<?php\s+the_permalink\([^)]*\)\s*;?\s*\?>/g,
          '{/* WP: /post/{post.slug} */}',
        )
        .replace(
          /<?php\s+the_date\([^)]*\)\s*;?\s*\?>/g,
          '{/* WP: post.date */}',
        )
        .replace(
          /<?php\s+the_author\([^)]*\)\s*;?\s*\?>/g,
          '{/* WP: post.author */}',
        )
        .replace(
          /<?php\s+bloginfo\(\s*['"]name['"]\s*\)[^?]*\?>/g,
          '{/* WP: site.siteName */}',
        )
        .replace(
          /<?php\s+bloginfo\(\s*['"]description['"]\s*\)[^?]*\?>/g,
          '{/* WP: site.description */}',
        )
        // echo / short tags
        .replace(
          /<\?=\s*([^?]+)\?>/g,
          (_match, expr) => `{/* WP: ${expr.trim()} */}`,
        )
        // PHP blocks còn lại (if, foreach, function defs...) → xóa nhưng giữ dòng trống
        .replace(/<\?php[\s\S]*?\?>/g, '')
        .replace(/\s{2,}/g, ' ')
        .trim()
    );
  }
}
