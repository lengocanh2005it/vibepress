import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { lastValueFrom } from 'rxjs';
import type {
  WpRuntimeFeatures,
  WpSiteInfo,
} from '../../sql/wp-query.service.js';

export type PluginEvidenceSource =
  | 'active_plugins'
  | 'post_types'
  | 'meta_keys'
  | 'shortcodes'
  | 'option_keys'
  | 'block_types'
  | 'elementor_data'
  | 'rest_namespaces';

export interface PluginEvidence {
  source: PluginEvidenceSource;
  match: string;
  detail?: string;
  confidence: 'high' | 'medium' | 'low';
}

export interface DetectedPlugin {
  slug: string;
  confidence: 'high' | 'medium' | 'low';
  evidence: PluginEvidence[];
  capabilities: string[];
}

export interface PluginDiscoverySummary {
  restNamespaces: string[];
  activePluginSlugs: string[];
  topShortcodes: string[];
  topBlockTypes: string[];
  pluginOptionKeys: string[];
  elementorWidgetTypes: string[];
}

export interface PluginDiscoveryResult {
  detectedPlugins: DetectedPlugin[];
  summary: PluginDiscoverySummary;
}

@Injectable()
export class PluginDiscoveryService {
  private readonly logger = new Logger(PluginDiscoveryService.name);

  constructor(private readonly httpService: HttpService) {}

  async discover(input: {
    siteInfo: WpSiteInfo;
    runtimeFeatures: WpRuntimeFeatures;
  }): Promise<PluginDiscoveryResult> {
    const { siteInfo, runtimeFeatures } = input;
    const restNamespaces = await this.fetchRestNamespaces(siteInfo.siteUrl);
    const detectedPlugins = this.detectPlugins(runtimeFeatures, restNamespaces);

    return {
      detectedPlugins,
      summary: {
        restNamespaces,
        activePluginSlugs: runtimeFeatures.capabilities.activePluginSlugs,
        topShortcodes: runtimeFeatures.shortcodes
          .slice(0, 12)
          .map((item) => item.shortcode),
        topBlockTypes: runtimeFeatures.blockTypes
          .slice(0, 12)
          .map((item) => item.blockType),
        pluginOptionKeys: runtimeFeatures.optionKeys.slice(0, 24),
        elementorWidgetTypes: Array.from(
          new Set(
            runtimeFeatures.elementorDocuments.flatMap(
              (doc) => doc.widgetTypes,
            ),
          ),
        ).sort(),
      },
    };
  }

  private detectPlugins(
    runtimeFeatures: WpRuntimeFeatures,
    restNamespaces: string[],
  ): DetectedPlugin[] {
    const detected: DetectedPlugin[] = [];

    const addDetected = (
      slug: string,
      capabilities: string[],
      evidence: PluginEvidence[],
    ) => {
      if (evidence.length === 0) return;
      detected.push({
        slug,
        confidence: this.scoreConfidence(evidence),
        evidence,
        capabilities: Array.from(new Set(capabilities)).sort(),
      });
    };

    addDetected(
      'elementor',
      this.detectElementorCapabilities(runtimeFeatures, restNamespaces),
      this.collectElementorEvidence(runtimeFeatures, restNamespaces),
    );

    addDetected(
      'acf',
      this.detectAcfCapabilities(runtimeFeatures, restNamespaces),
      this.collectAcfEvidence(runtimeFeatures, restNamespaces),
    );

    addDetected(
      'yoast',
      this.detectYoastCapabilities(runtimeFeatures, restNamespaces),
      this.collectYoastEvidence(runtimeFeatures, restNamespaces),
    );

    addDetected(
      'contact-form-7',
      this.detectCf7Capabilities(runtimeFeatures, restNamespaces),
      this.collectCf7Evidence(runtimeFeatures, restNamespaces),
    );

    addDetected(
      'ultimate-addons-for-gutenberg',
      this.detectSpectraCapabilities(runtimeFeatures),
      this.collectSpectraEvidence(runtimeFeatures),
    );

    // Detect any remaining active plugins not caught by the known detectors above
    const detectedSlugs = new Set(detected.map((d) => d.slug));
    const knownPluginSlugs = new Set([
      'elementor',
      'advanced-custom-fields',
      'advanced-custom-fields-pro',
      'wordpress-seo',
      'contact-form-7',
      'ultimate-addons-for-gutenberg',
      'spectra',
    ]);
    for (const plugin of runtimeFeatures.plugins) {
      if (detectedSlugs.has(plugin.slug) || knownPluginSlugs.has(plugin.slug))
        continue;
      detected.push({
        slug: plugin.slug,
        confidence: 'high',
        evidence: [
          {
            source: 'active_plugins',
            match: plugin.pluginFile ?? plugin.slug,
            confidence: 'high',
          },
        ],
        capabilities: [],
      });
    }

    return detected.sort((a, b) => a.slug.localeCompare(b.slug));
  }

