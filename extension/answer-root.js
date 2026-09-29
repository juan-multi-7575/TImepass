// Locating the element that holds a *whole* assistant answer.
//
// This lives in its own file, ahead of content.js, so the selection rule can be
// unit tested. content.js is a classic browser script full of top-level chrome
// and DOM calls, so it cannot be imported into a test runner; this file is
// inert until called and takes the document as an argument.
//
// Why the rule exists: Gemini splits one long response into several chunks,
// each with its own copy button. Picking the biggest single chunk returns a
// fragment of the answer, which is indistinguishable from a finished one. The
// element that *contains* every chunk is the one holding the full text.

(function (scope) {
  'use strict';

  // Matched case-insensitively so both "Copy" and "copy" labels are caught.
  const COPY_SELECTOR = "button[aria-label*='opy' i]";

  /**
   * Whether an element is actually rendered. `offsetParent` is null for
   * `display:none` subtrees, which is how Gemini hides off-screen and
   * duplicated controls.
   * @param {Element|null} el
   * @returns {boolean}
   */
  function isVisible(el) {
    return !!el && el.offsetParent !== null;
  }

  /**
   * The smallest element that contains every one of `nodes`.
   * @param {Element[]} nodes
   * @returns {Element|null} Null when there is no common ancestor.
   */
  function commonAncestorOf(nodes) {
    if (!nodes || nodes.length === 0) return null;
    let node = nodes[0].parentElement;
    while (node && nodes.some(n => !node.contains(n))) node = node.parentElement;
    return node;
  }

  /**
   * Find the element holding the full answer text.
   * @param {Document} [doc] Defaults to the ambient document.
   * @returns {Element|null} Null when no answer block can be identified.
   */
  function findAnswerRoot(doc) {
    const d = doc || (typeof document !== 'undefined' ? document : null);
    if (!d) return null;

    // Precise when the page is Gemini: one container per assistant turn.
    const containers = d.querySelectorAll('response-container');
    if (containers.length) return containers[containers.length - 1];

    // Generic: the parent of the per-chunk action rows.
    const copies = Array.prototype.slice.call(d.querySelectorAll(COPY_SELECTOR)).filter(isVisible);
    return commonAncestorOf(copies);
  }

  /**
   * Read the full answer text out of a root element.
   * @param {Element|null} root
   * @returns {string} Empty string when there is nothing to read.
   */
  function readAnswerText(root) {
    if (!root) return '';
    return (root.textContent || '').trim().replace(/^Gemini said\s*/i, '').trim();
  }

  /**
   * Decide what to hand back when the wait ran out.
   *
   * Everything reachable at this point is a fragment of an unfinished answer.
   * Returning it is better than throwing, but returning it *unlabelled* is
   * worse than either: the caller cannot tell a truncated answer from a
   * complete one, which is how a half answer ends up presented as finished.
   * So every branch here comes back marked `partial`.
   *
   * @param {Array<{source: string, text?: string, minLength?: number}>} candidates
   *   Sources to try, in priority order.
   * @returns {{text: string, partial: true, source: string}|null} Null when no
   *   candidate held enough text to be worth returning.
   */
  function timeoutOutcome(candidates) {
    if (!Array.isArray(candidates)) return null;
    for (const c of candidates) {
      if (!c) continue;
      const text = (c.text || '').trim();
      // A few characters of chrome residue is worse than nothing: it reads as
      // an answer but carries none of one.
      const min = typeof c.minLength === 'number' ? c.minLength : 0;
      if (text.length > min) return { text, partial: true, source: c.source };
    }
    return null;
  }

  /**
   * Where to resume typing after the editor node was replaced underneath us.
   *
   * Gemini re-creates the composer while it initialises focus, so the node
   * captured before typing can be detached mid-word. The replacement may come
   * back with the text already restored, with nothing, or with content that is
   * not ours — and continuing blindly either loses characters or runs past the
   * end of the prompt.
   *
   * @param {string} existing What the fresh editor already holds.
   * @param {number} textLength Length of the full prompt being typed.
   * @returns {number} Index to continue typing from.
   */
  function resumeTypingIndex(existing, textLength) {
    const have = (existing || '').trim().length;
    // Nothing survived, so the keystrokes went with the old node: start over.
    if (have === 0) return 0;
    // Never index past the end of the prompt.
    if (have > textLength) return textLength;
    return have;
  }

  scope.__timepassAnswer = { findAnswerRoot, readAnswerText, commonAncestorOf, isVisible, timeoutOutcome, resumeTypingIndex };
})(typeof globalThis !== 'undefined' ? globalThis : this);
