import type {
  ComponentVisualPlan,
  DataNeed,
} from '../react-generator/visual-plan.schema.js';

const VISUAL_DATA_NEED_ORDER: DataNeed[] = [
  'postDetail',
  'productDetail',
  'pageDetail',
  'comments',
  'posts',
  'products',
  'pages',
  'menus',
  'siteInfo',
  'footerLinks',
];

export function orderVisualDataNeeds(
  dataNeeds: ReadonlyArray<DataNeed>,
): DataNeed[] {
  const lookup = new Set(dataNeeds);
  return VISUAL_DATA_NEED_ORDER.filter((need) => lookup.has(need));
}

export function toVisualDataNeeds(
  dataNeeds?: ReadonlyArray<string>,
): DataNeed[] {
  const mapped = new Set<DataNeed>();

  for (const need of dataNeeds ?? []) {
    switch (need) {
      case 'site-info':
        mapped.add('siteInfo');
        break;
      case 'footer-links':
        mapped.add('footerLinks');
        break;
      case 'post-detail':
        mapped.add('postDetail');
        break;
      case 'product-detail':
        mapped.add('productDetail');
        break;
      case 'page-detail':
        mapped.add('pageDetail');
        break;
      case 'comments':
        mapped.add('comments');
        break;
      case 'posts':
      case 'products':
      case 'pages':
      case 'menus':
        mapped.add(need);
        break;
    }
  }

  return orderVisualDataNeeds([...mapped]);
}

export interface VisualPlanContractSource {
  dataNeeds?: ReadonlyArray<string>;
  fixedSlug?: string;
  fixedTitle?: string;
  fixedPageId?: number | string;
  route?: string | null;
  runtimeRenderer?: 'runtime-page';
}

function sameVisualDataNeeds(
  left: ReadonlyArray<DataNeed>,
  right: ReadonlyArray<DataNeed>,
): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

export function synchronizeVisualPlanContract(
  visualPlan: ComponentVisualPlan | undefined,
  contract: VisualPlanContractSource | undefined,
): ComponentVisualPlan | undefined {
  if (!visualPlan) return undefined;

  let changed = false;
  let nextVisualPlan: ComponentVisualPlan = visualPlan;

  if (Array.isArray(contract?.dataNeeds)) {
    const syncedDataNeeds = toVisualDataNeeds(contract.dataNeeds);
    const shouldSyncDataNeeds =
      syncedDataNeeds.length > 0 || contract.dataNeeds.length === 0;
    if (
      shouldSyncDataNeeds &&
      !sameVisualDataNeeds(visualPlan.dataNeeds ?? [], syncedDataNeeds)
    ) {
      nextVisualPlan = {
        ...nextVisualPlan,
        dataNeeds: syncedDataNeeds,
      };
      changed = true;
    }
  }

  if (
    contract?.runtimeRenderer &&
    contract.runtimeRenderer !== visualPlan.runtimeRenderer
  ) {
    nextVisualPlan = {
      ...nextVisualPlan,
      runtimeRenderer: contract.runtimeRenderer,
    };
    changed = true;
  }

  if (contract?.fixedSlug) {
    const nextPageBinding = {
      ...nextVisualPlan.pageBinding,
      ...(contract.fixedPageId !== undefined
        ? { id: contract.fixedPageId }
        : {}),
      ...(contract.fixedTitle ? { title: contract.fixedTitle } : {}),
      ...(contract.route ? { route: contract.route } : {}),
      slug: contract.fixedSlug,
    };
    const currentPageBinding = nextVisualPlan.pageBinding;
    const pageBindingChanged =
      currentPageBinding?.slug !== nextPageBinding.slug ||
      currentPageBinding?.id !== nextPageBinding.id ||
      currentPageBinding?.title !== nextPageBinding.title ||
      currentPageBinding?.route !== nextPageBinding.route;
    if (pageBindingChanged) {
      nextVisualPlan = {
        ...nextVisualPlan,
        pageBinding: nextPageBinding,
      };
      changed = true;
    }
  }

  return changed ? nextVisualPlan : visualPlan;
}
