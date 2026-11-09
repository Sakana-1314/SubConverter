/**
 * Conversion pipeline for `/sub` and `/clash` (ARCHITECTURE §7.4.5).
 *
 * Order: config -> source loading/parsing -> filters/renames -> group specs and
 * name allocation -> rule build -> template -> emit. Every stage feeds the same
 * `WarningCollector`; a stage failure either becomes a warning (one source) or
 * an `AppError` (fatal request error).
 */

import {
  DEFAULT_TEMPLATE,
  emitClash,
  isBuiltinTemplatePath,
  sanitizeTemplate,
} from '../emitter/index';
import { allocateNames } from '../links/name-allocator';
import {
  applyFilters,
  applyRenames,
  applySourceGroup,
  sortNodes,
} from '../links/node-ops';
import { parseSubscriptionText } from '../links/subscription';
import { makeWarning } from '../links/text';
import { parseYamlSingle } from '../links/yaml';
import {
  buildRules,
  checkTemplateTail,
  defaultGroups,
  detectDialect,
  expandGroups,
  normalizeDialectName,
  parseAcL4ssrIni,
  parseGroupsParam,
  parseRuleLine,
  type RuleSource,
} from '../rules/index';
import type {
  Acl4ssrConfig,
  ConversionStats,
  EmitResult,
  GroupSpec,
  ProxyGroup,
  ProxyNode,
  RuleProviderSpec,
  Warning,
} from '../types';
import { BUILTIN_TARGETS, VERSION } from '../types';
import type { SubParams, RuleSourceParam } from '../http/params';
import { AppError, toAppError } from './errors';
import type { EnvPolicy } from './env';
import { SourceLoadError, SourceLoader, type FetchServiceDeps } from './fetch';
import { WarningCollector } from './warnings';

export interface PipelineDeps extends FetchServiceDeps {}

export interface SubResult {
  yaml: string;
  warnings: Warning[];
  warningCount: number;
  warningCodes: string[];
  stats: ConversionStats;
  userInfo?: string;
}

const MAX_TEMPLATE_BYTES = 256 * 1024;

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    Array.from({ length: workers }, async () => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= items.length) return;
        results[index] = await fn(items[index] as T, index);
      }
    }),
  );
  return results;
}

async function loadFatal(
  loader: SourceLoader,
  spec: NonNullable<SubParams['config']>,
  kind: 'config' | 'template',
): Promise<{ text: string; bytes: number }> {
  try {
    return await loader.load(spec, kind);
  } catch (error) {
    if (error instanceof SourceLoadError) throw error.appError;
    throw error;
  }
}

function pickDefaultGroup(groups: readonly ProxyGroup[]): string {
  const proxy = groups.find((group) => group.name === 'PROXY');
  if (proxy !== undefined) return proxy.name;
  const select = groups.find((group) => group.type === 'select');
  if (select !== undefined) return select.name;
  const first = groups[0];
  return first === undefined ? 'DIRECT' : first.name;
}

function providerUrlLength(source: RuleSource, origin: string): number {
  const raw = source.rawSource ?? source.raw ?? source.sourceId;
  return `${origin}/getruleset?type=3&src=${encodeURIComponent(raw)}&dialect=${encodeURIComponent(source.dialect)}&v=1`.length;
}

function addSourceWarning(collector: WarningCollector, error: SourceLoadError, sourceId: string): void {
  collector.add(
    makeWarning(error.warningCode, error.message, {
      source: sourceId,
      severity: 'error',
      stage: 'fetch',
    }),
  );
}

function parseConfigRulesetParams(
  config: Acl4ssrConfig,
  parse: (raw: string, sourceId: string) => RuleSourceParam,
  collector: WarningCollector,
): RuleSourceParam[] {
  if (config.enableRuleGenerator === false) return [];
  const parsed: RuleSourceParam[] = [];
  for (let index = 0; index < config.rulesets.length; index += 1) {
    const line = config.rulesets[index] as string;
    try {
      parsed.push(parse(line, `config#${index + 1}`));
    } catch (error) {
      if (error instanceof AppError) {
        collector.add(
          makeWarning('W_CONFIG_KEY_UNSUPPORTED', `config ruleset line was ignored: ${error.message}`, {
            source: 'config',
            line: 0,
            severity: 'warning',
            stage: 'template',
          }),
        );
      } else {
        throw error;
      }
    }
  }
  return parsed;
}

