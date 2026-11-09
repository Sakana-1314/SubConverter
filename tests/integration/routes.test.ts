import { describe, expect, it } from 'vitest';
import { encodeBase64Url } from '../../src/links/base64';
import { baseEnv, call, callAt, inlineSource, SS_URI } from './helpers';

function subQuery(text: string): string {
  return `/sub?url=${encodeURIComponent(inlineSource(text))}`;
}

describe('routes: meta', () => {
  it('serves /version as plain text with cache and CORS headers', async () => {
    const response = await call('GET', '/version');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('subconverter-worker 1.0.0 target=clash\n');
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('public, max-age=3600');
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('x-subconverter-version')).toBe('1.0.0');
  });

  it('serves / as self-contained HTML with a CSP', async () => {
    const response = await call('GET', '/');
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('<title>subconverter-worker 1.0.0</title>');
    expect(body).not.toContain('<script');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('supports HEAD on / and /version without a body', async () => {
    for (const path of ['/', '/version']) {
      const response = await call('HEAD', path);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('');
    }
  });

  it('returns 404 for unregistered paths and 405 for wrong methods', async () => {
    const notFound = await call('GET', '/nope');
    expect(notFound.status).toBe(404);
    expect(notFound.headers.get('x-content-type-options')).toBe('nosniff');

    const wrongMethod = await call('POST', '/');
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get('allow')).toBe('GET, HEAD, OPTIONS');

    const headSub = await call('HEAD', '/sub');
    expect(headSub.status).toBe(405);
    expect(headSub.headers.get('allow')).toBe('GET, OPTIONS');
    expect(await headSub.text()).toBe('');
  });

  it('answers CORS preflight for registered paths', async () => {
    const response = await call('OPTIONS', '/sub');
    expect(response.status).toBe(204);
    expect(response.headers.get('allow')).toBe('GET, OPTIONS');
    expect(response.headers.get('access-control-allow-methods')).toBe('GET, OPTIONS');
    expect(response.headers.get('access-control-max-age')).toBe('86400');
  });
});