  private collectElementorEvidence(
    runtimeFeatures: WpRuntimeFeatures,
    restNamespaces: string[],
  ): PluginEvidence[] {
    const evidence: PluginEvidence[] = [];
    this.pushIf(
      evidence,
      runtimeFeatures.plugins.some((plugin) => plugin.slug === 'elementor'),
      {
        source: 'active_plugins',
        match: 'elementor/elementor.php',
        confidence: 'high',
      },
    );
    const elementorMeta = runtimeFeatures.metaKeys.find(
      (item) => item.metaKey === '_elementor_data',
    );
    this.pushIf(evidence, !!elementorMeta, {
      source: 'meta_keys',
      match: '_elementor_data',
      detail: elementorMeta ? `${elementorMeta.count} rows` : undefined,
      confidence: 'high',
    });
    this.pushIf(evidence, runtimeFeatures.elementorDocuments.length > 0, {
      source: 'elementor_data',
      match: '_elementor_data JSON',
      detail: `${runtimeFeatures.elementorDocuments.length} documents`,
      confidence: 'high',
    });
    this.pushIf(
      evidence,
      runtimeFeatures.optionKeys.some((key) => key.startsWith('elementor_')),
      {
        source: 'option_keys',
        match:
          runtimeFeatures.optionKeys.find((key) =>
            key.startsWith('elementor_'),
          ) ?? 'elementor_*',
        confidence: 'medium',
      },
    );
    this.pushIf(evidence, restNamespaces.includes('elementor/v1'), {
      source: 'rest_namespaces',
      match: 'elementor/v1',
      confidence: 'high',
    });
    return evidence;
  }

  private collectAcfEvidence(
    runtimeFeatures: WpRuntimeFeatures,
    restNamespaces: string[],
  ): PluginEvidence[] {
    const evidence: PluginEvidence[] = [];
    this.pushIf(
      evidence,
      runtimeFeatures.plugins.some((plugin) =>
        ['advanced-custom-fields', 'advanced-custom-fields-pro'].includes(
          plugin.slug,
        ),
      ),
      {
        source: 'active_plugins',
        match:
          runtimeFeatures.plugins.find((plugin) =>
            ['advanced-custom-fields', 'advanced-custom-fields-pro'].includes(
              plugin.slug,
            ),
          )?.pluginFile ?? 'advanced-custom-fields/acf.php',
        confidence: 'high',
      },
    );
    this.pushIf(
      evidence,
      runtimeFeatures.metaKeys.some(
        (item) =>
          item.metaKey.startsWith('acf_') || item.metaKey.startsWith('_acf_'),
      ),
      {
        source: 'meta_keys',
        match:
          runtimeFeatures.metaKeys.find(
            (item) =>
              item.metaKey.startsWith('acf_') ||
              item.metaKey.startsWith('_acf_'),
          )?.metaKey ?? 'acf_*',
        confidence: 'medium',
      },
    );
    this.pushIf(
      evidence,
      runtimeFeatures.blockTypes.some((item) =>
        item.blockType.startsWith('acf/'),
      ),
      {
        source: 'block_types',
        match:
          runtimeFeatures.blockTypes.find((item) =>
            item.blockType.startsWith('acf/'),
          )?.blockType ?? 'acf/*',
        confidence: 'high',
      },
    );
    this.pushIf(
      evidence,
      runtimeFeatures.optionKeys.some((key) => key.startsWith('acf_')),
      {
        source: 'option_keys',
        match:
          runtimeFeatures.optionKeys.find((key) => key.startsWith('acf_')) ??
          'acf_*',
        confidence: 'medium',
      },
    );
    this.pushIf(evidence, restNamespaces.includes('acf/v3'), {
      source: 'rest_namespaces',
      match: 'acf/v3',
      confidence: 'high',
    });
    return evidence;
  }

