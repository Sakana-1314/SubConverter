/**
 * Public emitter API (ARCHITECTURE §7.3.9).
 *
 * `emitClash` is a pure function: template sanitization + node/group/provider
 * mapping + rules assembly + YAML read-back. It performs no I/O and needs no
 * Worker APIs.
 */

import type { EmitResult } from '../types';
import { assembleConfig, type AssembleDeps, type AssembleResult, type EmitClashInput } from './config';

export type {
  AssembleDeps,
  AssembleResult,
  EmitClashInput,
  EmitClashOptions,
  IniParseFailure,
  IniParseResult,
  IniParseSuccess,
  RuleValidator,
  RuleValidatorContext,
  RuleValidatorResult,
} from './config';

export {
  assembleConfig,
  parseAcl4ssrIni,
  parseCustomProxyGroupLine,
  parseCustomProxyGroups,
  parseGroupTimes,
} from './config';

export {
  EmitterError,
  isEmitterError,
  isPlainObject,
  isUnsafeMapKey,
  parseForReadback,
  stringifyConfig,
  utf8ByteLength,
  type EmitterErrorCode,
  type ParseForReadbackResult,
  type StringifyOptions,
} from './serialize';

export {
  ALLOWED_TEMPLATE_KEYS,
  DENIED_TEMPLATE_KEYS,
  isAllowedTemplateKey,
  sanitizeTemplate,
  type SanitizeTemplateOptions,
  type TemplateResult,
} from './template';

export { DEFAULT_TEMPLATE, BUILTIN_TEMPLATE_PATHS, isBuiltinTemplatePath } from './default-template';

export {
  buildGroup,
  compileMatcherRegex,
  defaultGroups,
  expandGroupSpec,
  groupMemberNames,
  isUnsafeRegexSource,
  limitGroups,
  parsePortRange,
  sanitizeGroupReferences,
  toMihomoGroup,
  toMihomoGroups,
  type GroupBuildOptions,
  type GroupMemberCandidate,
  type GroupReferenceContext,
  type PortRange,
  type RegexResult,
} from './groups';

export {
  toMihomoProxy,
  toMihomoProxies,
  type NodeEmitOptions,
} from './nodes';

export {
  assertRuleLine,
  checkRuleLine,
  ensureTrailingMatch,
  formatRule,
  isValidCidrValue,
  toRuleScalars,
  type RuleLineCheck,
} from './rules';

export {
  buildProviderUrl,
  providerPath,
  providerTypeFor,
  toRuleProviders,
} from './providers';

/**
 * Convert the intermediate model into a complete mihomo YAML document.
 * Throws `EmitterError` (`E_EMIT_INVALID` / `E_OUTPUT_TOO_LARGE`) when the
 * generated document fails read-back or invariants.
 */
export function emitClash(input: EmitClashInput, deps: AssembleDeps = {}): EmitResult {
  const result: AssembleResult = assembleConfig(input, deps);
  return {
    yaml: result.yaml,
    stats: result.stats,
    warnings: result.warnings,
  };
}