async function buildRuleSources(
  params: readonly RuleSourceParam[],
  loader: SourceLoader,
  collector: WarningCollector,
  maxEntries: number,
): Promise<RuleSource[]> {
  const loaded = await mapLimit(params, 4, async (param): Promise<RuleSource | null> => {
    if (param.importUnsupported === true) {
      collector.add(
        makeWarning('W_RULESET_IMPORT_UNSUPPORTED', '!!import: ruleset sources are not supported; source skipped', {
          source: param.sourceId,
          severity: 'warning',
          stage: 'rules',
        }),
      );
      return null;
    }

    if (param.dialect === 'quanx') {
      collector.add(
        makeWarning('W_DIALECT_UNSUPPORTED', 'dialect quanx is not supported; source skipped', {
          source: param.sourceId,
          severity: 'warning',
          stage: 'rules',
        }),
      );
      return null;
    }

    if (param.inlineRule !== undefined) {
      return {
        sourceId: param.sourceId,
        text: param.inlineRule,
        dialect: 'surge',
        group: param.group,
        rawSource: '',
      };
    }

    let text: string;
    try {
      const source = { raw: param.raw, label: param.sourceId, sourceId: param.sourceId };
      const result = await loader.load(source, 'ruleset');
      text = result.text;
    } catch (error) {
      if (error instanceof SourceLoadError) {
        addSourceWarning(collector, error, param.sourceId);
        return null;
      }
      throw error;
    }

    let explicit: string | undefined;
    if (param.dialect !== undefined) {
      const normalized = normalizeDialectName(param.dialect);
      if (normalized.error !== undefined) {
        collector.add({ ...normalized.error, source: param.sourceId });
        return null;
      }
      collector.addAll(normalized.warnings);
      if (normalized.dialect !== 'auto') explicit = normalized.dialect;
    }

    const detected = detectDialect(text, explicit, undefined, { maxEntries });
    if ('error' in detected) {
      collector.add({ ...detected.error, source: param.sourceId });
      return null;
    }
    collector.addAll(
      detected.warnings.map((warning) =>
        warning.source === undefined ? { ...warning, source: param.sourceId } : warning,
      ),
    );

    return {
      sourceId: param.sourceId,
      text,
      dialect: detected.dialect,
      group: param.group,
      ...(param.interval === undefined ? {} : { interval: param.interval }),
      rawSource: param.raw,
    };
  });

  return loaded.filter((item): item is RuleSource => item !== null);
}

function templateFromConfig(config: Acl4ssrConfig | undefined): string | undefined {
  if (config?.clashRuleBase === undefined) return undefined;
  return config.clashRuleBase;
}

/**
 * Run one `/sub` or `/clash` request.
 *
 * Throws `AppError` for fatal request errors. Per-source failures are warnings.
 */
