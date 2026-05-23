import { describe, it, expect, beforeEach } from 'vitest';
import { createFlowVersionManagerFeature } from '../features/flow-version-manager.js';

describe('flow-version-manager teardown', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    const table = document.createElement('table');
    table.className = 'list';
    table.id = 'view:lists:versions';
    document.body.appendChild(table);
  });

  it('removes any injected panel and stops observers on teardown', async () => {
    const feature = createFlowVersionManagerFeature();
    await feature.init?.();
    await feature.teardown?.();
    expect(document.querySelector('.sfut-version-manager-panel')).toBeNull();
  });

  it('removes injected checkbox column cells on teardown', async () => {
    const feature = createFlowVersionManagerFeature();
    await feature.init?.();
    await feature.teardown?.();
    expect(document.querySelectorAll('.sfut-version-select-cell')).toHaveLength(0);
  });

  it('removes the toolbar delete button on teardown', async () => {
    const feature = createFlowVersionManagerFeature();
    await feature.init?.();
    await feature.teardown?.();
    expect(document.querySelector('.sfut-version-manager-delete-btn')).toBeNull();
  });

  it('teardown does not throw even if init was never called', async () => {
    const feature = createFlowVersionManagerFeature();
    await expect(feature.teardown?.()).resolves.not.toThrow();
  });

  it('teardown does not throw when called twice', async () => {
    const feature = createFlowVersionManagerFeature();
    await feature.init?.();
    await feature.teardown?.();
    await expect(feature.teardown?.()).resolves.not.toThrow();
  });

  it('removes any stranded modal backdrop on teardown', async () => {
    const feature = createFlowVersionManagerFeature();
    await feature.init?.();
    // Simulate an open confirmation modal by manually injecting the backdrop
    const backdrop = document.createElement('div');
    backdrop.className = 'sfut-version-manager-backdrop';
    document.body.appendChild(backdrop);
    expect(document.querySelector('.sfut-version-manager-backdrop')).not.toBeNull();
    await feature.teardown?.();
    expect(document.querySelector('.sfut-version-manager-backdrop')).toBeNull();
  });
});
