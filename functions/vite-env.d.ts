/**
 * CSS side-effect imports, for the functions type-check project only.
 *
 * `src/vite-env.d.ts` gives the application project these declarations through
 * Vite's client types. This project exists to type-check `functions/**`, which
 * never renders React and never loads a stylesheet — but it transitively reaches
 * the studio and viewer components through `src/features/share/index.ts`, and
 * those import their own CSS. Declaring the module here keeps the check honest
 * without pulling Vite's whole client type surface into an edge project.
 */
declare module '*.css'
