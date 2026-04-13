import { EditRequestService } from './edit-request.service.js';

describe(EditRequestService.name, () => {
  let service: EditRequestService;

  beforeEach(() => {
    service = new EditRequestService();
  });

  it('treats attachments-only payloads as the current schema', () => {
    const result = service.prepare({
      language: 'vi',
      pageContext: {
        wordpressUrl: 'http://localhost:8000',
        wordpressRoute: '/',
        iframeSrc:
          '/api/wp/proxy?url=http%3A%2F%2Flocalhost%3A8000&siteId=wp-1776064736747-8eb93302',
        pageTitle: 'CASSO',
        viewport: {
          width: 1440,
          height: 900,
        },
        document: {
          width: 1440,
          height: 3200,
        },
      },
      attachments: [
        {
          id: 'capture-1',
          note: 'Giữ bố cục hero giống bản WordPress và chỉnh lại khoảng cách.',
          sourcePageUrl: 'http://localhost:8000',
          asset: {
            provider: 'local',
            fileName: 'capture-1.png',
            publicUrl: 'http://localhost:3000/uploads/capture-1.png',
          },
        },
      ],
    });

    expect(result.summary.source).toBe('current');
    expect(result.summary.attachmentCount).toBe(1);
    expect(result.summary.hasVisualContext).toBe(true);
    expect(result.request?.attachments).toHaveLength(1);
    expect(result.request?.attachments?.[0]?.id).toBe('capture-1');
    expect(result.request?.language).toBe('vi');
  });
});
