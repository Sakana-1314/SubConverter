/**
 * Public API of the `rules` module.
 *
 * Consumers (integration / emitter) should use these exports only; internal
 * files may change without notice. There is no module-level mutable state and
 * no cache, so repeated calls with the same input are deterministic and safe
 * for concurrent requests (ARCHITECTURE §7.2.12).
 */

export * from './types';
export * from './registry';
export * from './payload';
export * from './split';
export * from './parse';
export * from './dialects';
export * from './truncation';
export * from './providers';
export * from './groups';
export * from './ini';
export * from './validate';