  private collectYoastEvidence(
    runtimeFeatures: WpRuntimeFeatures,
    restNamespaces: string[],
  ): PluginEvidence[] {
    const evidence: PluginEvidence[] = [];
    this.pushIf(
      evidence,
      runtimeFeatures.plugins.some((plugin) => plugin.slug === 'wordpress-seo'),
      {
        source: 'active_plugins',
        match: 'wordpress-seo/wp-seo.php',
        confidence: 'high',
      },
    );
    this.pushIf(evidence, runtimeFeatures.optionKeys.includes('wpseo_titles'), {
      source: 'option_keys',
      match: 'wpseo_titles',
      confidence: 'high',
    });
    this.pushIf(evidence, restNamespaces.includes('yoast/v1'), {
      source: 'rest_namespaces',
      match: 'yoast/v1',
      confidence: 'high',
    });
    return evidence;
  }

  private collectCf7Evidence(
    runtimeFeatures: WpRuntimeFeatures,
    restNamespaces: string[],
  ): PluginEvidence[] {
    const evidence: PluginEvidence[] = [];
    this.pushIf(
      evidence,
      runtimeFeatures.plugins.some(
        (plugin) => plugin.slug === 'contact-form-7',
      ),
      {
        source: 'active_plugins',
        match: 'contact-form-7/wp-contact-form-7.php',
        confidence: 'high',
      },
    );
    this.pushIf(
      evidence,
      runtimeFeatures.shortcodes.some(
        (item) =>
          item.shortcode === 'contact-form-7' ||
          item.shortcode === 'contact-form',
      ),
      {
        source: 'shortcodes',
        match:
          runtimeFeatures.shortcodes.find(
            (item) =>
              item.shortcode === 'contact-form-7' ||
              item.shortcode === 'contact-form',
          )?.shortcode ?? 'contact-form-7',
        confidence: 'high',
      },
    );
    this.pushIf(
      evidence,
      restNamespaces.some((namespace) => /contact-forms|cf7/i.test(namespace)),
      {
        source: 'rest_namespaces',
        match:
          restNamespaces.find((namespace) =>
            /contact-forms|cf7/i.test(namespace),
          ) ?? 'cf7/*',
        confidence: 'medium',
      },
    );
    return evidence;
  }

  private detectElementorCapabilities(
    runtimeFeatures: WpRuntimeFeatures,
    restNamespaces: string[],
  ): string[] {
    const capabilities = ['page-builder'];
    if (runtimeFeatures.elementorDocuments.length > 0) {
      capabilities.push('widgets');
    }
    if (restNamespaces.includes('elementor/v1')) {
      capabilities.push('rest-api');
    }
    return capabilities;
  }

  private detectAcfCapabilities(
    runtimeFeatures: WpRuntimeFeatures,
    restNamespaces: string[],
  ): string[] {
    const capabilities = ['custom-fields'];
    if (
      runtimeFeatures.blockTypes.some((item) =>
        item.blockType.startsWith('acf/'),
      )
    ) {
      capabilities.push('blocks');
    }
    if (restNamespaces.includes('acf/v3')) {
      capabilities.push('rest-api');
    }
    return capabilities;
  }

  private detectYoastCapabilities(
    _runtimeFeatures: WpRuntimeFeatures,
    restNamespaces: string[],
  ): string[] {
    const capabilities = ['seo-meta'];
    if (restNamespaces.includes('yoast/v1')) {
      capabilities.push('rest-api');
    }
    return capabilities;
  }

