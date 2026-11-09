/**
 * Built-in default template (SPEC §12.2).
 *
 * Kept as a TypeScript constant instead of an external YAML file so the Worker
 * needs no extra wrangler `rules` entry and performs no startup YAML parsing.
 * The object is deeply frozen; `sanitizeTemplate` always returns a fresh copy.
 */

export const BUILTIN_TEMPLATE_PATHS: readonly string[] = [
  'base/all_base.tpl',
  'base/all_base.yml',
  'base/all_base.conf',
];

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

export const DEFAULT_TEMPLATE: Record<string, unknown> = deepFreeze({
  'mixed-port': 7890,
  'allow-lan': false,
  mode: 'rule',
  'log-level': 'info',
  ipv6: true,
  dns: {
    enable: true,
    ipv6: true,
    'enhanced-mode': 'fake-ip',
    'fake-ip-range': '198.18.0.1/16',
    nameserver: ['https://1.1.1.1/dns-query', 'https://8.8.8.8/dns-query'],
  },
});

/** Normalize a `clash_rule_base` value for built-in-path comparison. */
function normalizeBuiltinPath(path: string): string {
  return path.trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Map the ACL4SSR local `clash_rule_base` paths that tindy ships to the
 * built-in template (SPEC §7.1 / AC-30). Any other bare path is rejected by
 * integration with `invalid_template`.
 */
export function isBuiltinTemplatePath(path: string): boolean {
  return BUILTIN_TEMPLATE_PATHS.includes(normalizeBuiltinPath(path));
}
