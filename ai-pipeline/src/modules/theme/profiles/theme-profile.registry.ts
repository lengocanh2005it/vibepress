import { Injectable } from '@nestjs/common';
import { GENERIC_FSE_THEME_PROFILE } from './generic-fse.profile.js';
import { PROFOLIO_FSE_THEME_PROFILE } from './profolio-fse.profile.js';
import type { ThemeProfile } from './theme-profile.interface.js';
import { normalizeThemeSlug } from './theme-profile.interface.js';
import { TWENTYTWENTYFOUR_THEME_PROFILE } from './twentytwentyfour.profile.js';

@Injectable()
export class ThemeProfileRegistry {
  private readonly knownFseProfiles: ThemeProfile[] = [
    TWENTYTWENTYFOUR_THEME_PROFILE,
    PROFOLIO_FSE_THEME_PROFILE,
  ];

  getGenericFseProfile(): ThemeProfile {
    return GENERIC_FSE_THEME_PROFILE;
  }

  getKnownFseProfiles(): readonly ThemeProfile[] {
    return this.knownFseProfiles;
  }

  getKnownFseThemeSlugs(): string[] {
    return this.knownFseProfiles
      .map((profile) => profile.slug)
      .filter((slug): slug is string => Boolean(slug));
  }

  isKnownFseThemeSlug(value?: string | null): boolean {
    const normalized = normalizeThemeSlug(value);
    return this.getKnownFseThemeSlugs().includes(normalized);
  }

  resolveFseProfile(value?: string | null): ThemeProfile {
    const normalized = normalizeThemeSlug(value);
    return (
      this.knownFseProfiles.find(
        (profile) => normalizeThemeSlug(profile.slug) === normalized,
      ) ?? GENERIC_FSE_THEME_PROFILE
    );
  }

  formatKnownFseThemeSlugs(): string {
    return this.getKnownFseThemeSlugs().join(', ');
  }
}