describe('routes: /sub', () => {
  it('converts an inline SS subscription to deterministic mihomo YAML', async () => {
    const response = await call('GET', subQuery(SS_URI));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/yaml; charset=utf-8');
    expect(response.headers.get('x-subconverter-target')).toBe('clash');
    expect(response.headers.get('x-subconverter-node-count')).toBe('1');
    expect(response.headers.get('x-subconverter-rule-count')).toBe('1');
    expect(response.headers.get('x-subconverter-warnings')).not.toBeNull();

    const yaml = await response.text();
    expect(yaml).toContain('proxies:\n  - name: node1');
    expect(yaml).toContain('type: ss');
    expect(yaml).toContain('proxy-groups:');
    expect(yaml).toContain('"MATCH,PROXY"');
    expect(yaml.endsWith('\n')).toBe(true);
  });

  it('returns diagnostics=json with stats, warnings and output', async () => {
    const response = await call('GET', `${subQuery(SS_URI)}&diagnostics=json`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(response.headers.get('x-subconverter-diagnostics')).toBe('json');
    const body = (await response.json()) as {
      ok: boolean;
      target: string;
      output: string;
      stats: { nodes: number; rules: number; sources: number };
      warnings: unknown[];
    };
    expect(body.ok).toBe(true);
    expect(body.target).toBe('clash');
    expect(body.output).toContain('proxies:');
    expect(body.stats.nodes).toBe(1);
    expect(body.stats.rules).toBe(1);
    expect(body.stats.sources).toBe(1);
    expect(Array.isArray(body.warnings)).toBe(true);
  });

  it('applies config groups, rename and ruleset', async () => {
    const ruleSource = inlineSource('DOMAIN-SUFFIX,example.com\nDOMAIN,foo.org');
    const config = [
      '[custom]',
      'custom_proxy_group=PROXY`select`.*',
      'custom_proxy_group=Auto`url-test`.*`http://example.com`300',
      `ruleset=PROXY,${ruleSource}`,
      'rename=node@renamed',
    ].join('\n');
    const path =
      `/sub?url=${encodeURIComponent(inlineSource(SS_URI))}` +
      `&config=${encodeURIComponent(inlineSource(config))}`;
    const response = await call('GET', path);
    expect(response.status).toBe(200);
    const yaml = await response.text();
    expect(yaml).toContain('name: renamed1');
    expect(yaml).toContain('name: Auto');
    expect(yaml).toContain('"DOMAIN-SUFFIX,example.com,PROXY"');
    expect(yaml).toContain('"DOMAIN,foo.org,PROXY"');
    expect(yaml).toContain('"MATCH,PROXY"');
  });

  it('generates rule-providers in providers mode and warns about an unpinned origin', async () => {
    const ruleSource = inlineSource('DOMAIN-SUFFIX,example.com\nDOMAIN,foo.org');
    const path =
      `/sub?url=${encodeURIComponent(inlineSource(SS_URI))}` +
      `&ruleset=${encodeURIComponent(`PROXY,${ruleSource}`)}` +
      '&rules_mode=providers';
    // PUBLIC_SUBSCRIPTION_CACHE=true must not win when PUBLIC_ORIGIN is empty.
    const response = await call('GET', path, { ...baseEnv, PUBLIC_SUBSCRIPTION_CACHE: 'true' });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('x-subconverter-warn-codes')).toContain('W_PROVIDER_ORIGIN_UNPINNED');
    const yaml = await response.text();
    expect(yaml).toContain('rule-providers:');
    expect(yaml).toContain('type: http');
    expect(yaml).toContain('behavior: domain');
    expect(yaml).toContain('/getruleset?type=3&src=');
    expect(yaml).toContain('"RULE-SET,');
  });

  it('uses PUBLIC_ORIGIN for provider URLs and public caching', async () => {
    const env = {
      ...baseEnv,
      PUBLIC_SUBSCRIPTION_CACHE: 'true',
      PUBLIC_ORIGIN: 'https://cdn.example.com',
    };
    const ruleSource = inlineSource('DOMAIN-SUFFIX,example.com');
    const path =
      `/sub?url=${encodeURIComponent(inlineSource(SS_URI))}` +
      `&ruleset=${encodeURIComponent(`PROXY,${ruleSource}`)}` +
      '&rules_mode=providers';
    const response = await call('GET', path, env);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('public, max-age=60');
    const yaml = await response.text();
    expect(yaml).toContain('https://cdn.example.com/getruleset?');

    // Two request hostnames must produce the same canonical provider origin.
    const hostA = await callAt('https://a.example.com', 'GET', path, env);
    const hostB = await callAt('https://b.example.com', 'GET', path, env);
    expect(await hostA.text()).toContain('https://cdn.example.com/getruleset?');
    expect(await hostB.text()).toContain('https://cdn.example.com/getruleset?');
  });

  it('/clash ignores a non-clash target; /sub rejects it', async () => {
    const query = `?url=${encodeURIComponent(inlineSource(SS_URI))}&target=surge`;
    const clash = await call('GET', `/clash${query}`);
    expect(clash.status).toBe(200);
    expect(clash.headers.get('x-subconverter-warn-codes')).toContain('W_PARAM_IGNORED');

    const sub = await call('GET', `/sub${query}`);
    expect(sub.status).toBe(400);
    expect(sub.headers.get('x-subconverter-error')).toBe('unsupported_target');
  });

  it('maps request errors to the documented codes', async () => {
    const missing = await call('GET', '/sub');
    expect(missing.status).toBe(400);
    expect(missing.headers.get('x-subconverter-error')).toBe('invalid_request');

    const target = await call('GET', `${subQuery(SS_URI)}&udp=maybe`);
    expect(target.status).toBe(400);
    expect(target.headers.get('x-subconverter-error')).toBe('invalid_boolean');

    const regex = await call('GET', `${subQuery(SS_URI)}&include=${encodeURIComponent('(a+)+$')}`);
    expect(regex.status).toBe(400);
    expect(regex.headers.get('x-subconverter-error')).toBe('invalid_regex');

    const ssrf = await call('GET', `/sub?url=${encodeURIComponent('http://127.0.0.1/')}`);
    expect(ssrf.status).toBe(400);
    expect(ssrf.headers.get('x-subconverter-error')).toBe('blocked_upstream');

    const noNodes = await call('GET', subQuery('not a subscription'));
    expect(noNodes.status).toBe(422);
    expect(noNodes.headers.get('x-subconverter-error')).toBe('no_nodes');
  });

  it('returns the diagnostics error envelope', async () => {
    const response = await call('GET', '/sub?diagnostics=json&target=surge');
    expect(response.status).toBe(400);
    const body = (await response.json()) as { ok: boolean; error: { code: string }; warnings: unknown[] };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('unsupported_target');
    expect(Array.isArray(body.warnings)).toBe(true);
  });

  it('adds profile-update-interval and Content-Disposition when requested', async () => {
    const path = `${subQuery(SS_URI)}&interval=7200&filename=my-sub.yaml`;
    const response = await call('GET', path);
    expect(response.status).toBe(200);
    expect(response.headers.get('profile-update-interval')).toBe('2');
    expect(response.headers.get('content-disposition')).toContain('my-sub.yaml');
  });

  it('accepts a base64 subscription containing all five protocols', async () => {
    const uris = [
      'ss://YWVzLTI1Ni1nY206c3MtcGFzcw@1.2.3.4:8388#SS%20Node',
      'ssr://c3NyLmV4YW1wbGUuY29tOjgzODg6YXV0aF9jaGFpbl9hOmFlcy0yNTYtY2ZiOmh0dHBfc2ltcGxlOmMzTnlMWEJoYzNNLz9yZW1hcmtzPVUxTlNJRTV2WkdVJm9iZnNwYXJhbT1kM2QzTG1WNFlXMXdiR1V1WTI5dCZwcm90b3BhcmFtPU16SQ',
      'vmess://eyJ2IjoiMiIsInBzIjoiVk1lc3MgV1MiLCJhZGQiOiJ2bS5leGFtcGxlLmNvbSIsInBvcnQiOiI0NDMiLCJpZCI6IjExMTExMTExLTIyMjItMzMzMy00NDQ0LTU1NTU1NTU1NTU1NSIsImFpZCI6IjAiLCJuZXQiOiJ3cyIsInR5cGUiOiJub25lIiwiaG9zdCI6ImNkbi5leGFtcGxlLmNvbSIsInBhdGgiOiIvd3MiLCJ0bHMiOiJ0bHMiLCJzbmkiOiJ2bS5leGFtcGxlLmNvbSJ9',
      'trojan://tr0jan%40pass@tj.example.com:443?security=tls&sni=tj.example.com&type=ws&path=%2Fws&host=cdn.example.com&allowInsecure=1#Trojan%20WS',
      'vless://aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee@vl.example.com:443?encryption=none&security=reality&sni=www.microsoft.com&fp=chrome&pbk=PUBKEY&sid=abcd&type=tcp&flow=xtls-rprx-vision#VLESS%20Reality',
    ].join('\n');
    const path = `/sub?url=${encodeURIComponent(`inline:${encodeBase64Url(uris)}`)}`;
    const response = await call('GET', path);
    expect(response.status).toBe(200);
    expect(response.headers.get('x-subconverter-node-count')).toBe('5');
    const yaml = await response.text();
    for (const type of ['ss', 'ssr', 'vmess', 'trojan', 'vless']) {
      expect(yaml).toContain(`type: ${type}`);
    }
  });

  it('is deterministic for the same input', async () => {
    const path = subQuery(SS_URI) + '&sort=true&udp=true';
    const first = await call('GET', path);
    const second = await call('GET', path);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await first.text()).toBe(await second.text());
  });

  it('sanitizes template keys, drops template rules by default and keeps allowed keys', async () => {
    const template = [
      'mixed-port: 1234',
      'dns:',
      '  enable: true',
      'script:',
      '  code: alert(1)',
      'proxies:',
      '  - name: evil',
      '    type: ss',
      'rules:',
      '  - DOMAIN,ignored.example,PROXY',
    ].join('\n');
    const path =
      `${subQuery(SS_URI)}` +
      `&template=${encodeURIComponent(inlineSource(template))}`;
    const response = await call('GET', path);
    expect(response.status).toBe(200);
    const yaml = await response.text();
    expect(yaml).toContain('mixed-port: 1234');
    expect(yaml).not.toContain('alert(1)');
    expect(yaml).not.toContain('ignored.example');
    expect(response.headers.get('x-subconverter-warn-codes')).toContain('W_TEMPLATE_KEY_DENIED');
    expect(response.headers.get('x-subconverter-warn-codes')).toContain('W_TEMPLATE_CORE_IGNORED');
  });

  it('appends validated template rules when overwrite_original_rules=false', async () => {
    const template = [
      'mixed-port: 1234',
      'rules:',
      '  - DOMAIN-SUFFIX,template.example,PROXY',
    ].join('\n');
    const config = [
      '[custom]',
      'custom_proxy_group=PROXY`select`.*',
      'overwrite_original_rules=false',
    ].join('\n');
    const path =
      `${subQuery(SS_URI)}` +
      `&config=${encodeURIComponent(inlineSource(config))}` +
      `&template=${encodeURIComponent(inlineSource(template))}`;
    const response = await call('GET', path);
    expect(response.status).toBe(200);
    const yaml = await response.text();
    expect(yaml).toContain('"DOMAIN-SUFFIX,template.example,PROXY"');
    expect(yaml).toContain('"MATCH,PROXY"');
  });

  it('maps a built-in clash_rule_base path and rejects other local paths', async () => {
    const builtin = ['[custom]', 'clash_rule_base=base/all_base.tpl'].join('\n');
    const ok = await call(
      'GET',
      `${subQuery(SS_URI)}&config=${encodeURIComponent(inlineSource(builtin))}`,
    );
    expect(ok.status).toBe(200);
    expect(ok.headers.get('x-subconverter-warn-codes')).toContain('W_BUILTIN_TEMPLATE_MAPPED');

    const local = ['[custom]', 'clash_rule_base=./local/base.yaml'].join('\n');
    const bad = await call(
      'GET',
      `${subQuery(SS_URI)}&config=${encodeURIComponent(inlineSource(local))}`,
    );
    expect(bad.status).toBe(400);
    expect(bad.headers.get('x-subconverter-error')).toBe('invalid_template');
  });

  it('auto-creates missing ruleset wrapper groups', async () => {
    const source = inlineSource('DOMAIN-SUFFIX,auto.example');
    const path =
      `${subQuery(SS_URI)}` +
      `&ruleset=${encodeURIComponent(`AUTO2,${source}`)}`;
    const response = await call('GET', path);
    expect(response.status).toBe(200);
    expect(response.headers.get('x-subconverter-warn-codes')).toContain('W_GROUP_AUTO_CREATED');
    const yaml = await response.text();
    expect(yaml).toContain('name: AUTO2');
    expect(yaml).toContain('"DOMAIN-SUFFIX,auto.example,AUTO2"');
  });

  it('accepts clash-classic as a dialect alias and skips quanx with a warning', async () => {
    const classical = inlineSource('payload:\n  - DOMAIN-SUFFIX,classic.example\n');
    const alias = await call(
      'GET',
      `${subQuery(SS_URI)}&ruleset=${encodeURIComponent(`PROXY,clash-classic:${classical}`)}`,
    );
    expect(alias.status).toBe(200);
    expect(alias.headers.get('x-subconverter-warn-codes')).toContain('W_DIALECT_ALIAS');
    expect(await alias.text()).toContain('"DOMAIN-SUFFIX,classic.example,PROXY"');

    const quanx = await call(
      'GET',
      `${subQuery(SS_URI)}&ruleset=${encodeURIComponent('PROXY,quanx:https://example.com/x')}`,
    );
    expect(quanx.status).toBe(200);
    expect(quanx.headers.get('x-subconverter-warn-codes')).toContain('W_DIALECT_UNSUPPORTED');
  });

  it('rejects unsafe rename patterns', async () => {
    const response = await call(
      'GET',
      `${subQuery(SS_URI)}&rename=${encodeURIComponent('(a+)+$@x')}`,
    );
    expect(response.status).toBe(400);
    expect(response.headers.get('x-subconverter-error')).toBe('invalid_regex');
  });

  it('skips !!import: rulesets with a warning', async () => {
    const response = await call(
      'GET',
      `${subQuery(SS_URI)}&ruleset=${encodeURIComponent('PROXY,!!import:other')}`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('x-subconverter-warn-codes')).toContain(
      'W_RULESET_IMPORT_UNSUPPORTED',
    );
  });
});

