import { describe, expect, it } from 'vitest';
import { handleEdgeOne } from '../../src/edgeone';
import { baseEnv, inlineSource, SS_URI } from './helpers';

describe('EdgeOne Cloud Functions adapter', () => {
  it('serves /version with the EdgeOne context shape', async () => {
    const response = await handleEdgeOne({
      request: new Request('https://edgeone.test/version'),
      env: baseEnv,
      waitUntil: () => {},
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('subconverter-worker');
  });

  it('converts an inline subscription through the same pipeline', async () => {
    const url = `https://edgeone.test/sub?target=clash&url=${encodeURIComponent(inlineSource(SS_URI))}`;
    const response = await handleEdgeOne({
      request: new Request(url),
      env: baseEnv,
    });

    expect(response.status).toBe(200);
    const yaml = await response.text();
    expect(yaml).toContain('proxies:');
    expect(yaml).not.toContain('DOMA');
  });
});
