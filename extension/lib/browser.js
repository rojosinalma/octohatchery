// The WebExtension namespace: `browser` in Firefox, `chrome` in Chrome. Both return promises in Manifest V3,
// so the rest of the code uses one API.
/** @type {any} */
export const ext = /** @type {any} */ (globalThis).browser ?? /** @type {any} */ (globalThis).chrome