export async function runSub(
  params: SubParams,
  policy: EnvPolicy,
  deps: PipelineDeps,
  requestOrigin: string,
  parameterWarnings: readonly Warning[] = [],
  parseRuleSource: (raw: string, sourceId: string) => RuleSourceParam,
): Promise<SubResult> {
  const collector = new WarningCollector();
  collector.addAll(parameterWarnings);
  const loader = new SourceLoader(policy, deps);

  // -------------------------------------------------------------------------
  // 1. Config
  // -------------------------------------------------------------------------
  let config: Acl4ssrConfig | undefined;
  if (params.config !== undefined) {
    const loaded = await loadFatal(loader, params.config, 'config');
    const parsed = parseAcL4ssrIni(loaded.text);
    if (!parsed.ok) throw new AppError('invalid_config', parsed.message);
    config = parsed.config;
    collector.addAll(parsed.warnings);
  }

  // -------------------------------------------------------------------------
  // 2. Node sources (limit 4 concurrent; partial failures are warnings)
  // -------------------------------------------------------------------------
  let firstSourceError: AppError | undefined;
  const loadedNodes = await mapLimit(params.urls, 4, async (spec) => {
    try {
      const loaded = await loader.load(spec, 'subscription');
      return { spec, loaded };
    } catch (error) {
      if (error instanceof SourceLoadError) {
        addSourceWarning(collector, error, spec.sourceId);
        if (firstSourceError === undefined) firstSourceError = error.appError;
        return null;
      }
      throw error;
    }
  });

  const nodes: ProxyNode[] = [];
  let successfulSources = 0;
  let userInfo: string | undefined;
  // Cap how many nodes may be materialized before filter/sort/truncate. A full
  // 128 MB isolate cannot safely hold 20k YAML proxy objects (review finding
  // #2), so the parse safety ceiling is 10k regardless of a larger MAX_NODES.
  let remainingNodeBudget = Math.min(Math.max(0, policy.maxNodes * 2), 10_000);
  for (const item of loadedNodes) {
    if (item === null) continue;
    successfulSources += 1;
    const parsed = parseSubscriptionText(item.loaded.text, item.spec.sourceId, {
      maxNodes: remainingNodeBudget,
    });
    remainingNodeBudget = Math.max(0, remainingNodeBudget - parsed.nodes.length);
    collector.addAll(parsed.warnings);
    if (parsed.nodes.length > 0) {
      applySourceGroup(parsed.nodes, item.spec.sourceGroup);
      nodes.push(...parsed.nodes);
    }
    if (item.loaded.userInfo !== undefined && userInfo === undefined) {
      userInfo = item.loaded.userInfo;
    }
    if (item.loaded.userInfoInvalid === true) {
      collector.add(
        makeWarning('W_USERINFO_INVALID', 'upstream Subscription-UserInfo was invalid and ignored', {
          source: item.spec.sourceId,
          severity: 'warning',
          stage: 'fetch',
        }),
      );
    }
  }

  if (successfulSources === 0) {
    if (firstSourceError !== undefined) throw firstSourceError;
    throw new AppError('upstream_network', 'all subscription sources failed');
  }
  if (nodes.length === 0) {
    throw new AppError('no_nodes', 'no valid proxy nodes were produced');
  }

  // -------------------------------------------------------------------------
  // 3. Filters / renames / source group
  // -------------------------------------------------------------------------
  const configRename = (config?.rename ?? []).map((entry) => {
    const at = entry.indexOf('@');
    return { pattern: entry.slice(0, at), replacement: entry.slice(at + 1) };
  });
  const renames = params.rename.length > 0 ? params.rename : configRename;
  const include = params.include.length > 0 ? params.include : (config?.includeRemarks ?? []);
  const exclude = params.exclude.length > 0 ? params.exclude : (config?.excludeRemarks ?? []);

  let filtered: ProxyNode[];
  try {
    filtered = applyFilters(nodes, include, exclude, []);
    filtered = applyRenames(filtered, renames, []);
  } catch (error) {
    throw toAppError(error);
  }
  applySourceGroup(filtered, params.group);

  // -------------------------------------------------------------------------
  // 4. Group specs and names
  // -------------------------------------------------------------------------
  const groupWarningSink: Warning[] = [];
  let groupSpecs: GroupSpec[] = [];
  if (config !== undefined) {
    groupSpecs = parseGroupsParam(config.customProxyGroups.join('\n'), groupWarningSink, {
      source: 'config',
    });
  } else if (params.groupsText !== undefined && params.groupsText.trim() !== '') {
    groupSpecs = parseGroupsParam(params.groupsText, groupWarningSink, { source: 'groups' });
  }
  collector.addAll(groupWarningSink);

  const useDefaultGroups = config === undefined && groupSpecs.length === 0;
  const plannedGroupNames = useDefaultGroups
    ? ['PROXY', 'AUTO']
    : groupSpecs.map((spec) => spec.name);

  const nodeWarnings: Warning[] = [];
  allocateNames(filtered, new Set([...plannedGroupNames, ...BUILTIN_TARGETS]), nodeWarnings);
  collector.addAll(nodeWarnings);

  if (params.sort) filtered = sortNodes(filtered);
  if (filtered.length > policy.maxNodes) {
    collector.add(
      makeWarning('W_NODE_LIMIT', `only the first ${policy.maxNodes} nodes are kept`, {
        severity: 'warning',
        stage: 'nodes',
      }),
    );
    filtered = filtered.slice(0, policy.maxNodes);
  }
  if (filtered.length === 0) {
    throw new AppError('no_nodes', 'all nodes were removed by filters');
  }

  const groupWarnings: Warning[] = [];
  let groups: ProxyGroup[] = useDefaultGroups
    ? defaultGroups(filtered, groupWarnings)
    : expandGroups(groupSpecs, filtered, groupWarnings, { maxGroups: policy.maxGroups });
  collector.addAll(groupWarnings);

  // -------------------------------------------------------------------------
  // 5. Template (needed before rules: template rules may be appended)
  // -------------------------------------------------------------------------
  const overwriteOriginalRules = config?.overwriteOriginalRules ?? true;
  let template: Record<string, unknown> = DEFAULT_TEMPLATE;
  let templateRules: string[] = [];
  let templateRaw: string | undefined;
  const queryTemplate = params.template;
  const configTemplate = templateFromConfig(config);

  if (queryTemplate !== undefined) {
    if (!/^(?:inline:|data:text\/plain;base64,|https?:\/\/)/i.test(queryTemplate.raw)) {
      throw new AppError(
        'invalid_template',
        'template must be an inline:, data: or http(s) source; local paths are not supported',
      );
    }
    const loaded = await loadFatal(loader, queryTemplate, 'template');
    templateRaw = loaded.text;
  } else if (configTemplate !== undefined) {
    if (isBuiltinTemplatePath(configTemplate)) {
      collector.add(
        makeWarning(
          'W_BUILTIN_TEMPLATE_MAPPED',
          `clash_rule_base "${configTemplate}" maps to the built-in template`,
          { severity: 'info', stage: 'template', source: 'config' },
        ),
      );
    } else if (/^(?:inline:|data:text\/plain;base64,|https?:\/\/)/i.test(configTemplate)) {
      const loaded = await loadFatal(
        loader,
        { raw: configTemplate, label: 'template', sourceId: 'template' },
        'template',
      );
      templateRaw = loaded.text;
    } else {
      throw new AppError(
        'invalid_template',
        'clash_rule_base local paths are not supported; use inline:/URL or a built-in template name',
      );
    }
  }

  if (templateRaw !== undefined) {
    collector.addAll(checkTemplateTail(templateRaw, 'template'));
    const parsed = parseYamlSingle(templateRaw, MAX_TEMPLATE_BYTES);
    if (!parsed.ok) {
      throw new AppError('invalid_template', parsed.message);
    }
    try {
      const sanitized = sanitizeTemplate(parsed.value, {
        overwriteOriginalRules,
        sourceId: 'template',
      });
      template = sanitized.template;
      templateRules = sanitized.templateRules;
      collector.addAll(sanitized.warnings);
    } catch (error) {
      throw toAppError(error);
    }
  }

  // -------------------------------------------------------------------------
  // 6. Rules / providers
  // -------------------------------------------------------------------------
  const configRulesetParams = config === undefined
    ? []
    : parseConfigRulesetParams(config, parseRuleSource, collector);
  const ruleSourceParams = [...configRulesetParams, ...params.rulesets];
  const ruleSources = await buildRuleSources(ruleSourceParams, loader, collector, policy.maxRules);

  const providerOrigin = policy.publicOrigin !== '' ? policy.publicOrigin : requestOrigin;
  if (params.rulesMode === 'providers' && policy.publicOrigin === '') {
    collector.add(
      makeWarning(
        'W_PROVIDER_ORIGIN_UNPINNED',
        'PUBLIC_ORIGIN is empty; provider URLs use the request origin and the response must not be publicly cached',
        { severity: 'warning', stage: 'rules' },
      ),
    );
  }

  const knownTargets = new Set<string>();
  for (const node of filtered) knownTargets.add(node.name);
  for (const group of groups) knownTargets.add(group.name);
  for (const builtin of BUILTIN_TARGETS) knownTargets.add(builtin);

  const ruleResult = buildRules({
    sources: ruleSources,
    ...(templateRules.length > 0 && overwriteOriginalRules === false ? { templateRules } : {}),
    overwriteOriginalRules,
    mode: params.rulesMode,
    knownTargets,
    defaultGroup: pickDefaultGroup(groups),
    maxRules: policy.maxRules,
    maxNewGroups: Math.max(0, policy.maxGroups - groups.length),
    providerUrlLength: (source) => providerUrlLength(source, providerOrigin),
    sourceId: 'rules',
  });
  collector.addAll(ruleResult.warnings);

  if (ruleResult.extraGroups.length > 0) {
    const autoGroups: ProxyGroup[] = ruleResult.extraGroups.map((name) => ({
      name,
      type: 'select',
      members: [...filtered.map((node) => node.name), 'DIRECT'],
    }));
    groups = [...groups, ...autoGroups];
  }

  // -------------------------------------------------------------------------
  // 7. Emit
  // -------------------------------------------------------------------------
  let emitResult: EmitResult;
  try {
    emitResult = emitClash(
      {
        template,
        nodes: filtered,
        groups,
        rules: ruleResult.rules,
        providers: ruleResult.providers as RuleProviderSpec[],
        origin: providerOrigin,
        version: VERSION,
        options: {
          rulesMode: params.rulesMode,
          defaultGroup: pickDefaultGroup(groups),
          udp: params.udp,
          tfo: params.tfo,
          scv: params.scv,
        },
      },
      {
        validateRuleLine: (line, ctx) => {
          const parsedLine = parseRuleLine(line, {
            sourceId: ctx.sourceId,
            mode: 'template',
            knownTargets: ctx.knownTargets,
            knownProviders: ctx.knownProviders,
            allowMatch: ctx.allowMatch,
          });
          if (parsedLine.ok) return { ok: true };
          return {
            ok: false,
            warnings: parsedLine.warnings.map((warning) => ({
              code: warning.code,
              message: warning.message,
            })),
          };
        },
      },
    );
  } catch (error) {
    throw toAppError(error);
  }
  collector.addAll(emitResult.warnings);

  const stats: ConversionStats = {
    ...emitResult.stats,
    sources: params.urls.length,
    bytesIn: loader.bytesIn,
    warnings: collector.count,
    warningCodes: collector.codes(),
  };

  const result: SubResult = {
    yaml: emitResult.yaml,
    warnings: collector.toJSON(),
    warningCount: collector.count,
    warningCodes: collector.codes(),
    stats,
  };
  if (userInfo !== undefined) result.userInfo = userInfo;
  return result;
}
