import type { DataNeed } from '../react-generator/visual-plan.schema.js';

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
