/**
 * Minimal Node types for the memory-limit subprocess harness. The project does
 * not depend on @types/node, and tsconfig restricts globals to workers-types.
 */
declare module 'node:child_process' {
  export interface SpawnSyncResult {
    status: number | null;
    signal: string | null;
    stdout: string;
    stderr: string;
  }

  export function spawnSync(
    command: string,
    args?: readonly string[],
    options?: {
      cwd?: string;
      encoding?: 'utf8';
      timeout?: number;
      maxBuffer?: number;
      env?: Record<string, string | undefined>;
    },
  ): SpawnSyncResult;
}

declare const process: {
  execPath: string;
  cwd(): string;
  argv: string[];
  env: Record<string, string | undefined>;
};
