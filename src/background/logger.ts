/** Flip to true for verbose diagnostics. Real failures always log. */
export const DEBUG = false

export function log(...args: unknown[]): void {
  if (DEBUG) console.log("[shabdiz]", ...args)
}
