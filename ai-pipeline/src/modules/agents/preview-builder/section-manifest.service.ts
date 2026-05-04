import { Injectable } from '@nestjs/common';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import type { PlanResult } from '../planner/planner.service.js';
import { resolvePlannerSectionBlueprint } from '../planner/planner-surface-plan.util.js';
import type { PreviewRouteEntry } from './preview-builder.service.js';
import { isPartialComponentName } from '../shared/component-kind.util.js';
import type { PipelineCaptureNormalizedBBoxDto } from '../../orchestrator/orchestrator.dto.js';

export interface SectionManifestSection {
  debugKey: string;
  type: string;
  sectionIndex: number;
  verticalRange: [number, number];
}

export interface SectionManifestEntry {
  componentName: string;
  filePath: string;
  route: string;
  sections: SectionManifestSection[];
}

export interface SectionResolution {
  componentName: string;
  sectionIndex: number;
  sectionType: string;
  debugKey: string;
}

const MANIFEST_FILE = 'section-manifest.json';

@Injectable()
export class SectionManifestService {
  generateManifest(
    plan: PlanResult,
    routeEntries: PreviewRouteEntry[],
  ): SectionManifestEntry[] {
    const routeByComponent = new Map(
      routeEntries.map((e) => [e.componentName, e.route]),
    );

    const entries: SectionManifestEntry[] = [];

    for (const planEntry of plan) {
      const sections = resolvePlannerSectionBlueprint({
        visualPlan: planEntry.visualPlan,
        surfacePlan: planEntry.surfacePlan,
      });
      if (!sections?.length) continue;

      const n = sections.length;
      const route =
        planEntry.route ?? routeByComponent.get(planEntry.componentName) ?? '/';
      const folder = isPartialComponentName(planEntry.componentName)
        ? 'components'
        : 'pages';

      entries.push({
        componentName: planEntry.componentName,
        filePath: `frontend/src/${folder}/${planEntry.componentName}.tsx`,
        route,
        sections: sections.map((section, index) => ({
          debugKey:
            section.debugKey?.trim() ||
            section.sectionKey?.trim() ||
            `${section.type}-${index + 1}`,
          type: section.type,
          sectionIndex: index,
          verticalRange: [index / n, (index + 1) / n],
        })),
      });
    }

    return entries;
  }

  async writeManifest(
    previewDir: string,
    manifest: SectionManifestEntry[],
  ): Promise<string> {
    const filePath = join(previewDir, MANIFEST_FILE);
    await writeFile(filePath, JSON.stringify(manifest, null, 2), 'utf-8');
    return filePath;
  }

  async readManifest(
    previewDir: string,
  ): Promise<SectionManifestEntry[] | null> {
    try {
      const raw = await readFile(join(previewDir, MANIFEST_FILE), 'utf-8');
      return JSON.parse(raw) as SectionManifestEntry[];
    } catch {
      return null;
    }
  }

  resolveSection(
    manifest: SectionManifestEntry[],
    route: string,
    normalizedRect: PipelineCaptureNormalizedBBoxDto,
  ): SectionResolution | null {
    const entry = this.findEntryByRoute(manifest, route);
    if (!entry || entry.sections.length === 0) return null;

    const captureTop = normalizedRect.y;
    const captureBottom = captureTop + normalizedRect.height;
    let bestSection = entry.sections[0];
    let bestOverlap = -1;

    for (const section of entry.sections) {
      const [rangeTop, rangeBottom] = section.verticalRange;
      const overlapTop = Math.max(captureTop, rangeTop);
      const overlapBottom = Math.min(captureBottom, rangeBottom);
      const overlap = Math.max(0, overlapBottom - overlapTop);
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestSection = section;
      }
    }

    return {
      componentName: entry.componentName,
      sectionIndex: bestSection.sectionIndex,
      sectionType: bestSection.type,
      debugKey: bestSection.debugKey,
    };
  }

  private findEntryByRoute(
    manifest: SectionManifestEntry[],
    route: string,
  ): SectionManifestEntry | undefined {
    const exact = manifest.find((e) => e.route === route);
    if (exact) return exact;
    const normalized = route.replace(/\/$/, '') || '/';
    return manifest.find(
      (e) =>
        e.route === normalized || e.route.replace(/\/$/, '') === normalized,
    );
  }
}
