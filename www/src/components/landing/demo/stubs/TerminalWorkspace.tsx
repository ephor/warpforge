/**
 * Stands in for the app's terminal workspace on the marketing site.
 *
 * The demo never opens the Terminal tab, and the real one pulls xterm — a
 * quarter-megabyte of terminal emulator for a pane nobody sees, and a CommonJS
 * module that will not prerender. Aliased in `astro.config.ts`; the surfaces
 * the demo does show are the app's own components, unaliased.
 */
export function TerminalWorkspaceView() {
  return null;
}
export default TerminalWorkspaceView;
