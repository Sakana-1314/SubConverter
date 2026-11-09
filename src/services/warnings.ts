/**
 * Warning collection and response-header formatting (SPEC §2.3, §2.8, §10.1).
 */

import type { Warning } from '../types';
import { MAX_WARNINGS } from '../types';

const MAX_WARN_CODES = 20;

export class WarningCollector {
  private readonly items: Warning[] = [];
  private readonly seen = new Set<string>();
  private total = 0;
  private limitWarningAdded = false;

  add(warning: Warning): void {
    this.total += 1;
    const key = [
      warning.code,
      warning.source ?? '',
      warning.line === undefined ? '' : String(warning.line),
      warning.raw ?? '',
    ].join('\u0000');
    if (this.seen.has(key)) return;
    this.seen.add(key);

    if (this.items.length >= MAX_WARNINGS) {
      if (!this.limitWarningAdded) {
        this.limitWarningAdded = true;
        this.items.push({
          code: 'W_WARNING_LIMIT',
          severity: 'warning',
          stage: 'emit',
          message: `more than ${MAX_WARNINGS} unique warnings; additional warnings were omitted`,
        });
      }
      return;
    }
    this.items.push(warning);
  }

  addAll(warnings: readonly Warning[]): void {
    for (const warning of warnings) this.add(warning);
  }

  /** Real warning count, including duplicates and warnings beyond the output cap. */
  get count(): number {
    return this.total;
  }

  /** Sorted unique warning codes from the captured (capped) list. */
  codes(): string[] {
    return [...new Set(this.items.map((item) => item.code))].sort();
  }

  toJSON(): Warning[] {
    return this.items.map((item) => ({ ...item }));
  }
}

/** Headers for `X-Subconverter-Warnings` / `X-Subconverter-Warn-Codes`. */
export function warningHeaders(collector: WarningCollector): Headers {
  const headers = new Headers();
  headers.set('X-Subconverter-Warnings', String(collector.count));
  const codes = collector.codes();
  if (codes.length > 0) {
    const shown = codes.slice(0, MAX_WARN_CODES);
    const hidden = codes.length - shown.length;
    headers.set(
      'X-Subconverter-Warn-Codes',
      hidden > 0 ? `${shown.join(',')},+${hidden}` : shown.join(','),
    );
  }
  return headers;
}