describe('routes: /getruleset', () => {
  it('maps a domain payload to bare domains and +.suffix entries', async () => {
    const source = inlineSource('payload:\n  - example.com\n  - +.example.org\n');
    const response = await call('GET', `/getruleset?type=3&src=${encodeURIComponent(source)}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/yaml; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('public, max-age=300, stale-while-revalidate=600');
    const yaml = await response.text();
    expect(yaml).toContain('payload:');
    expect(yaml).toContain('- "example.com"');
    expect(yaml).toContain('- "+.example.org"');
    expect(yaml).not.toContain('DOMAIN-SUFFIX,');
  });

  it('emits the documented placeholder and header for an empty filtered result', async () => {
    const domainSource = inlineSource('IP-CIDR,1.2.3.0/24\n');
    const domain = await call(
      'GET',
      `/getruleset?type=3&src=${encodeURIComponent(domainSource)}`,
    );
    expect(domain.status).toBe(200);
    expect(domain.headers.get('x-subconverter-placeholder')).toBe('1');
    expect(await domain.text()).toContain('"+.placeholder.invalid"');

    const domainRules = inlineSource('DOMAIN,example.com\n');
    const ip = await call('GET', `/getruleset?type=4&src=${encodeURIComponent(domainRules)}`);
    expect(ip.status).toBe(200);
    expect(ip.headers.get('x-subconverter-placeholder')).toBe('1');
    expect(await ip.text()).toContain('"0.0.0.0/32"');

    const catchAll = inlineSource('MATCH,DIRECT\n');
    const classical = await call(
      'GET',
      `/getruleset?type=6&src=${encodeURIComponent(catchAll)}`,
    );
    expect(classical.status).toBe(200);
    expect(classical.headers.get('x-subconverter-placeholder')).toBe('1');
    expect(await classical.text()).toContain('"DOMAIN,placeholder.invalid"');
  });

  it('returns diagnostics JSON', async () => {
    const source = inlineSource('payload:\n  - example.com\n');
    const response = await call(
      'GET',
      `/getruleset?type=3&src=${encodeURIComponent(source)}&diagnostics=json`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      type: number;
      output: string;
      stats: { accepted: number };
    };
    expect(body.ok).toBe(true);
    expect(body.type).toBe(3);
    expect(body.output).toContain('example.com');
    expect(body.stats.accepted).toBe(1);
  });

  it('rejects unsupported types, conflicting sources and private upstreams', async () => {
    const badType = await call('GET', '/getruleset?type=1&src=inline:AAAA');
    expect(badType.status).toBe(400);
    expect(badType.headers.get('x-subconverter-error')).toBe('unsupported_ruleset_type');

    const conflict = await call('GET', '/getruleset?type=3&src=x&url=y');
    expect(conflict.status).toBe(400);
    expect(conflict.headers.get('x-subconverter-error')).toBe('conflicting_params');

    const ssrf = await call(
      'GET',
      `/getruleset?type=3&src=${encodeURIComponent('https://127.0.0.1/x')}`,
    );
    expect(ssrf.status).toBe(400);
    expect(ssrf.headers.get('x-subconverter-error')).toBe('blocked_upstream');
  });

  it('accepts a base64url-encoded source in url=', async () => {
    const source = inlineSource('DOMAIN,example.com\n');
    const response = await call(
      'GET',
      `/getruleset?type=6&url=${encodeURIComponent(source)}`,
    );
    // `url` is base64url(source), not the source itself; encode it once.
    expect(response.status).toBe(400);
    const ok = await call(
      'GET',
      `/getruleset?type=6&url=${encodeURIComponent(encodeBase64Url(source))}`,
    );
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain('"DOMAIN,example.com"');
  });
});