  private detectCf7Capabilities(
    _runtimeFeatures: WpRuntimeFeatures,
    restNamespaces: string[],
  ): string[] {
    const capabilities = ['forms'];
    if (
      restNamespaces.some((namespace) => /contact-forms|cf7/i.test(namespace))
    ) {
      capabilities.push('rest-api');
    }
    return capabilities;
  }

  private collectSpectraEvidence(
    runtimeFeatures: WpRuntimeFeatures,
  ): PluginEvidence[] {
    const evidence: PluginEvidence[] = [];
    this.pushIf(
      evidence,
      runtimeFeatures.plugins.some((plugin) =>
        ['ultimate-addons-for-gutenberg', 'spectra'].includes(plugin.slug),
      ),
      {
        source: 'active_plugins',
        match:
          runtimeFeatures.plugins.find((plugin) =>
            ['ultimate-addons-for-gutenberg', 'spectra'].includes(plugin.slug),
          )?.pluginFile ??
          'ultimate-addons-for-gutenberg/ultimate-addons-for-gutenberg.php',
        confidence: 'high',
      },
    );
    this.pushIf(
      evidence,
      runtimeFeatures.blockTypes.some((item) =>
        item.blockType.startsWith('uagb/'),
      ),
      {
        source: 'block_types',
        match:
          runtimeFeatures.blockTypes.find((item) =>
            item.blockType.startsWith('uagb/'),
          )?.blockType ?? 'uagb/*',
        confidence: 'high',
      },
    );
    this.pushIf(
      evidence,
      runtimeFeatures.optionKeys.some((key) => /^uagb_/i.test(key)),
      {
        source: 'option_keys',
        match:
          runtimeFeatures.optionKeys.find((key) => /^uagb_/i.test(key)) ??
          'uagb_*',
        confidence: 'medium',
      },
    );
    return evidence;
  }

  private detectSpectraCapabilities(
    runtimeFeatures: WpRuntimeFeatures,
  ): string[] {
    const capabilities = ['blocks', 'interactive-widgets'];
    const blockTypes = runtimeFeatures.blockTypes.map((item) =>
      item.blockType.toLowerCase(),
    );
    if (blockTypes.some((block) => /\bmodal\b|\bpopup\b/.test(block))) {
      capabilities.push('modal');
    }
    if (blockTypes.some((block) => /\bslider\b|\bcarousel\b/.test(block))) {
      capabilities.push('slider');
    }
    return capabilities;
  }

  private scoreConfidence(
    evidence: PluginEvidence[],
  ): 'high' | 'medium' | 'low' {
    const highCount = evidence.filter(
      (item) => item.confidence === 'high',
    ).length;
    const mediumCount = evidence.filter(
      (item) => item.confidence === 'medium',
    ).length;
    if (highCount >= 2) return 'high';
    if (highCount >= 1 || mediumCount >= 2) return 'medium';
    return 'low';
  }

  private pushIf(
    target: PluginEvidence[],
    condition: boolean,
    evidence: PluginEvidence,
  ): void {
    if (condition) target.push(evidence);
  }

  private async fetchRestNamespaces(siteUrl: string): Promise<string[]> {
    if (!siteUrl) return [];
    let url: URL;
    try {
      url = new URL(
        '/wp-json/',
        siteUrl.endsWith('/') ? siteUrl : `${siteUrl}/`,
      );
    } catch {
      return [];
    }

    try {
      const response = await lastValueFrom(
        this.httpService.get(url.toString(), {
          timeout: 3000,
          validateStatus: (status) => status >= 200 && status < 400,
        }),
      );
      const namespaces = Array.isArray(response.data?.namespaces)
        ? response.data.namespaces.filter(
            (value: unknown): value is string => typeof value === 'string',
          )
        : [];
      return namespaces.sort();
    } catch (err: any) {
      this.logger.debug(
        `Skipping REST namespace discovery for ${siteUrl}: ${err?.message ?? err}`,
      );
      return [];
    }
  }
}
