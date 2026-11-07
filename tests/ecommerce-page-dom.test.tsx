// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, test, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  loadGroups: vi.fn(async () => undefined),
  groups: { 'web:alice': { name: '测试工作区' } },
  get: vi.fn(async (path: string) =>
    path.endsWith('/approvals')
      ? [
          {
            id: 'a1',
            workflow_id: 'w1',
            revision: 1,
            status: 'pending',
            expires_at: '2026-12-01T00:00:00Z',
            spec: {
              sku: 'SKU-002',
              quantity: 70,
              supplier_id: 'DEMO',
              total_cost_cents: 455000,
              environment: 'test',
            },
          },
        ]
      : [],
  ),
  post: vi.fn(async () => ({})),
}));
vi.mock('../web/src/stores/groups', () => ({
  useGroupsStore: (select: (s: unknown) => unknown) =>
    select({ groups: mocks.groups, loadGroups: mocks.loadGroups }),
}));
vi.mock('../web/src/api/client', () => ({
  api: { get: mocks.get, post: mocks.post },
}));
import { EcommercePage } from '../web/src/pages/EcommercePage';
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});
test('human sees exact purchase effect and cannot approve without a reason', async () => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<EcommercePage />);
  });
  await vi.waitFor(() =>
    expect(container!.textContent).toContain('采购 70 件'),
  );
  expect(container.textContent).toContain('当前库存不会增加');
  const approve = [...container.querySelectorAll('button')].find(
    (b) => b.textContent === '批准此方案',
  )!;
  expect(approve.disabled).toBe(true);
  const input = container.querySelector<HTMLInputElement>(
    '[aria-label="审批理由"]',
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(input, '确认隔离测试采购70件');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(approve.disabled).toBe(false);
  await act(async () => {
    approve.click();
  });
  expect(mocks.post).toHaveBeenCalledWith(
    '/api/ecommerce/workspaces/web%3Aalice/approvals/a1/review',
    {
      expected_revision: 1,
      decision: 'approved',
      reason: '确认隔离测试采购70件',
    },
  );
  expect(
    mocks.post.mock.calls.some((call) =>
      JSON.stringify(call).includes('reviewed_by'),
    ),
  ).toBe(false);
});
