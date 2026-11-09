/**
 * Vite `?raw` imports are used by rules tests to load fixtures from
 * `test/fixtures/rules/` without Node's fs typings (the project has no
 * `@types/node`). This ambient declaration is test-only.
 */
declare module '*?raw' {
  const content: string;
  export default content;
}
