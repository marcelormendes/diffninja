import { BRAND_MARK, BRAND_MARK_STYLES } from "./brand.js";
import { PALETTE_STYLES } from "./palette.js";
import { escapeHtml } from "./escape-html.js";

/**
 * The one page the connected session serves.
 *
 * The page owns no data: it renders whatever `GET /api/state` returns, posts a
 * draft to `/api/preview`, and posts the same payload to `/api/submit`. Every
 * string that comes from GitHub (paths, diff lines, the diff text itself, error
 * messages) reaches the DOM through `textContent`; nothing is interpolated into
 * markup or into the script. Style and script carry the session CSRF token as
 * their CSP nonce, so the server can serve a `default-src 'none'` policy with
 * no inline handlers and no inline styles.
 *
 * Drafts live in `sessionStorage`, keyed per pull request and stamped with the
 * snapshot id. Restoring a draft revalidates every comment anchor against the
 * snapshot on screen: a comment whose line no longer exists in the new revision
 * is dropped, never silently carried over.
 */
export function renderConnectedPage(csrf: string): string {
  const nonce = escapeHtml(csrf);
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="color-scheme" content="light dark">',
    '<meta name="robots" content="noindex, nofollow">',
    "<title>diffninja connected review</title>",
    `<style nonce="${nonce}">${STYLES}</style>`,
    "</head>",
    "<body>",
    '<div class="wrap">',
    '<header class="masthead">',
    `<p class="brand">${BRAND_MARK}<span>diffninja</span></p>`,
    '<h1 id="page-title">Pull request review</h1>',
    '<p id="page-meta" class="page-meta" hidden></p>',
    '<p id="lede" class="lede">Load a GitHub pull request, read its diff in a recommended order, and post your own review through the <span class="mono">gh</span> CLI. Nothing is posted until you press Submit.</p>',
    '<p id="message-note" class="note" role="status" aria-live="polite" hidden></p>',
    "</header>",
    '<section id="load-section" class="panel" aria-labelledby="load-heading">',
    '<h2 id="load-heading">Load a pull request</h2>',
    '<form id="load-form">',
    '<div class="field">',
    '<label for="pr-url">Pull request URL</label>',
    '<input id="pr-url" name="url" type="url" required inputmode="url" autocomplete="off" spellcheck="false" placeholder="https://github.com/owner/repo/pull/123" aria-describedby="pr-url-help">',
    '<p class="hint" id="pr-url-help">A full github.com pull request URL. No other host is accepted, and no other GitHub data is reachable from this page.</p>',
    "</div>",
    '<button type="submit" id="load-button">Load pull request</button>',
    "</form>",
    '<p class="note">diffninja reads the pull request and posts reviews through your <span class="mono">gh</span> login. This page never sees a token.</p>',
    "</section>",
    '<p id="status-line" class="status" role="status" aria-live="polite"></p>',
    '<p id="empty-note" class="empty">No pull request loaded. Paste a pull request URL above to begin.</p>',
    '<div id="error-box" class="error" role="alert" hidden>',
    '<p class="error-title">Request failed</p>',
    '<p id="error-text" class="error-text"></p>',
    '<p class="hint">Your draft is kept. Check GitHub state to re-read the pull request and the account before deciding what to do next.</p>',
    '<button type="button" id="refresh-button" data-action="refresh">Check GitHub state</button>',
    "</div>",
    '<nav id="analysis-section" class="rail" aria-labelledby="analysis-heading" hidden>',
    '<header class="rail-head">',
    '<h2 id="analysis-heading">Reading order</h2>',
    '<p id="analysis-sub" class="rail-sub"></p>',
    '<p id="rail-progress" class="rail-progress" hidden><span id="rail-at"></span><span class="rail-keys"><kbd>j</kbd> <kbd>k</kbd> next and previous</span></p>',
    '<div id="analysis-actions" class="rail-actions"></div>',
    "</header>",
    '<div id="analysis-body" class="rail-body"></div>',
    '<footer class="rail-foot">',
    '<p id="rail-draft" class="rail-draft">No comments yet</p>',
    '<a id="rail-finish" class="btn btn-primary btn-sm" href="#compose-heading">Finish review</a>',
    "</footer>",
    "</nav>",
    '<section id="diff-section" class="panel card" aria-labelledby="diff-heading" hidden>',
    '<header class="card-head">',
    '<div class="card-titles"><h2 id="diff-heading">Changes</h2><p id="diff-sub" class="card-sub">Hover a line and press + to comment. Comments stay in this tab until you submit.</p></div>',
    '<div id="view-switch" class="view-switch" role="group" aria-label="Diff layout" hidden>',
    '<button type="button" data-action="view" data-view="guided" aria-pressed="true">Reading order</button>',
    '<button type="button" data-action="view" data-view="file" aria-pressed="false">By file</button>',
    "</div>",
    "</header>",
    '<div id="diff-body" class="card-body"></div>',
    "</section>",
    '<section id="compose-section" class="panel card" aria-labelledby="compose-heading" hidden>',
    '<header class="card-head">',
    '<div class="card-titles"><h2 id="compose-heading">Your review</h2><p id="draft-count" class="card-sub"></p></div>',
    "</header>",
    '<div class="card-body stack">',
    '<p id="anchor-notice" class="status" role="status" aria-live="polite" hidden></p>',
    '<div class="field">',
    '<label for="review-body">Summary</label>',
    '<textarea id="review-body" rows="4" placeholder="Leave an overall comment (optional when you have line comments)" aria-describedby="review-body-help"></textarea>',
    '<p class="hint" id="review-body-help">Written by you. Comments your agent suggests join your draft only when you add them.</p>',
    "</div>",
    '<fieldset class="event-fieldset">',
    '<legend class="sr-only">Review action</legend>',
    '<div class="event-options">',
    '<label class="event-option"><input type="radio" name="event" value="COMMENT" checked><span class="event-name">Comment</span><span class="event-help">General feedback</span></label>',
    '<label class="event-option"><input type="radio" name="event" value="APPROVE"><span class="event-name">Approve</span><span class="event-help">Approve merging these changes</span></label>',
    '<label class="event-option"><input type="radio" name="event" value="REQUEST_CHANGES"><span class="event-name">Request changes</span><span class="event-help">Feedback that must be addressed</span></label>',
    "</div>",
    "</fieldset>",
    '<p id="event-note" class="status" role="status" aria-live="polite" hidden></p>',
    '<div id="revalidate-section" class="revalidate-section" hidden>',
    '<h3 class="subhead" id="revalidate-heading">Awaiting revalidation</h3>',
    '<p id="revalidate-note" class="status" role="status" aria-live="polite"></p>',
    '<div id="revalidate-list"></div>',
    "</div>",
    '<h3 class="subhead">Line comments</h3>',
    '<div id="draft-list"></div>',
    "</div>",
    "</section>",
    '<section id="preview-section" class="panel card" aria-labelledby="preview-heading" hidden>',
    '<header class="card-head">',
    '<div class="card-titles"><h2 id="preview-heading">Submit</h2><p class="card-sub">Check the exact request, then post it to GitHub from your <span class="mono">gh</span> login.</p></div>',
    "</header>",
    '<div class="card-body stack">',
    '<div class="submit-row">',
    '<button type="button" id="preview-button" class="btn" data-action="preview">Check the review</button>',
    '<button type="button" id="submit-button" class="btn btn-primary" data-action="submit" disabled>Submit review</button>',
    '<p id="preview-state" class="status" role="status" aria-live="polite"></p>',
    "</div>",
    '<p id="submit-hint" class="hint" role="status" aria-live="polite"></p>',
    '<details class="payload-details">',
    '<summary>Request GitHub will receive</summary>',
    '<pre id="preview-json" class="payload" tabindex="0" aria-label="Previewed GitHub review payload">Nothing checked yet.</pre>',
    '<p class="hint">The review is pinned to the commit in <span class="mono">commit_id</span>. The pull request is checked again right before posting; GitHub has no atomic check-and-post, so a push in that instant can still land first. The receipt names the commit reviewed.</p>',
    "</details>",
    "</div>",
    "</section>",
    '<section id="receipt-section" class="panel" aria-labelledby="receipt-heading" hidden>',
    '<h2 id="receipt-heading">Receipt</h2>',
    '<div id="receipt-body"></div>',
    "</section>",
    '<details id="details-section" class="panel details-panel" hidden>',
    '<summary>Pull request and review details</summary>',
    '<div id="details-analysis"></div>',
    '<section id="snapshot-section" aria-labelledby="snapshot-heading">',
    '<h3 id="snapshot-heading" class="subhead">This revision</h3>',
    '<div id="snapshot-body"></div>',
    "</section>",
    '<section id="identity-section" aria-labelledby="identity-heading" hidden>',
    '<h3 id="identity-heading" class="subhead">Reviewing as</h3>',
    '<div id="identity-body"></div>',
    "</section>",
    '<p><button type="button" class="link-button" data-action="show-load">Load a different pull request</button></p>',
    "</details>",
    '<footer class="foot">',
    '<p class="note">Reports and this page contain source code. Keep them private. Diffninja gives no automatic approval.</p>',
    "</footer>",
    "</div>",
    '<aside id="flow-drawer" class="flow-drawer" aria-labelledby="flow-title" hidden>',
    '<div class="flow-bar">',
    '<h2 id="flow-title" class="flow-title">Call flow</h2>',
    '<button type="button" id="flow-close" class="btn btn-quiet btn-sm" data-action="close-flow" aria-label="Close the call flow">Close</button>',
    "</div>",
    '<iframe id="flow-frame" class="flow-frame" title="Call flow"></iframe>',
    "</aside>",
    `<script nonce="${nonce}">${script(csrf)}</script>`,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

function script(csrf: string): string {
  // The nonce doubles as a JS string literal; `\u003c` keeps a hostile value
  // from closing the surrounding script element.
  return `
(function () {
  'use strict';

  var CSRF = ${JSON.stringify(csrf).replaceAll("<", "\\u003c")};
  var DRAFT_PREFIX = 'diffninja.connected.draft.v1';

  var state = null;
  var comments = [];
  var body = '';
  var event = 'COMMENT';
  var previewPayload = null;
  var previewSignature = '';
  var busy = false;
  var submitting = false;
  var lastError = '';
  var serverError = false;
  var submitUncertain = false;
  var anchorNotice = '';
  var lastRestored = '';
  var editorSeq = 0;
  var commentSeq = 0;
  var reattachIndex = -1;
  var draftOwner = '';
  var analysis = null;
  var showLoad = false;
  var closedFiles = Object.create(null);
  var settled = Object.create(null);
  var busyAction = '';
  var placeAnchor = null;
  var revealReceipt = false;
  var flowSnapshot = '';
  var flowReturn = null;
  var analysisFor = '';
  var analysisLoading = false;
  var analysisTimer = null;
  var VIEW_KEY = 'diffninja.connected.view';
  var view = 'guided';
  var stopsNow = [];
  var currentRank = 0;
  var followedRank = 0;
  var seenRanks = Object.create(null);
  var seenFor = '';
  var el = {};

  function byId(id) { return document.getElementById(id); }

  function make(tag, className, textValue) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (textValue !== undefined && textValue !== null) node.textContent = String(textValue);
    return node;
  }

  function setText(node, value) {
    node.textContent = value === undefined || value === null ? '' : String(value);
  }

  function show(node, visible) { node.hidden = !visible; }

  function snapshot() { return state && state.snapshot ? state.snapshot : null; }

  function lines() {
    var snap = snapshot();
    return snap && Array.isArray(snap.lines) ? snap.lines : [];
  }

  function shortSha(value) {
    return typeof value === 'string' && value.length > 0 ? value.slice(0, 8) : 'unknown';
  }

  function sideLabel(side) { return side === 'LEFT' ? 'old' : 'new'; }

  function githubLink(url, text) {
    var safe = typeof url === 'string' && url.indexOf('https://github.com/') === 0;
    if (!safe) return make('span', null, text);
    var link = make('a', null, text);
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    return link;
  }

  /* ---------------------------------------------------------------- state -- */

  /**
   * The GitHub payload draft. Only comments attached to the loaded revision are
   * included: a comment awaiting revalidation names a line of an older
   * revision, so sending it would place a human's words on unrelated code.
   */
  function draftInput() {
    var snap = snapshot();
    var anchored = [];
    for (var i = 0; i < comments.length; i += 1) {
      var c = comments[i];
      if (c.needsRevalidation) continue;
      anchored.push({ path: c.path, line: c.line, side: c.side, body: c.body });
    }
    return { snapshotId: snap ? snap.id : '', event: event, body: body, comments: anchored };
  }

  /** The loaded revision's own line at that coordinate, or null when absent. */
  function currentLine(anchor) {
    var list = lines();
    for (var i = 0; i < list.length; i += 1) {
      var line = list[i];
      if (line.path === anchor.path && line.line === anchor.line && line.side === anchor.side) return line;
    }
    return null;
  }

  function commentIndexAt(anchor) {
    for (var i = 0; i < comments.length; i += 1) {
      var c = comments[i];
      if (c.needsRevalidation) continue;
      if (c.path === anchor.path && c.line === anchor.line && c.side === anchor.side) return i;
    }
    return -1;
  }

  function unvalidatedCount() {
    var total = 0;
    for (var i = 0; i < comments.length; i += 1) {
      if (comments[i].needsRevalidation) total += 1;
    }
    return total;
  }

  function setState(next) {
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      lastError = 'The server answered with a state this page could not read.';
      serverError = true;
      return;
    }
    state = next;
    var snap = snapshot();
    if (snap) restoreDraft(snap);
  }

  /* -------------------------------------------------------------- storage -- */

  function storage() {
    try { return window.sessionStorage; } catch (error) { return null; }
  }

  function draftKey(snap) {
    return DRAFT_PREFIX + '|' + snap.owner + '/' + snap.repo + '#' + snap.number;
  }

  function saveDraft() {
    var snap = snapshot();
    var store = storage();
    if (!snap || !store) return;
    try {
      store.setItem(draftKey(snap), JSON.stringify({
        snapshotId: snap.id,
        headSha: snap.headSha,
        event: event,
        body: body,
        comments: comments,
        settled: Object.keys(settled)
      }));
    } catch (error) {
      /* Storage disabled or full: the draft simply stays in memory. */
    }
  }

  /**
   * The stored draft for a snapshot: null when this pull request genuinely has
   * none, undefined when storage is unavailable or the stored value is
   * unreadable. The distinction matters: only a definite absence may reset the
   * draft, so a browser that blocks sessionStorage never loses an in-memory one.
   */
  function readDraft(snap) {
    var store = storage();
    if (!store) return undefined;
    var raw = null;
    try { raw = store.getItem(draftKey(snap)); } catch (error) { return undefined; }
    if (typeof raw !== 'string' || raw === '') return null;
    try {
      var parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined;
    } catch (error) {
      return undefined;
    }
  }

  function clearDraft() {
    var snap = snapshot();
    var store = storage();
    if (!snap || !store) return;
    try { store.removeItem(draftKey(snap)); } catch (error) { /* nothing to clear */ }
  }

  /**
   * Flag every comment that was written against a different revision and write
   * the flags back. Nothing is dropped: a matching path and line number is not
   * proof of the same code, so a comment from another revision must be
   * re-attached or confirmed by a human before it may be submitted.
   */
  function invalidateForSnapshot(snap) {
    var flagged = 0;
    for (var i = 0; i < comments.length; i += 1) {
      var c = comments[i];
      if (c.snapshotId === snap.id) continue;
      if (!c.needsRevalidation) flagged += 1;
      c.needsRevalidation = true;
    }
    saveDraft();
    return flagged;
  }

  /** Restore this pull request's own draft and revalidate it against the snapshot. */
  function restoreDraft(snap) {
    if (lastRestored === snap.id) return;
    lastRestored = snap.id;
    var owner = snap.owner + '/' + snap.repo + '#' + snap.number;
    var stored = readDraft(snap);
    var record = stored && typeof stored === 'object' ? stored : null;
    if (!record) {
      if (draftOwner !== owner) {
        // Another pull request's draft must not follow the reviewer here.
        comments = [];
        body = '';
        event = 'COMMENT';
        reattachIndex = -1;
        anchorNotice = '';
        settled = Object.create(null);
        draftOwner = owner;
        return;
      }
      // Storage unusable, or memory already holds this pull request: invalidate
      // in memory rather than returning early and silently keeping stale anchors.
      anchorNotice = invalidateForSnapshot(snap) > 0
        ? 'The pull request changed since this draft was written. Comment text was kept, but every line comment must be attached or confirmed against the current revision before it can be submitted.'
        : '';
      return;
    }
    // The stored record is what this pull request owns: adopt it whole.
    comments = [];
    body = '';
    event = 'COMMENT';
    reattachIndex = -1;
    draftOwner = owner;
    settled = Object.create(null);
    var storedSettled = Array.isArray(record.settled) ? record.settled : [];
    for (var k = 0; k < storedSettled.length; k += 1) {
      if (typeof storedSettled[k] === 'string') settled[storedSettled[k]] = true;
    }
    var storedComments = Array.isArray(record.comments) ? record.comments : [];
    for (var i = 0; i < storedComments.length; i += 1) {
      var c = storedComments[i];
      var shaped = c && typeof c === 'object' && !Array.isArray(c)
        && typeof c.path === 'string'
        && typeof c.line === 'number'
        && (c.side === 'LEFT' || c.side === 'RIGHT')
        && typeof c.body === 'string';
      if (!shaped) continue;
      comments.push({
        id: typeof c.id === 'string' && c.id !== '' ? c.id : 'c' + (commentSeq += 1),
        path: c.path,
        line: c.line,
        side: c.side,
        body: c.body,
        snapshotId: typeof c.snapshotId === 'string' ? c.snapshotId : '',
        needsRevalidation: c.needsRevalidation === true,
        suggestedBy: typeof c.suggestedBy === 'string' ? c.suggestedBy : ''
      });
    }
    if (typeof record.body === 'string') body = record.body;
    if (record.event === 'COMMENT' || record.event === 'APPROVE' || record.event === 'REQUEST_CHANGES') event = record.event;
    var moved = typeof record.snapshotId === 'string' && record.snapshotId !== snap.id;
    invalidateForSnapshot(snap);
    var hasDraft = comments.length > 0 || body !== '';
    anchorNotice = '';
    if (!hasDraft) return;
    if (!moved) {
      anchorNotice = 'Draft restored from this browser tab for ' + owner + '. Nothing is sent to GitHub until you submit.';
      return;
    }
    anchorNotice = 'The pull request changed (' + shortSha(record.headSha) + ' to ' + shortSha(snap.headSha) + ') since this draft was saved. Comment text was kept, but every line comment must be attached or confirmed against the current revision before it can be submitted.';
  }

  /* ------------------------------------------------------------------ api -- */

  /**
   * A failed request. The uncertain flag separates the honest "no answer came
   * back" from a definite refusal: only the latter carries a state the page may
   * trust.
   */
  function requestFailure(message, state, uncertain) {
    var failure = new Error(message);
    if (state) failure.state = state;
    if (uncertain) failure.uncertain = true;
    return failure;
  }

  function api(method, path, payload) {
    var init = { method: method, credentials: 'same-origin', headers: { Accept: 'application/json' } };
    if (method !== 'GET') {
      init.headers['Content-Type'] = 'application/json';
      init.headers['X-Diffninja-CSRF'] = CSRF;
      init.body = JSON.stringify(payload === undefined ? {} : payload);
    }
    return fetch(path, init).then(function (response) {
      return response.text().then(function (raw) {
        var data = null;
        if (raw) {
          try { data = JSON.parse(raw); } catch (error) { data = null; }
        }
        var message = data && typeof data === 'object' && typeof data.error === 'string' ? data.error : '';
        var state = data && typeof data === 'object' && data.state ? data.state : null;
        // A structured error and state is a definite answer from diffninja.
        if (message !== '') throw requestFailure(message, state, false);
        if (!response.ok) {
          throw requestFailure('The server answered with status ' + response.status + ' and no readable result.', null, true);
        }
        if (data === null) throw requestFailure('The server answered with a response this page could not read.', null, true);
        return data;
      });
    }, function () {
      throw requestFailure('Could not reach the local diffninja server. Check that diffninja is still running.', null, true);
    });
  }

  function run(work, options) {
    if (busy) return Promise.resolve();
    var isSubmit = Boolean(options && options.submit);
    busy = true;
    lastError = '';
    serverError = false;
    render();
    return work().then(function () {}, function (error) {
      var uncertain = Boolean(error && error.uncertain);
      if (uncertain && isSubmit) {
        // The write may have reached GitHub: no retry, no new-session advice,
        // and a state check is the only way forward.
        submitUncertain = true;
        serverError = true;
        return;
      }
      lastError = error && error.message ? error.message : 'The request failed.';
      serverError = true;
      if (error && error.state) setState(error.state);
    }).then(function () {
      busy = false;
      busyAction = '';
      render();
    });
  }

  /* -------------------------------------------------------------- actions -- */

  function loadPullRequest(url) {
    return run(function () {
      return api('POST', '/api/load', { url: url }).then(function (data) {
        // A load invalidates the previewed payload; the draft itself is decided
        // by setState, which restores this pull request's own saved draft.
        previewPayload = null;
        previewSignature = '';
        lastRestored = '';
        setState(data);
      });
    });
  }

  function previewReview() {
    if (!snapshot() || composeDisabled() || unvalidatedCount() > 0) return;
    var payload = draftInput();
    busyAction = 'preview';
    run(function () {
      return api('POST', '/api/preview', payload).then(function (data) {
        previewPayload = data;
        previewSignature = JSON.stringify(payload);
      });
    });
  }

  function submitReview() {
    if (busy || submitting || validationHint() !== '') return;
    var payload = draftInput();
    submitting = true;
    busyAction = 'submit';
    // The backend drops its previewed payload after any submission that did not
    // confirm, and github.ts refuses a submit without a fresh preview. Mirror
    // that here so the button cannot offer a submission GitHub will refuse.
    previewPayload = null;
    previewSignature = '';
    render();
    run(function () {
      return api('POST', '/api/submit', payload).then(function (data) {
        setState(data);
        // Only a confirmed review clears the draft. An unknown or refused
        // outcome keeps it, because the review may never have been posted.
        if (data && data.status === 'submitted') {
          revealReceipt = true;
          comments = [];
          body = '';
          event = 'COMMENT';
          reattachIndex = -1;
          var snap = snapshot();
          lastRestored = snap ? snap.id : '';
          clearDraft();
        }
      });
    }, { submit: true }).then(function () {
      submitting = false;
      render();
    });
  }

  /** Recover server state first; reconcile uncertain writes, refresh stale reads. */
  function refreshState() {
    lastError = '';
    serverError = false;
    run(function () {
      return api('GET', '/api/state', null).then(function (current) {
        if (current.status === 'unknown' || current.status === 'submitting') {
          return api('POST', '/api/reconcile', {});
        }
        if (current.status !== 'submitted' && current.snapshot) {
          return api('POST', '/api/load', { url: current.snapshot.url });
        }
        return current;
      }).then(function (data) {
        submitUncertain = false;
        previewPayload = null;
        previewSignature = '';
        setState(data);
      });
    });
  }

  /**
   * A Comment click either attaches a new comment to the line under it or
   * re-attaches the comment the reviewer armed for revalidation. Nothing is
   * ever bound implicitly: a comment from another revision moves only when a
   * human points at the line it now belongs to.
   */
  function addComment(node) {
    var snap = snapshot();
    if (!snap || composeDisabled()) return;
    var anchor = {
      path: node.getAttribute('data-path') || '',
      line: Number(node.getAttribute('data-line')),
      side: node.getAttribute('data-side')
    };
    if (!Number.isInteger(anchor.line) || (anchor.side !== 'LEFT' && anchor.side !== 'RIGHT')) return;
    if (!currentLine(anchor)) {
      lastError = 'That line is not part of the loaded revision, so no comment can be attached to it.';
      serverError = false;
      render();
      return;
    }
    var armed = reattachIndex >= 0 ? comments[reattachIndex] : null;
    if (armed && armed.needsRevalidation) {
      var clash = commentIndexAt(anchor);
      if (clash >= 0) {
        lastError = 'A line comment is already attached to that line. Remove it before re-attaching another.';
        serverError = false;
        render();
        return;
      }
      armed.path = anchor.path;
      armed.line = anchor.line;
      armed.side = anchor.side;
      armed.snapshotId = snap.id;
      armed.needsRevalidation = false;
      reattachIndex = -1;
      saveDraft();
      render();
      focusEditor(commentIndexAt(anchor));
      return;
    }
    var existing = commentIndexAt(anchor);
    if (existing >= 0) { focusEditor(existing); return; }
    commentSeq += 1;
    comments.push({
      id: 'c' + commentSeq,
      path: anchor.path,
      line: anchor.line,
      side: anchor.side,
      body: '',
      snapshotId: snap.id,
      needsRevalidation: false
    });
    saveDraft();
    render();
    focusEditor(comments.length - 1);
  }

  /** Confirm that a comment's own coordinate is still where its author meant it. */
  function confirmComment(node) {
    if (busy || submitting) return;
    var index = Number(node.getAttribute('data-index'));
    var comment = comments[index];
    if (!comment || !comment.needsRevalidation) return;
    var line = currentLine(comment);
    if (!line) {
      lastError = 'That line is not part of the loaded revision, so it cannot be confirmed. Attach the comment to a line instead.';
      serverError = false;
      render();
      return;
    }
    if (commentIndexAt(comment) >= 0) {
      lastError = 'A line comment is already attached to that line. Remove it before confirming another.';
      serverError = false;
      render();
      return;
    }
    comment.snapshotId = snapshot().id;
    comment.needsRevalidation = false;
    saveDraft();
    render();
  }

  /** Arm a comment so the next Comment click attaches it to a chosen line. */
  function armComment(node) {
    if (busy || submitting) return;
    var index = Number(node.getAttribute('data-index'));
    if (!Number.isInteger(index) || index < 0 || index >= comments.length) return;
    if (!comments[index].needsRevalidation) return;
    reattachIndex = reattachIndex === index ? -1 : index;
    render();
  }

  function cancelReattach() {
    reattachIndex = -1;
    render();
  }

  function removeComment(node) {
    var index = Number(node.getAttribute('data-index'));
    if (!Number.isInteger(index) || index < 0 || index >= comments.length) return;
    comments.splice(index, 1);
    if (reattachIndex === index) reattachIndex = -1;
    else if (reattachIndex > index) reattachIndex -= 1;
    saveDraft();
    render();
  }

  function focusEditor(index) {
    var input = document.querySelector('.editor[data-index="' + index + '"] .editor-input');
    if (!input) return;
    input.focus();
    if (input.scrollIntoView) input.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function editComment(node) {
    var index = Number(node.getAttribute('data-index'));
    if (!Number.isInteger(index) || index < 0 || index >= comments.length) return;
    focusEditor(index);
  }

  function setEvent(value) {
    if (value !== 'COMMENT' && value !== 'APPROVE' && value !== 'REQUEST_CHANGES') return;
    event = value;
    saveDraft();
    updateEventNote();
    updateActionState();
  }

  function syncEventInputs() {
    for (var i = 0; i < el.eventInputs.length; i += 1) {
      el.eventInputs[i].checked = el.eventInputs[i].value === event;
    }
  }

  /* ----------------------------------------------------------------- gates -- */

  /** The loaded snapshot carries lines we can attach comments to. */
  function reviewable() {
    var snap = snapshot();
    if (!snap || snap.unavailableReason) return false;
    return lines().length > 0;
  }

  /**
   * A composer is worth showing only while this session could still submit.
   * After a confirmed review the backend refuses everything but state and
   * reconcile, so an empty disabled form would be misleading.
   */
  function composerReady() {
    if (!reviewable() || state.status === 'submitted') return false;
    return true;
  }

  function composeDisabled() {
    if (!reviewable() || busy || submitting || submitUncertain) return true;
    return state.status !== 'ready';
  }

  function validationHint() {
    var snap = snapshot();
    if (!snap) return 'Load a pull request first.';
    if (busy) return 'A request is already running.';
    if (submitting) return 'The review is being submitted.';
    if (state.status === 'submitted') return 'This pull request already has a submitted review.';
    if (state.status === 'submitting') return 'A submission is already in progress; refresh the state.';
    if (state.status === 'unknown') return 'The last submission outcome is unknown. Check GitHub state before submitting again.';
    if (submitUncertain) return 'The submission request did not complete, so GitHub may or may not have recorded this review. Check GitHub state before doing anything else.';
    if (snap.unavailableReason) return 'This pull request has no reviewable revision loaded.';
    if (lines().length === 0) return 'This pull request has no reviewable diff lines.';
    var pending = unvalidatedCount();
    if (pending > 0) {
      return pending === 1
        ? 'One line comment is waiting to be attached to the current revision. Attach or confirm it before submitting.'
        : pending + ' line comments are waiting to be attached to the current revision. Attach or confirm each one before submitting.';
    }
    for (var i = 0; i < comments.length; i += 1) {
      if (comments[i].body.trim() === '') return 'Every line comment needs text, or remove it.';
    }
    if (body.trim() === '' && comments.length === 0) return 'Write a summary or add a line comment to submit.';
    if (previewPayload === null) return 'Check the review first; Submit unlocks once it is checked.';
    if (previewSignature !== JSON.stringify(draftInput())) return 'The draft changed since it was checked. Check it again.';
    return '';
  }

  /* --------------------------------------------------------------- render -- */

  function statusMessage() {
    if (submitting) return 'Submitting the review to GitHub…';
    if (busy) return 'Contacting the local diffninja server…';
    if (!state) return 'Loading the current state…';
    if (submitUncertain) return 'The submission outcome is unknown. Check GitHub state.';
    if (lastError !== '') return 'The last request failed. Your draft is kept.';
    var status = state.status;
    if (status === 'submitting') return 'A GitHub review submission is already in progress in this session.';
    if (status === 'unknown') return 'The submission outcome is unknown. Check GitHub before submitting again.';
    if (status === 'submitted') return 'The review is submitted. The receipt below links to it on GitHub.';
    var snap = snapshot();
    if (!snap) return typeof state.message === 'string' && state.message !== '' ? state.message : 'No pull request loaded yet.';
    if (status !== 'ready') {
      if (typeof state.message === 'string' && state.message !== '') return state.message;
      return 'No reviewable revision is loaded for this pull request. Your draft, if any, is kept in this tab.';
    }
    return 'Ready: ' + snap.owner + '/' + snap.repo + '#' + snap.number + ' at ' + shortSha(snap.headSha) + '.';
  }

  function addFact(dl, term, value, mono) {
    dl.appendChild(make('dt', null, term));
    dl.appendChild(make('dd', mono ? 'mono' : null, value));
  }

  function addLinkFact(dl, term, url, text) {
    dl.appendChild(make('dt', null, term));
    var dd = make('dd', 'mono');
    dd.appendChild(githubLink(url, text));
    dl.appendChild(dd);
  }

  function renderIdentity() {
    var identity = state && state.identity && typeof state.identity === 'object' ? state.identity : null;
    show(el.identitySection, Boolean(identity));
    el.identityBody.textContent = '';
    if (!identity) return;
    var dl = make('dl', 'facts');
    addFact(dl, 'GitHub account', typeof identity.login === 'string' && identity.login !== '' ? identity.login : 'unknown');
    addFact(dl, 'Account id', typeof identity.id === 'number' ? String(identity.id) : 'unknown');
    el.identityBody.appendChild(dl);
    el.identityBody.appendChild(make('p', 'note', 'A submitted review is posted as this account, through gh. GH_TOKEN or GITHUB_TOKEN in the server environment takes precedence over the gh login.'));
  }

  function reviewerLogin() {
    var identity = state && state.identity && typeof state.identity === 'object' ? state.identity : null;
    return identity && typeof identity.login === 'string' && identity.login !== '' ? identity.login : '';
  }

  function renderSnapshot() {
    var snap = snapshot();
    show(el.detailsSection, Boolean(snap));
    show(el.lede, !snap);
    show(el.loadSection, !snap || showLoad);
    show(el.pageMeta, Boolean(snap));
    el.pageMeta.textContent = '';
    el.snapshotBody.textContent = '';
    if (!snap) {
      setText(el.pageTitle, 'Pull request review');
      return;
    }
    setText(el.pageTitle, typeof snap.title === 'string' && snap.title ? snap.title : 'Untitled pull request');
    var ref = (typeof snap.owner === 'string' ? snap.owner : 'unknown') + '/' + (typeof snap.repo === 'string' ? snap.repo : 'unknown') + '#' + String(snap.number);
    el.pageMeta.appendChild(githubLink(snap.url, ref));
    var stateWord = typeof snap.state === 'string' ? snap.state.toLowerCase() : 'unknown';
    el.pageMeta.insertBefore(make('span', 'state-badge state-' + stateWord, stateWord.charAt(0).toUpperCase() + stateWord.slice(1)), el.pageMeta.firstChild);
    el.pageMeta.appendChild(make('span', 'meta-item sha', shortSha(snap.headSha)));
    var login = reviewerLogin();
    if (login !== '') el.pageMeta.appendChild(make('span', 'meta-item', 'Reviewing as ' + login));
    var description = make('details', '');
    description.appendChild(make('summary', '', 'Description (the author\u2019s claims)'));
    description.appendChild(make('pre', '', typeof snap.body === 'string' && snap.body ? snap.body : 'No description.'));
    el.snapshotBody.appendChild(description);
    var dl = make('dl', 'facts');
    addLinkFact(dl, 'Pull request', snap.url, typeof snap.url === 'string' ? snap.url : 'unknown');
    addFact(dl, 'GitHub state', typeof snap.state === 'string' ? snap.state : 'unknown');
    addFact(dl, 'Base commit', typeof snap.baseSha === 'string' ? snap.baseSha : 'unknown', true);
    addFact(dl, 'Head commit', typeof snap.headSha === 'string' ? snap.headSha : 'unknown', true);
    addFact(dl, 'Snapshot id', typeof snap.id === 'string' ? snap.id : 'unknown', true);
    addFact(dl, 'Diff lines', String(lines().length));
    el.snapshotBody.appendChild(dl);
    el.snapshotBody.appendChild(make('p', 'note', 'This page reviews exactly this revision. If the pull request changes, submitting is blocked until you refresh and recheck your line comments; your review is pinned to the head commit above.'));
    if (typeof snap.unavailableReason === 'string' && snap.unavailableReason !== '') {
      el.snapshotBody.appendChild(make('p', 'note', snap.unavailableReason));
    }
  }

  function editorRow(index) {
    var comment = comments[index];
    editorSeq += 1;
    var wrap = make('div', 'editor');
    wrap.dataset.index = String(index);
    var inputId = 'line-comment-' + String(editorSeq);
    var label = make('label', 'sr-only', 'Line comment on ' + comment.path + ' line ' + comment.line + ' (' + sideLabel(comment.side) + ' side)');
    label.setAttribute('for', inputId);
    var field = make('div', 'editor-row');
    var input = document.createElement('input');
    input.type = 'text';
    input.id = inputId;
    input.className = 'editor-input';
    input.dataset.index = String(index);
    input.value = comment.body;
    input.setAttribute('aria-describedby', inputId + '-help');
    var remove = make('button', 'btn btn-quiet btn-sm', 'Remove');
    remove.type = 'button';
    remove.dataset.action = 'remove-comment';
    remove.dataset.index = String(index);
    remove.setAttribute('aria-label', 'Remove the comment on ' + comment.path + ' line ' + comment.line);
    field.appendChild(input);
    field.appendChild(remove);
    wrap.appendChild(label);
    wrap.appendChild(field);
    var help = make('p', 'hint', comment.suggestedBy
      ? 'Suggested by ' + comment.suggestedBy + ' and added by you: it is your comment now, so edit it as you like. Kept in this browser tab until it is submitted.'
      : 'One line of plain text, written by you. Kept in this browser tab for this pull request until it is submitted.');
    help.id = inputId + '-help';
    wrap.appendChild(help);
    return wrap;
  }

  /* ------------------------------------------------------------ analysis -- */

  var STATUS_ORDER = ['attention', 'uncertain', 'low', 'passed'];

  function currentAnalysis() {
    var snap = snapshot();
    if (!snap || !analysis || analysis.available !== true || analysis.snapshotId !== snap.id) return null;
    return analysis;
  }

  function worstStatusFor(path) {
    var current = currentAnalysis();
    if (!current || !Array.isArray(current.hunks)) return '';
    var best = STATUS_ORDER.length;
    for (var i = 0; i < current.hunks.length; i += 1) {
      var hunk = current.hunks[i];
      if (!hunk || hunk.file !== path) continue;
      var rank = STATUS_ORDER.indexOf(hunk.status);
      if (rank >= 0 && rank < best) best = rank;
    }
    return best < STATUS_ORDER.length ? STATUS_ORDER[best] : '';
  }

  function scheduleAnalysis(delay) {
    if (analysisTimer !== null) clearTimeout(analysisTimer);
    analysisTimer = setTimeout(function () { analysisTimer = null; loadAnalysis(); }, delay);
  }

  /** Fetch the analysis for the loaded revision; keep polling while answers or the agent's order are outstanding. */
  function loadAnalysis() {
    var snap = snapshot();
    if (!snap || analysisLoading) return;
    analysisLoading = true;
    analysisFor = snap.id;
    api('GET', '/api/analysis', null).then(function (data) {
      analysis = data && typeof data === 'object' ? data : null;
    }, function () {
      analysis = { available: false, reason: 'The local analysis could not be read from the diffninja server.' };
    }).then(function () {
      analysisLoading = false;
      var place = readingPlace();
      renderAnalysis();
      renderDiff();
      keepReadingPlace(place);
      queueStationMark();
      var current = snapshot();
      if (!current) return;
      if (analysis && analysis.available === true && analysis.snapshotId !== current.id) { scheduleAnalysis(1000); return; }
      var pendingAnswers = analysis && analysis.available === true && analysis.questions && analysis.questions.answered < analysis.questions.total;
      var pendingOrder = analysis && analysis.available === true && !(analysis.order && analysis.order.source === 'agent');
      var pendingSuggestions = analysis && analysis.available === true && !analysis.suggestions;
      if (pendingAnswers || pendingOrder || pendingSuggestions) scheduleAnalysis(10000);
    });
  }

  function reportLink(url) {
    if (typeof url !== 'string' || !/^http:\\/\\/127\\.0\\.0\\.1:\\d+\\/report\\/[a-f0-9]{64}$/.test(url)) return null;
    var link = make('a', '', 'Open the full report (agenda, call flows, every hunk)');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    return link;
  }

  function answeredVerdicts(hunk) {
    var out = [];
    var questions = Array.isArray(hunk.questions) ? hunk.questions : [];
    for (var q = 0; q < questions.length; q += 1) {
      var question = questions[q];
      if (question && question.verdict && typeof question.verdict.label === 'string') out.push(question);
    }
    return out;
  }

  var STATUS_LABEL = { attention: 'Attention', uncertain: 'Uncertain', low: 'Low', passed: 'Passed' };

  /** A status as a small tinted label; the word is the text, the tint only repeats it. */
  function statusTag(status) {
    var known = STATUS_ORDER.indexOf(status) >= 0 ? status : 'uncertain';
    return make('span', 'status-tag status-' + known, STATUS_LABEL[known]);
  }

  /** A path with its directory muted, so the file name reads first. */
  function pathNode(path, className) {
    var node = make('span', 'path ' + (className || ''));
    var cut = String(path).lastIndexOf('/');
    if (cut >= 0) node.appendChild(make('span', 'path-dir', String(path).slice(0, cut + 1)));
    node.appendChild(make('span', 'path-base', cut >= 0 ? String(path).slice(cut + 1) : String(path)));
    return node;
  }

  function sizeNode(added, removed) {
    var size = make('span', 'size');
    size.appendChild(make('span', 'plus', '+' + String(added)));
    size.appendChild(make('span', 'minus', '−' + String(removed)));
    return size;
  }

  function gotoButton(path, line, side, label, className) {
    var go = make('button', className || 'btn btn-quiet', label);
    go.type = 'button';
    go.dataset.action = 'goto';
    go.dataset.path = String(path);
    go.dataset.line = String(line);
    go.dataset.side = side === 'LEFT' ? 'LEFT' : 'RIGHT';
    return go;
  }

  /** One station of the rail: where the change is and whether it asks for attention; what to look at lives beside the code. */
  function renderHunkEntry(hunk, rank) {
    var entry = make('li', 'order-item');
    entry.dataset.action = 'goto-stop';
    entry.dataset.rank = String(rank);
    entry.dataset.path = String(hunk.file);
    entry.dataset.line = String(hunk.line);
    entry.dataset.side = hunk.side === 'LEFT' ? 'LEFT' : 'RIGHT';
    entry.title = String(hunk.file) + ':' + String(hunk.line);
    entry.appendChild(make('span', 'order-rank', String(rank)));
    var main = make('div', 'order-main');
    var where = pathNode(hunk.file, 'order-path');
    where.appendChild(make('span', 'path-line', ':' + String(hunk.line)));
    main.appendChild(where);
    var meta = make('div', 'order-meta');
    // Only a status that asks for something is shown; low and passed stay quiet.
    if (hunk.status === 'attention' || hunk.status === 'uncertain') meta.appendChild(statusTag(hunk.status));
    meta.appendChild(sizeNode(hunk.added, hunk.removed));
    main.appendChild(meta);
    var jump = make('a', 'sr-only', 'Go to change ' + rank + ', ' + hunk.file + ' line ' + hunk.line);
    jump.href = '#diff-section';
    jump.dataset.action = 'goto-stop';
    jump.dataset.rank = entry.dataset.rank;
    main.appendChild(jump);
    entry.appendChild(main);
    return entry;
  }

  /**
   * What the agent says about one change and where to look, shown above its
   * code. A rank badge marks it when no stop header already carries the number.
   */
  function stopWhy(hunk, rank) {
    var verdicts = answeredVerdicts(hunk);
    var facts = Array.isArray(hunk.facts) ? hunk.facts : [];
    var note = typeof hunk.note === 'string' ? hunk.note : '';
    if (rank === 0 && verdicts.length === 0 && facts.length === 0 && note === '') return null;
    var why = make('div', 'stop-why' + (rank > 0 ? ' has-rank' : ''));
    if (rank > 0) {
      var badge = make('span', 'why-rank', String(rank));
      badge.setAttribute('aria-label', 'Change ' + rank + ' in the reading order');
      why.appendChild(badge);
    }
    var main = make('div', 'why-main');
    if (verdicts.length > 0) {
      var said = make('div', 'tag-row');
      said.appendChild(make('span', 'sr-only', 'Your agent says: '));
      for (var v = 0; v < verdicts.length; v += 1) {
        var tag = make('span', 'tag tone-' + String(verdicts[v].verdict.tone), String(verdicts[v].verdict.label));
        tag.title = String(verdicts[v].text);
        said.appendChild(tag);
      }
      main.appendChild(said);
    }
    if (facts.length > 0) {
      var tags = make('div', 'tag-row');
      tags.appendChild(make('span', 'tag-lead', 'Look at'));
      for (var f = 0; f < facts.length; f += 1) {
        var fact = facts[f];
        var chip;
        if (fact.at && typeof fact.at.line === 'number') {
          chip = gotoButton(hunk.file, fact.at.line, fact.at.side, '', 'fact');
          chip.appendChild(make('span', 'fact-name', String(fact.label)));
          chip.appendChild(make('span', 'fact-line', 'L' + String(fact.at.line)));
          chip.setAttribute('aria-label', String(fact.label) + ' on line ' + fact.at.line + ': ' + String(fact.text));
        } else {
          chip = make('span', 'fact');
          chip.appendChild(make('span', 'fact-name', String(fact.label)));
        }
        chip.title = String(fact.text);
        tags.appendChild(chip);
      }
      main.appendChild(tags);
    }
    if (note !== '') main.appendChild(make('p', 'why-note', note));
    why.appendChild(main);
    return why;
  }

  function renderAnalysisDetails(current) {
    el.detailsAnalysis.textContent = '';
    if (!current) return;
    el.detailsAnalysis.appendChild(make('h3', 'subhead', 'Local analysis'));
    var counts = current.counts || {};
    var parts = [];
    for (var c = 0; c < STATUS_ORDER.length; c += 1) parts.push(String(counts[STATUS_ORDER[c]] || 0) + ' ' + STATUS_ORDER[c]);
    el.detailsAnalysis.appendChild(make('p', '', 'Hunks by status: ' + parts.join(', ') + '. Statuses come from lexical facts on this machine; no model ran in diffninja.'));
    if (current.scope && typeof current.scope.note === 'string') el.detailsAnalysis.appendChild(make('p', 'note', current.scope.note));
    var link = reportLink(current.reportUrl);
    if (link) { var linkLine = make('p', ''); linkLine.appendChild(link); el.detailsAnalysis.appendChild(linkLine); }
    if (Array.isArray(current.agenda) && current.agenda.length > 0) {
      var agenda = make('ul', 'agenda-list');
      for (var a = 0; a < current.agenda.length; a += 1) {
        var li = make('li', '');
        li.appendChild(make('strong', '', String(current.agenda[a].title)));
        li.appendChild(make('span', 'note', ' ' + String(current.agenda[a].reason)));
        agenda.appendChild(li);
      }
      el.detailsAnalysis.appendChild(agenda);
    }
  }

  function renderAnalysis() {
    var snap = snapshot();
    show(el.analysisSection, Boolean(snap) && !(typeof snap.unavailableReason === 'string' && snap.unavailableReason !== ''));
    el.analysisBody.textContent = '';
    el.analysisActions.textContent = '';
    setText(el.analysisSub, '');
    renderAnalysisDetails(currentAnalysis());
    if (!snap) return;
    if (!analysis || analysisFor !== snap.id) {
      el.analysisBody.appendChild(make('p', 'note', 'Reading the changes\u2026'));
      if (!analysisLoading) loadAnalysis();
      return;
    }
    if (analysis.available !== true) {
      el.analysisBody.appendChild(make('p', 'note', typeof analysis.reason === 'string' ? analysis.reason : 'No analysis is available for this revision. Read the diff below.'));
      return;
    }
    if (analysis.snapshotId !== snap.id) {
      el.analysisBody.appendChild(make('p', 'note', 'The pull request changed; reading the new revision\u2026'));
      return;
    }
    var byAgent = analysis.order && analysis.order.source === 'agent';
    var total = analysis.questions ? analysis.questions.total : 0;
    var answered = analysis.questions ? analysis.questions.answered : 0;
    setText(el.analysisSub, (byAgent
      ? 'Most important first, as ' + String(analysis.order.orderedBy) + ' recommends. Tags are its answers.'
      : 'Waiting for your agent\u2019s order; this is diffninja\u2019s until it arrives.')
      + (total > 0 && answered < total ? ' ' + answered + ' of ' + total + ' answers in.' : ''));
    var flowFiles = Array.isArray(analysis.callFlowFiles) ? analysis.callFlowFiles : [];
    if (flowFiles.length > 0) {
      el.analysisActions.appendChild(flowButton('', flowFiles.length === 1 ? 'Call flow' : 'Call flows (' + flowFiles.length + ' files)', 'btn btn-sm'));
    } else if (analysis.scope && analysis.scope.source === 'patch' && typeof analysis.scope.note === 'string') {
      el.analysisBody.appendChild(make('p', 'inline-note', 'No call-flow diagrams: ' + analysis.scope.note.replace(/^Patch-only: /, '')));
    }
    if (!el.flowDrawer.hidden && flowSnapshot !== analysis.snapshotId) closeFlow();
    var list = make('ol', 'order-list');
    var hunks = Array.isArray(analysis.hunks) ? analysis.hunks : [];
    for (var h = 0; h < hunks.length; h += 1) list.appendChild(renderHunkEntry(hunks[h], h + 1));
    el.analysisBody.appendChild(list);
  }

  function gotoLine(node) {
    var path = node.getAttribute('data-path');
    var line = node.getAttribute('data-line');
    var side = node.getAttribute('data-side');
    var rows = el.diffBody.querySelectorAll('.diff-row');
    var target = null;
    for (var i = 0; i < rows.length; i += 1) {
      var row = rows[i];
      if (row.getAttribute('data-path') !== path) continue;
      if (row.getAttribute('data-line') === line && row.getAttribute('data-side') === side) { target = row; break; }
      if (target === null && row.getAttribute('data-line') === line) target = row;
    }
    if (target === null) return;
    var file = target.closest('details.file-block');
    if (file && !file.open) { file.open = true; closedFiles[path] = false; }
    // Land in the top quarter, above the line the reading-order spy measures from.
    window.scrollTo({ top: target.getBoundingClientRect().top + window.scrollY - window.innerHeight * 0.25 });
    target.classList.add('is-target');
    setTimeout(function () { target.classList.remove('is-target'); }, 2000);
    var action = target.querySelector('button');
    if (action) action.focus({ preventScroll: true });
  }

  /* -------------------------------------------------------- you are here -- */

  var spyQueued = false;

  /** The diff row a station points at, or null when that line is not shown. */
  function stationRow(station) {
    var selector = '.diff-row[data-path="' + CSS.escape(station.dataset.path || '') + '"][data-line="' + CSS.escape(station.dataset.line || '') + '"][data-side="' + CSS.escape(station.dataset.side || '') + '"]';
    return el.diffBody.querySelector(selector);
  }

  /** The rank of the last stop that has reached the window's reading line, or 0 above the first and once past the last. */
  function currentStopRank() {
    var sections = el.diffBody.querySelectorAll('.stop');
    // Near the top, so a short stop that was jumped to is the current one, not the next.
    var line = Math.min(window.innerHeight * 0.33, 160);
    var at = null;
    for (var i = 0; i < sections.length; i += 1) {
      if (sections[i].getBoundingClientRect().top > line) break;
      at = sections[i];
    }
    if (!at || (at === sections[sections.length - 1] && at.getBoundingClientRect().bottom <= line)) return 0;
    return Number(at.dataset.rank);
  }

  /**
   * By file, the station whose hunk the reader is looking at: the last hunk
   * whose first line has scrolled past the top third of the window. Stations
   * are in reading order, not file order, so every one is measured.
   */
  function currentFileRank(stations) {
    var line = window.innerHeight * 0.33;
    var rank = 0;
    var bestTop = -Infinity;
    for (var i = 0; i < stations.length; i += 1) {
      var row = stationRow(stations[i]);
      if (!row || row.offsetParent === null) continue;
      var top = row.getBoundingClientRect().top;
      if (top <= line && top > bestTop) { rank = Number(stations[i].dataset.rank); bestTop = top; }
    }
    return rank;
  }

  /** The stop a rank is read in: its own, or the one whose hunk already holds its line. */
  function stopOf(rank) {
    for (var i = 0; i < stopsNow.length; i += 1) {
      for (var h = 0; h < stopsNow[i].hunks.length; h += 1) {
        if (stopsNow[i].hunks[h].rank === rank) return stopsNow[i];
      }
    }
    return null;
  }

  /**
   * Mark where the reader is on the rail and what they have read. In the
   * reading order the stops run 1, 2, 3 down the page, so the rail's list
   * follows each new one; by file the stations of one file sit far apart in the
   * reading order, so the list stays where the reader put it.
   */
  function markCurrentStation() {
    spyQueued = false;
    fitRail();
    var snap = snapshot();
    if (snap && seenFor !== snap.id) { seenFor = snap.id; seenRanks = Object.create(null); }
    var stations = el.analysisBody.querySelectorAll('.order-item');
    var guided = el.diffBody.querySelector('.stop') !== null;
    currentRank = guided ? currentStopRank() : currentFileRank(stations);
    // Every change read in the current stop is current, and read.
    var here = Object.create(null);
    var stop = guided ? stopOf(currentRank) : null;
    if (stop) {
      for (var h = 0; h < stop.hunks.length; h += 1) here[stop.hunks[h].rank] = true;
    } else if (currentRank > 0) here[currentRank] = true;
    for (var seen in here) seenRanks[seen] = true;
    var current = null;
    for (var j = 0; j < stations.length; j += 1) {
      var rank = Number(stations[j].dataset.rank);
      var on = here[rank] === true;
      if (rank === currentRank) current = stations[j];
      stations[j].classList.toggle('is-current', on);
      stations[j].classList.toggle('is-seen', seenRanks[rank] === true);
      if (on) stations[j].setAttribute('aria-current', 'step');
      else stations[j].removeAttribute('aria-current');
    }
    show(el.railProgress, stations.length > 0);
    setText(el.railAt, currentRank > 0 ? 'Change ' + currentRank + ' of ' + stations.length : stations.length + (stations.length === 1 ? ' change' : ' changes') + ' to read');
    // Only a new current change moves the list, so a list the reader scrolled stays put while they read on.
    if (guided && current && currentRank !== followedRank) {
      followedRank = currentRank;
      var list = el.analysisBody;
      var box = current.getBoundingClientRect();
      var frame = list.getBoundingClientRect();
      if (box.top < frame.top) list.scrollTop -= frame.top - box.top + 8;
      else if (box.bottom > frame.bottom) list.scrollTop += box.bottom - frame.bottom + 8;
    }
  }

  /** Keep the whole rail, its finish button included, inside the window before it pins below the masthead. */
  function fitRail() {
    var rail = el.analysisSection;
    if (rail.hidden) return;
    if (window.getComputedStyle(rail).position !== 'sticky') { rail.style.maxHeight = ''; return; }
    var top = Math.max(16, rail.getBoundingClientRect().top);
    rail.style.maxHeight = Math.max(240, window.innerHeight - top - 16) + 'px';
  }

  function queueStationMark() {
    if (spyQueued) return;
    spyQueued = true;
    window.requestAnimationFrame(markCurrentStation);
  }

  /** Bring a change into view: its stop in the reading order, or its first line by file. */
  function gotoStop(rank) {
    var stop = stopOf(rank);
    var section = stop ? byId('stop-' + stop.rank) : null;
    if (section) {
      window.scrollTo({ top: section.getBoundingClientRect().top + window.scrollY - 12 });
      currentRank = stop.rank;
      var head = section.querySelector('.stop-head');
      if (head) head.focus({ preventScroll: true });
      queueStationMark();
      return;
    }
    var entry = el.analysisBody.querySelector('.order-item[data-rank="' + rank + '"]');
    if (!entry) return;
    gotoLine(entry);
    currentRank = rank;
    queueStationMark();
  }

  /** j and k step through the changes in reading order, from wherever the reader is. */
  function onStepKey(event_) {
    if (event_.defaultPrevented || event_.metaKey || event_.ctrlKey || event_.altKey) return;
    if (event_.key !== 'j' && event_.key !== 'k') return;
    var target = event_.target;
    if (target && target.closest && target.closest('input, textarea, select, [contenteditable]')) return;
    if (!el.flowDrawer.hidden) return;
    var ranks = [];
    if (el.diffBody.querySelector('.stop') !== null) {
      for (var i = 0; i < stopsNow.length; i += 1) ranks.push(stopsNow[i].rank);
    } else {
      var stations = el.analysisBody.querySelectorAll('.order-item');
      for (var s = 0; s < stations.length; s += 1) if (stationRow(stations[s])) ranks.push(Number(stations[s].dataset.rank));
    }
    var next = 0;
    for (var r = 0; r < ranks.length; r += 1) {
      if (event_.key === 'j' && ranks[r] > currentRank) { next = ranks[r]; break; }
      if (event_.key === 'k' && ranks[r] < currentRank) next = ranks[r];
    }
    if (next === 0) return;
    event_.preventDefault();
    gotoStop(next);
  }

  function readView() {
    try { return window.localStorage.getItem(VIEW_KEY) === 'file' ? 'file' : 'guided'; } catch (error) { return 'guided'; }
  }

  /** Switch the diff's layout and land on the change the reader was at. */
  function setView(next) {
    if ((next !== 'guided' && next !== 'file') || next === view) return;
    var rank = currentRank;
    view = next;
    try { window.localStorage.setItem(VIEW_KEY, next); } catch (error) { /* the choice lasts this page only */ }
    renderDiff();
    if (rank > 0) gotoStop(rank);
    else if (el.diffSection.getBoundingClientRect().top < 0) el.diffSection.scrollIntoView({ block: 'start' });
    queueStationMark();
  }

  /** Where the reader is in the reading order, to keep them there when the stops are rebuilt in a new order. */
  function readingPlace() {
    var section = currentRank > 0 && stopOf(currentRank) ? byId('stop-' + stopOf(currentRank).rank) : null;
    return section ? { hunk: section.dataset.hunk, top: section.getBoundingClientRect().top } : null;
  }

  function keepReadingPlace(place) {
    if (!place) return;
    var sections = el.diffBody.querySelectorAll('.stop');
    for (var i = 0; i < sections.length; i += 1) {
      if (sections[i].dataset.hunk !== place.hunk) continue;
      var drift = sections[i].getBoundingClientRect().top - place.top;
      if (drift !== 0) window.scrollBy(0, drift);
      return;
    }
  }

  /* ----------------------------------------------------------- highlight -- */

  var C_KEYWORDS = 'abstract as async await break case catch chan class const continue crate debugger declare default defer delete do else enum export extends false final finally fn for from func function go if impl implements import in instanceof interface is let loop map match mod mut namespace new nil null of package private protected pub public readonly ref return select self static struct super switch this throw trait true try type typeof undefined unsafe use var void where while with yield';
  var HASH_KEYWORDS = 'and as assert async await begin break case class continue def del do elif else elsif end ensure esac except export fi finally for from function global if import in is lambda local module next nil None nonlocal not or pass raise require rescue return self then True False unless until when while with yield';
  var SQL_KEYWORDS = 'add all alter and as asc begin between by case commit create delete desc distinct drop else end exists false from group having if in index inner insert into is join key left like limit not null offset on or order outer primary references returning right rollback select set table then true union unique update using values when where with';
  var LANGUAGES = {
    c: { line: ['//'], block: true, quotes: '"\\'\`', words: C_KEYWORDS },
    hash: { line: ['#'], block: false, quotes: '"\\'', words: HASH_KEYWORDS },
    sql: { line: ['--'], block: true, quotes: '\\'"', words: SQL_KEYWORDS, caseless: true },
    json: { line: [], block: false, quotes: '"', words: 'true false null' },
    css: { line: [], block: true, quotes: '"\\'', words: 'important' }
  };
  var EXTENSIONS = {
    c: 'js jsx ts tsx mjs cjs mts cts java kt kts scala swift go rs c h cc cpp hpp cs php dart groovy gradle',
    hash: 'py rb sh bash zsh fish yml yaml toml pl r ex exs cfg conf ini ps1 psm1 dockerfile makefile',
    sql: 'sql',
    json: 'json jsonc',
    css: 'css scss less'
  };
  var languageByExtension = {};
  Object.keys(EXTENSIONS).forEach(function (name) {
    EXTENSIONS[name].split(' ').forEach(function (ext) { languageByExtension[ext] = name; });
  });

  function languageOf(path) {
    var base = String(path).split('/').pop().toLowerCase();
    if (base === 'dockerfile' || base === 'makefile') return LANGUAGES.hash;
    var dot = base.lastIndexOf('.');
    var name = dot >= 0 ? languageByExtension[base.slice(dot + 1)] : undefined;
    return name ? LANGUAGES[name] : null;
  }

  function wordSet(language) {
    if (!language.set) {
      language.set = Object.create(null);
      language.words.split(' ').forEach(function (word) { language.set[language.caseless ? word.toLowerCase() : word] = true; });
    }
    return language.set;
  }

  /**
   * Split one line into [className, text] tokens. \`state.block\` carries an open
   * block comment and \`state.quote\` an open template string into the next line
   * of the same file. Text is only ever placed with textContent.
   */
  function tokenize(text, language, state) {
    var out = [];
    var i = 0;
    var plain = '';
    function flush() { if (plain !== '') { out.push(['', plain]); plain = ''; } }
    function push(cls, value) { flush(); out.push([cls, value]); }
    var words = wordSet(language);
    while (i < text.length) {
      if (state.block) {
        var close = text.indexOf('*/', i);
        if (close < 0) { push('tok-c', text.slice(i)); return out; }
        push('tok-c', text.slice(i, close + 2)); i = close + 2; state.block = false; continue;
      }
      if (state.quote) {
        var q = state.quote;
        var j = i;
        while (j < text.length && text[j] !== q) j += text[j] === '\\\\' ? 2 : 1;
        if (j >= text.length) { push('tok-s', text.slice(i)); return out; }
        push('tok-s', text.slice(i, j + 1)); i = j + 1; state.quote = ''; continue;
      }
      var ch = text[i];
      var lineComment = false;
      for (var l = 0; l < language.line.length; l += 1) {
        if (text.startsWith(language.line[l], i)) { lineComment = true; break; }
      }
      if (lineComment) { push('tok-c', text.slice(i)); return out; }
      if (language.block && text.startsWith('/*', i)) { state.block = true; continue; }
      if (language.quotes.indexOf(ch) >= 0) {
        var k = i + 1;
        while (k < text.length && text[k] !== ch) k += text[k] === '\\\\' ? 2 : 1;
        if (k >= text.length) {
          if (ch === '\`') { push('tok-s', text.slice(i)); state.quote = '\`'; return out; }
          push('tok-s', text.slice(i)); return out;
        }
        var literal = text.slice(i, k + 1);
        var rest = text.slice(k + 1);
        push(language === LANGUAGES.json && /^\\s*:/.test(rest) ? 'tok-p' : 'tok-s', literal);
        i = k + 1; continue;
      }
      if (/[0-9]/.test(ch) && !/[A-Za-z0-9_$]/.test(text[i - 1] || '')) {
        var num = /^(0x[0-9a-fA-F_]+|[0-9][0-9_]*(\\.[0-9_]+)?([eE][+-]?[0-9]+)?[a-zA-Z]*)/.exec(text.slice(i));
        push('tok-n', num[0]); i += num[0].length; continue;
      }
      if (/[A-Za-z_$@]/.test(ch)) {
        var word = /^[A-Za-z_$@][A-Za-z0-9_$]*/.exec(text.slice(i))[0];
        var after = text.slice(i + word.length);
        var key = language.caseless ? word.toLowerCase() : word;
        if (words[key]) push('tok-k', word);
        else if (/^\\s*\\(/.test(after)) push('tok-f', word);
        else if (/^[A-Z][a-z0-9]/.test(word) && language !== LANGUAGES.sql) push('tok-t', word);
        else plain += word;
        i += word.length; continue;
      }
      plain += ch; i += 1;
    }
    flush();
    return out;
  }

  function codeNode(text, language, state) {
    var code = make('code', 'diff-code');
    if (!language || text.length > 2000) { code.textContent = text; return code; }
    var tokens = tokenize(text, language, state);
    for (var t = 0; t < tokens.length; t += 1) {
      if (tokens[t][0] === '') code.appendChild(document.createTextNode(tokens[t][1]));
      else code.appendChild(make('span', tokens[t][0], tokens[t][1]));
    }
    return code;
  }

  /* ---------------------------------------------------------------- diff -- */

  /* ------------------------------------------------------------ call flow -- */

  function hasCallFlow(path) {
    var current = currentAnalysis();
    return Boolean(current && Array.isArray(current.callFlowFiles) && current.callFlowFiles.indexOf(path) >= 0);
  }

  function flowButton(path, label, className) {
    var button = make('button', className || 'btn btn-quiet', label);
    button.type = 'button';
    button.dataset.action = 'open-flow';
    if (path !== '') button.dataset.path = path;
    button.setAttribute('aria-label', path === '' ? 'Open the call flows of every changed file' : 'Open the call flow of ' + path);
    return button;
  }

  /** Show the call flow of one file, or of every file for an empty path, in the drawer beside the diff. */
  function openFlow(path, opener) {
    var current = currentAnalysis();
    if (!current) return;
    var src = '/flow?snapshot=' + encodeURIComponent(current.snapshotId) + (path === '' ? '' : '&file=' + encodeURIComponent(path));
    if (el.flowFrame.getAttribute('src') !== src) el.flowFrame.setAttribute('src', src);
    flowSnapshot = current.snapshotId;
    setText(el.flowTitle, path === '' ? 'Call flows' : 'Call flow: ' + path);
    el.flowFrame.title = path === '' ? 'Call flows of every changed file' : 'Call flow of ' + path;
    if (el.flowDrawer.hidden) flowReturn = opener || document.activeElement;
    show(el.flowDrawer, true);
    document.body.classList.add('flow-open');
    el.flowClose.focus();
  }

  function closeFlow() {
    if (el.flowDrawer.hidden) return;
    show(el.flowDrawer, false);
    document.body.classList.remove('flow-open', 'flow-full');
    // The opener may have been re-rendered meanwhile: return to its replacement.
    var back = flowReturn && flowReturn.isConnected ? flowReturn : null;
    if (!back && flowReturn && flowReturn.dataset && flowReturn.dataset.action === 'open-flow') {
      back = document.querySelector(flowReturn.dataset.path
        ? '[data-action="open-flow"][data-path="' + CSS.escape(flowReturn.dataset.path) + '"]'
        : '[data-action="open-flow"]:not([data-path])');
    }
    if (back) back.focus();
    flowReturn = null;
  }

  /** The diagram in the drawer opened or closed: the drawer takes the whole window while it is open. */
  function onFlowMessage(event_) {
    if (event_.origin !== window.location.origin || event_.source !== el.flowFrame.contentWindow) return;
    var data = event_.data;
    if (!data || data.type !== 'diffninja-diagram') return;
    document.body.classList.toggle('flow-full', data.open === true);
  }

  function onFlowKey(event_) {
    // The diagram inside the drawer handles its own Escape first.
    if (event_.defaultPrevented) return;
    if (event_.key === 'Escape' && !el.flowDrawer.hidden) { event_.preventDefault(); closeFlow(); }
  }

  /* --------------------------------------------------------- suggestions -- */

  function anchorKeyOf(anchor) { return anchor.path + '|' + anchor.side + ':' + anchor.line; }

  function suggestionKey(snapId, suggestion) { return snapId + '|' + anchorKeyOf(suggestion) + '|' + suggestion.body; }

  function suggestedBy() {
    var current = currentAnalysis();
    return current && current.suggestions && typeof current.suggestions.suggestedBy === 'string' ? current.suggestions.suggestedBy : 'your agent';
  }

  /**
   * The agent's suggested comments on the loaded revision that the reviewer has
   * neither added nor dismissed. A suggestion is never part of the review until
   * a human adds it; one naming a line this revision lacks is not offered.
   */
  function openSuggestions() {
    var current = currentAnalysis();
    if (!current || !current.suggestions || !Array.isArray(current.suggestions.comments)) return [];
    var out = [];
    var list = current.suggestions.comments;
    for (var i = 0; i < list.length; i += 1) {
      var s = list[i];
      var shaped = s && typeof s === 'object' && typeof s.path === 'string' && typeof s.line === 'number'
        && (s.side === 'LEFT' || s.side === 'RIGHT') && typeof s.body === 'string' && s.body !== '';
      if (!shaped || !currentLine(s) || settled[suggestionKey(current.snapshotId, s)]) continue;
      out.push(s);
    }
    return out;
  }

  function suggestionAt(node) {
    var key = (node.getAttribute('data-path') || '') + '|' + node.getAttribute('data-side') + ':' + node.getAttribute('data-line');
    var open = openSuggestions();
    for (var i = 0; i < open.length; i += 1) {
      if (anchorKeyOf(open[i]) === key) return open[i];
    }
    return null;
  }

  /** Put a suggestion into the reviewer's draft: a new comment on its line, or appended to the comment already there. */
  function adoptSuggestion(suggestion) {
    var snap = snapshot();
    var current = currentAnalysis();
    if (!snap || !current) return;
    settled[suggestionKey(current.snapshotId, suggestion)] = true;
    var at = commentIndexAt(suggestion);
    if (at >= 0) {
      var existing = comments[at].body.trim();
      comments[at].body = existing === '' ? suggestion.body : existing + ' ' + suggestion.body;
      return;
    }
    commentSeq += 1;
    comments.push({
      id: 'c' + commentSeq,
      path: suggestion.path,
      line: suggestion.line,
      side: suggestion.side,
      body: suggestion.body,
      snapshotId: snap.id,
      needsRevalidation: false,
      suggestedBy: suggestedBy()
    });
  }

  function addSuggestion(node) {
    if (composeDisabled()) return;
    var suggestion = suggestionAt(node);
    if (!suggestion) return;
    adoptSuggestion(suggestion);
    saveDraft();
    render();
  }

  function addAllSuggestions() {
    if (composeDisabled()) return;
    var open = openSuggestions();
    for (var i = 0; i < open.length; i += 1) adoptSuggestion(open[i]);
    saveDraft();
    render();
  }

  function dismissSuggestion(node) {
    var suggestion = suggestionAt(node);
    var current = currentAnalysis();
    if (!suggestion || !current) return;
    settled[suggestionKey(current.snapshotId, suggestion)] = true;
    saveDraft();
    render();
  }

  function suggestionRow(suggestion, disabled) {
    var wrap = make('div', 'suggestion');
    var head = make('p', 'suggestion-by');
    head.appendChild(make('span', 'agent-dot', ''));
    head.appendChild(make('strong', '', suggestedBy()));
    head.appendChild(document.createTextNode(' suggests'));
    wrap.appendChild(head);
    wrap.appendChild(make('p', 'suggestion-body', suggestion.body));
    var actions = make('div', 'suggestion-actions');
    var add = make('button', 'btn btn-primary btn-sm', 'Add to review');
    add.type = 'button';
    add.dataset.action = 'add-suggestion';
    add.dataset.path = suggestion.path;
    add.dataset.line = String(suggestion.line);
    add.dataset.side = suggestion.side;
    add.disabled = disabled;
    add.setAttribute('aria-label', 'Add the suggested comment on line ' + suggestion.line + ' of ' + suggestion.path + ' to your review');
    var dismiss = make('button', 'btn btn-quiet btn-sm', 'Dismiss');
    dismiss.type = 'button';
    dismiss.dataset.action = 'dismiss-suggestion';
    dismiss.dataset.path = suggestion.path;
    dismiss.dataset.line = String(suggestion.line);
    dismiss.dataset.side = suggestion.side;
    dismiss.setAttribute('aria-label', 'Dismiss the suggested comment on line ' + suggestion.line + ' of ' + suggestion.path);
    actions.appendChild(add);
    actions.appendChild(dismiss);
    wrap.appendChild(actions);
    return wrap;
  }

  /** The bar above the diff: add every open suggestion at once, or where the added ones went. */
  function suggestionBar(open, disabled) {
    var adopted = 0;
    for (var i = 0; i < comments.length; i += 1) {
      if (comments[i].suggestedBy && !comments[i].needsRevalidation) adopted += 1;
    }
    if (open.length === 0 && adopted === 0) return null;
    var bar = make('div', 'suggest-bar');
    if (open.length > 0) {
      var said = make('p', '');
      said.appendChild(make('span', 'agent-dot', ''));
      said.appendChild(make('strong', '', suggestedBy()));
      said.appendChild(document.createTextNode(' suggested ' + open.length + (open.length === 1 ? ' comment' : ' comments')
        + ' on the lines below. Nothing is posted until you submit.'));
      bar.appendChild(said);
      var all = make('button', 'btn btn-primary btn-sm', open.length === 1 ? 'Add it to review' : 'Add all ' + open.length);
      all.type = 'button';
      all.dataset.action = 'add-all-suggestions';
      all.disabled = disabled;
      bar.appendChild(all);
    } else {
      bar.appendChild(make('p', '', adopted === 1
        ? '1 suggested comment is in your draft. Read it over, then check and submit below.'
        : adopted + ' suggested comments are in your draft. Read them over, then check and submit below.'));
      var go = make('a', 'bar-link', 'Review and submit \u2193');
      go.href = '#compose-heading';
      bar.appendChild(go);
    }
    return bar;
  }

  function readingRank() {
    var rank = Object.create(null);
    var current = currentAnalysis();
    var hunks = current && Array.isArray(current.hunks) ? current.hunks : [];
    for (var h = 0; h < hunks.length; h += 1) {
      if (hunks[h] && !(hunks[h].file in rank)) rank[hunks[h].file] = h;
    }
    return rank;
  }

  /**
   * Split one file's diff lines into its hunks: a new-side line that does not
   * follow the previous one starts another, together with any removed lines
   * right before it.
   */
  function segmentsOf(path, fileLines) {
    var segments = [];
    var current = [];
    var lastNew = 0;
    for (var i = 0; i < fileLines.length; i += 1) {
      var line = fileLines[i];
      if (line.side === 'RIGHT') {
        if (lastNew > 0 && line.line > lastNew + 1) {
          var cut = current.length;
          while (cut > 0 && current[cut - 1].kind === 'delete') cut -= 1;
          if (cut > 0) { segments.push({ path: path, lines: current.slice(0, cut), stop: null }); current = current.slice(cut); }
        }
        lastNew = line.line;
      }
      current.push(line);
    }
    if (current.length > 0) segments.push({ path: path, lines: current, stop: null });
    return segments;
  }

  /**
   * The stops of the reading order: each ranked hunk with the diff segment its
   * first line is in. A hunk whose line shares a segment with a higher-ranked
   * one is read in that stop; one whose line is not in the diff has no stop.
   */
  function readingStops(groups) {
    var current = currentAnalysis();
    var hunks = current && Array.isArray(current.hunks) ? current.hunks : [];
    var where = Object.create(null);
    for (var g = 0; g < groups.length; g += 1) {
      for (var s = 0; s < groups[g].segments.length; s += 1) {
        var segment = groups[g].segments[s];
        for (var l = 0; l < segment.lines.length; l += 1) {
          var key = anchorKeyOf(segment.lines[l]);
          if (!(key in where)) where[key] = segment;
        }
      }
    }
    var stops = [];
    for (var h = 0; h < hunks.length; h += 1) {
      var hunk = hunks[h];
      if (!hunk) continue;
      var at = where[anchorKeyOf({ path: String(hunk.file), side: hunk.side === 'LEFT' ? 'LEFT' : 'RIGHT', line: hunk.line })];
      if (!at) continue;
      if (at.stop) { at.stop.hunks.push({ hunk: hunk, rank: h + 1 }); continue; }
      at.stop = { rank: h + 1, path: at.path, segment: at, hunks: [{ hunk: hunk, rank: h + 1 }] };
      stops.push(at.stop);
    }
    return stops;
  }

  function diffSubText(guided, hasStops) {
    if (state && state.receipt && typeof state.receipt === 'object') return 'This review is posted. Read the diff here; replies and new reviews happen on GitHub.';
    var how = 'Hover a line and press + to comment. Comments stay in this tab until you submit.';
    if (!hasStops) return how;
    return (guided ? 'Each change in the order to read it. ' : 'File by file. ') + how;
  }

  function renderDiff() {
    var snap = snapshot();
    show(el.diffSection, Boolean(snap));
    el.diffBody.textContent = '';
    stopsNow = [];
    show(el.viewSwitch, false);
    setText(el.diffSub, diffSubText(false, false));
    if (!snap) return;
    if (typeof snap.unavailableReason === 'string' && snap.unavailableReason !== '') {
      el.diffBody.appendChild(make('p', 'empty', snap.unavailableReason));
      return;
    }
    var list = lines();
    if (list.length === 0) {
      el.diffBody.appendChild(make('p', 'empty', 'No reviewable diff lines were returned for this revision.'));
      return;
    }
    var groups = [];
    var index = Object.create(null);
    for (var i = 0; i < list.length; i += 1) {
      var line = list[i];
      var group = index[line.path];
      if (!group) { group = { path: line.path, lines: [], order: groups.length }; index[line.path] = group; groups.push(group); }
      group.lines.push(line);
    }
    var rank = readingRank();
    groups.sort(function (a, b) {
      var ra = a.path in rank ? rank[a.path] : Infinity;
      var rb = b.path in rank ? rank[b.path] : Infinity;
      return ra === rb ? a.order - b.order : ra - rb;
    });
    for (var s = 0; s < groups.length; s += 1) groups[s].segments = segmentsOf(groups[s].path, groups[s].lines);
    stopsNow = readingStops(groups);
    var guided = stopsNow.length > 0 && view === 'guided';
    show(el.viewSwitch, stopsNow.length > 0);
    var switches = el.viewSwitch.querySelectorAll('button');
    for (var w = 0; w < switches.length; w += 1) switches[w].setAttribute('aria-pressed', String(switches[w].dataset.view === (guided ? 'guided' : 'file')));
    setText(el.diffSub, diffSubText(guided, stopsNow.length > 0));
    var disabled = composeDisabled();
    var open = openSuggestions();
    var bar = suggestionBar(open, disabled);
    if (bar) el.diffBody.appendChild(bar);
    var suggestions = Object.create(null);
    for (var o = 0; o < open.length; o += 1) suggestions[anchorKeyOf(open[o])] = open[o];
    if (!guided) {
      for (var g = 0; g < groups.length; g += 1) el.diffBody.appendChild(renderFileBlock(groups[g], groups[g].segments, disabled, suggestions, true));
      return;
    }
    for (var k = 0; k < stopsNow.length; k += 1) {
      el.diffBody.appendChild(renderStop(stopsNow[k], k > 0 ? stopsNow[k - 1].path : '', disabled, suggestions));
    }
    var rest = [];
    for (var r = 0; r < groups.length; r += 1) {
      var unranked = groups[r].segments.filter(function (segment) { return !segment.stop; });
      if (unranked.length > 0) rest.push({ group: groups[r], segments: unranked });
    }
    if (rest.length === 0) return;
    var head = make('div', 'rest-head');
    head.appendChild(make('h3', '', 'Other changes'));
    head.appendChild(make('p', '', 'Not in the reading order. File by file.'));
    el.diffBody.appendChild(head);
    for (var t = 0; t < rest.length; t += 1) el.diffBody.appendChild(renderFileBlock(rest[t].group, rest[t].segments, disabled, suggestions, false));
  }

  function sizeOf(segments) {
    var added = 0;
    var removed = 0;
    for (var s = 0; s < segments.length; s += 1) {
      for (var i = 0; i < segments[s].lines.length; i += 1) {
        if (segments[s].lines[i].kind === 'add') added += 1;
        else if (segments[s].lines[i].kind === 'delete') removed += 1;
      }
    }
    return sizeNode(added, removed);
  }

  function gapNode(count) {
    var gap = make('div', 'diff-gap');
    gap.appendChild(make('span', 'diff-gap-mark', '⋯'));
    gap.appendChild(make('span', 'diff-gap-text', count + ' unchanged ' + (count === 1 ? 'line' : 'lines')));
    return gap;
  }

  /** One change in the reading order: its number and place, what to look at, then its code. */
  function renderStop(stop, previousPath, disabled, suggestions) {
    var lead = stop.hunks[0].hunk;
    var section = make('section', 'stop');
    section.id = 'stop-' + stop.rank;
    section.dataset.rank = String(stop.rank);
    section.dataset.hunk = String(lead.id);
    section.setAttribute('aria-label', 'Change ' + stop.rank + ', ' + stop.path);
    var head = make('div', 'stop-head');
    head.tabIndex = -1;
    head.appendChild(make('span', 'stop-rank', String(stop.rank)));
    // The directory repeats nothing new when the change before was in the same file.
    var where = pathNode(stop.path, 'file-path' + (stop.path === previousPath ? ' is-same-file' : ''));
    where.appendChild(make('span', 'path-line', ':' + String(lead.line)));
    head.appendChild(where);
    head.appendChild(sizeOf([stop.segment]));
    if (lead.status === 'attention' || lead.status === 'uncertain') head.appendChild(statusTag(lead.status));
    var tools = make('span', 'file-tools');
    if (hasCallFlow(stop.path)) tools.appendChild(flowButton(stop.path, 'Call flow'));
    var inFile = make('button', 'btn btn-quiet', 'Show in file');
    inFile.type = 'button';
    inFile.dataset.action = 'show-in-file';
    inFile.dataset.path = stop.path;
    inFile.dataset.line = String(lead.line);
    inFile.dataset.side = lead.side === 'LEFT' ? 'LEFT' : 'RIGHT';
    inFile.setAttribute('aria-label', 'Show change ' + stop.rank + ' in the whole diff of ' + stop.path);
    tools.appendChild(inFile);
    head.appendChild(tools);
    section.appendChild(head);
    for (var h = 0; h < stop.hunks.length; h += 1) {
      var why = stopWhy(stop.hunks[h].hunk, h === 0 ? 0 : stop.hunks[h].rank);
      if (why) section.appendChild(why);
    }
    var rows = make('div', 'diff-rows');
    renderRows(rows, stop.segment.lines, languageOf(stop.path), disabled, suggestions);
    section.appendChild(rows);
    return section;
  }

  /** A file's diff, or the given hunks of it; with ranks on, each ranked hunk opens with its number and what to look at. */
  function renderFileBlock(group, segments, disabled, suggestions, ranks) {
    var block = make('details', 'file-block');
    block.dataset.path = group.path;
    block.open = closedFiles[group.path] !== true;
    block.addEventListener('toggle', function () { closedFiles[group.path] = !block.open; });
    var head = make('summary', 'file-head');
    head.appendChild(pathNode(group.path, 'file-path'));
    head.appendChild(sizeOf(segments));
    var worst = worstStatusFor(group.path);
    if (worst === 'attention' || worst === 'uncertain') head.appendChild(statusTag(worst));
    var tools = make('span', 'file-tools');
    if (hasCallFlow(group.path)) tools.appendChild(flowButton(group.path, 'Call flow'));
    head.appendChild(tools);
    block.appendChild(head);
    var rows = make('div', 'diff-rows');
    var language = languageOf(group.path);
    var lastNew = 0;
    for (var s = 0; s < segments.length; s += 1) {
      var segment = segments[s];
      var firstNew = 0;
      for (var f = 0; f < segment.lines.length && firstNew === 0; f += 1) if (segment.lines[f].side === 'RIGHT') firstNew = segment.lines[f].line;
      if (lastNew > 0 && firstNew > lastNew + 1) rows.appendChild(gapNode(firstNew - lastNew - 1));
      if (ranks && segment.stop) {
        for (var h = 0; h < segment.stop.hunks.length; h += 1) rows.appendChild(stopWhy(segment.stop.hunks[h].hunk, segment.stop.hunks[h].rank));
      }
      renderRows(rows, segment.lines, language, disabled, suggestions);
      for (var b = segment.lines.length - 1; b >= 0; b -= 1) if (segment.lines[b].side === 'RIGHT') { lastNew = segment.lines[b].line; break; }
    }
    block.appendChild(rows);
    return block;
  }

  /** Diff rows for consecutive lines, each with its + button, its draft comment and the agent's suggestion. */
  function renderRows(rows, segmentLines, language, disabled, suggestions) {
    var state = { block: false, quote: '' };
    var widest = Number(rows.style.getPropertyValue('--ln-digits')) || 1;
    for (var n = 0; n < segmentLines.length; n += 1) widest = Math.max(widest, String(segmentLines[n].line).length);
    rows.style.setProperty('--ln-digits', String(widest));
    for (var i = 0; i < segmentLines.length; i += 1) {
      var line = segmentLines[i];
      var row = make('div', 'diff-row kind-' + String(line.kind));
      row.dataset.path = line.path;
      row.dataset.line = String(line.line);
      row.dataset.side = line.side;
      var attached = commentIndexAt(line);
      var arming = reattachIndex >= 0;
      var gutter = make('span', 'diff-gutter');
      var action = make('button', 'diff-action' + (arming ? ' is-armed' : '') + (attached >= 0 ? ' has-comment' : ''), arming ? 'Attach' : '+');
      action.type = 'button';
      action.dataset.action = 'comment';
      action.dataset.path = line.path;
      action.dataset.line = String(line.line);
      action.dataset.side = line.side;
      action.disabled = disabled;
      action.setAttribute('aria-label', arming
        ? 'Attach the comment awaiting revalidation to line ' + line.line + ' of ' + line.path + ' (' + sideLabel(line.side) + ' side)'
        : (attached >= 0 ? 'Edit the comment on line ' : 'Comment on line ') + line.line + ' of ' + line.path + ' (' + sideLabel(line.side) + ' side)');
      gutter.appendChild(action);
      gutter.appendChild(make('span', 'diff-ln', line.line));
      row.appendChild(gutter);
      row.appendChild(make('span', 'diff-mark', line.kind === 'add' ? '+' : line.kind === 'delete' ? '−' : ' '));
      row.appendChild(codeNode(line.text, language, state));
      rows.appendChild(row);
      if (attached >= 0) rows.appendChild(editorRow(attached));
      var suggestion = suggestions[anchorKeyOf(line)];
      if (suggestion) rows.appendChild(suggestionRow(suggestion, disabled));
    }
  }

  function renderDraftList(disabled) {
    el.draftList.textContent = '';
    var anchored = [];
    for (var i = 0; i < comments.length; i += 1) {
      if (!comments[i].needsRevalidation) anchored.push(i);
    }
    setText(el.draftCount, comments.length === 0 ? 'No line comments yet.' : comments.length + ' line comment' + (comments.length === 1 ? '' : 's') + ' in your draft.');
    setText(el.railDraft, comments.length === 0 ? 'No comments yet' : comments.length + (comments.length === 1 ? ' comment' : ' comments') + ' in your draft');
    if (anchored.length === 0) {
      el.draftList.appendChild(make('p', 'empty', comments.length === 0
        ? 'Hover a line in the diff and press + to comment on it.'
        : 'No line comment is attached to the current revision yet. Every comment above needs revalidation.'));
      return;
    }
    var list = make('ul', 'draft-list');
    for (var a = 0; a < anchored.length; a += 1) {
      var index = anchored[a];
      var comment = comments[index];
      var item = make('li', 'draft-item');
      item.dataset.index = String(index);
      var head = make('div', 'draft-head');
      var where = pathNode(comment.path, 'draft-where');
      where.appendChild(make('span', 'path-line', ':' + comment.line + (comment.side === 'LEFT' ? ' (old)' : '')));
      head.appendChild(where);
      if (comment.suggestedBy) head.appendChild(make('span', 'tag tone-quiet', 'from ' + comment.suggestedBy));
      var edit = make('button', 'btn btn-quiet btn-sm', 'Edit');
      edit.type = 'button';
      edit.dataset.action = 'edit-comment';
      edit.dataset.index = String(index);
      edit.disabled = disabled;
      edit.setAttribute('aria-label', 'Edit the comment on ' + comment.path + ' line ' + comment.line);
      var remove = make('button', 'btn btn-quiet btn-sm', 'Remove');
      remove.type = 'button';
      remove.dataset.action = 'remove-comment';
      remove.dataset.index = String(index);
      remove.disabled = disabled;
      remove.setAttribute('aria-label', 'Remove the comment on ' + comment.path + ' line ' + comment.line);
      head.appendChild(edit);
      head.appendChild(remove);
      item.appendChild(head);
      var text = make('p', 'draft-body', comment.body === '' ? '(empty)' : comment.body);
      text.dataset.role = 'body';
      item.appendChild(text);
      list.appendChild(item);
    }
    el.draftList.appendChild(list);
  }

  /**
   * Comments carried over from another revision. Their text is shown with the
   * coordinate they were written against, even when the loaded diff has no such
   * line, and each one waits for the human to attach or confirm it. No comment
   * is dropped, and the loaded code for a still-existing coordinate is shown
   * next to the Confirm action so the choice is made against real text.
   */
  function renderRevalidateList() {
    var pending = [];
    for (var i = 0; i < comments.length; i += 1) {
      if (comments[i].needsRevalidation) pending.push(i);
    }
    if (pending.length === 0) reattachIndex = -1;
    else if (reattachIndex >= 0 && !comments[reattachIndex].needsRevalidation) reattachIndex = -1;
    show(el.revalidateSection, pending.length > 0);
    el.revalidateList.textContent = '';
    setText(el.revalidateNote, '');
    if (pending.length === 0) return;
    var locked = busy || submitting;
    setText(el.revalidateNote, pending.length === 1
      ? '1 line comment comes from an earlier revision of this pull request. The text is kept, but a line number is not proof of the same code, so preview and submit stay blocked until it is attached to a line below or confirmed against the code shown here.'
      : pending.length + ' line comments come from an earlier revision of this pull request. The text is kept, but a line number is not proof of the same code, so preview and submit stay blocked until each one is attached to a line below or confirmed against the code shown here.');
    var list = make('ul', 'draft-list');
    for (var p = 0; p < pending.length; p += 1) {
      var index = pending[p];
      var comment = comments[index];
      var line = currentLine(comment);
      var armed = reattachIndex === index;
      editorSeq += 1;
      var inputId = 'revalidate-comment-' + String(editorSeq);
      var hintId = inputId + '-hint';
      var item = make('li', 'editor revalidate-item' + (armed ? ' is-armed' : ''));
      item.dataset.index = String(index);
      var label = make('label', 'sr-only', 'Comment text awaiting revalidation, written for ' + comment.path + ' line ' + comment.line);
      label.setAttribute('for', inputId);
      item.appendChild(label);
      var where = make('p', 'hint revalidate-where', 'Written for ' + comment.path + ':' + comment.line + ' (' + sideLabel(comment.side) + ' side) in an earlier revision.');
      where.id = hintId;
      item.appendChild(where);
      var input = document.createElement('input');
      input.type = 'text';
      input.id = inputId;
      input.className = 'editor-input';
      input.dataset.index = String(index);
      input.value = comment.body;
      input.disabled = locked;
      input.setAttribute('aria-describedby', hintId);
      var field = make('div', 'editor-row');
      field.appendChild(input);
      item.appendChild(field);
      var actions = make('div', 'revalidate-actions');
      if (line) {
        item.appendChild(make('code', 'revalidate-code', line.text === '' ? '(blank line)' : line.text));
        var confirm = make('button', 'link-button', 'Confirm this line');
        confirm.type = 'button';
        confirm.dataset.action = 'confirm-comment';
        confirm.dataset.index = String(index);
        confirm.disabled = locked;
        confirm.setAttribute('aria-label', 'Confirm the comment against ' + comment.path + ' line ' + comment.line + ' in the current revision');
        actions.appendChild(confirm);
      } else {
        item.appendChild(make('p', 'hint', 'That line is not part of the loaded revision, so it cannot be confirmed. Attach the comment to a line in the diff instead.'));
      }
      var arm = make('button', 'link-button', armed ? 'Cancel attach' : 'Attach to a line');
      arm.type = 'button';
      arm.dataset.action = armed ? 'cancel-reattach' : 'reattach-comment';
      arm.dataset.index = String(index);
      arm.disabled = locked;
      arm.setAttribute('aria-label', armed
        ? 'Cancel attaching the comment for ' + comment.path + ' line ' + comment.line
        : 'Attach the comment for ' + comment.path + ' line ' + comment.line + ' to a line in the diff');
      actions.appendChild(arm);
      var remove = make('button', 'link-button', 'Remove');
      remove.type = 'button';
      remove.dataset.action = 'remove-comment';
      remove.dataset.index = String(index);
      remove.disabled = locked;
      remove.setAttribute('aria-label', 'Remove the comment written for ' + comment.path + ' line ' + comment.line);
      actions.appendChild(remove);
      item.appendChild(actions);
      if (armed) {
        item.appendChild(make('p', 'hint', 'Choose a line below: every Comment button now reads Attach.'));
      }
      list.appendChild(item);
    }
    el.revalidateList.appendChild(list);
  }

  function updateEventNote() {
    if (event === 'COMMENT') { show(el.eventNote, false); return; }
    show(el.eventNote, true);
    setText(el.eventNote, event === 'APPROVE'
      ? 'Approve submits a formal approving review to GitHub under the signed-in account shown above.'
      : 'Request changes submits a formal review that blocks merging on GitHub under the signed-in account shown above.');
  }

  function renderCompose() {
    if (!composerReady()) {
      show(el.composeSection, false);
      return;
    }
    show(el.composeSection, true);
    var disabled = composeDisabled();
    if (el.reviewBody.value !== body) el.reviewBody.value = body;
    el.reviewBody.disabled = disabled;
    for (var i = 0; i < el.eventInputs.length; i += 1) el.eventInputs[i].disabled = disabled;
    syncEventInputs();
    updateEventNote();
    show(el.anchorNotice, anchorNotice !== '');
    if (anchorNotice !== '') setText(el.anchorNotice, anchorNotice);
    renderRevalidateList();
    renderDraftList(disabled);
  }

  var EVENT_NAMES = { COMMENT: 'Comment', APPROVE: 'Approve', REQUEST_CHANGES: 'Request changes' };

  /** One line saying what the checked request will post. */
  function checkedSummary(payload) {
    var count = payload && Array.isArray(payload.comments) ? payload.comments.length : 0;
    var name = payload && EVENT_NAMES[payload.event] ? EVENT_NAMES[payload.event] : 'Review';
    return '\u2713 ' + name + (count > 0 ? ' with ' + count + (count === 1 ? ' line comment' : ' line comments') : '')
      + (payload && typeof payload.commit_id === 'string' ? ' on ' + shortSha(payload.commit_id) : '') + '.';
  }

  function updateActionState() {
    var hint = validationHint();
    var previewing = busyAction === 'preview';
    var posting = busyAction === 'submit' && submitting;
    el.submitButton.disabled = hint !== '' || posting;
    setText(el.submitButton, posting ? 'Submitting\u2026' : 'Submit review');
    el.submitButton.classList.toggle('is-loading', posting);
    el.submitButton.setAttribute('aria-busy', posting ? 'true' : 'false');
    setText(el.previewButton, previewing ? 'Checking\u2026' : 'Check the review');
    el.previewButton.classList.toggle('is-loading', previewing);
    el.previewButton.setAttribute('aria-busy', previewing ? 'true' : 'false');
    if (previewing) el.previewButton.disabled = true;
    var failed = lastError !== '' && !busy && !submitting;
    setText(el.submitHint, posting
      ? 'Posting your review to GitHub. This takes a few seconds; keep this tab open.'
      : failed && placeAnchor === el.submitButton
        ? 'Not submitted: ' + lastError
        : hint === '' ? 'Ready. Submit posts this review to GitHub; it cannot be undone from here.' : hint);
    el.submitHint.classList.toggle('is-error', failed && placeAnchor === el.submitButton);
    var stale = previewPayload !== null && previewSignature !== JSON.stringify(draftInput());
    setText(el.previewState, previewPayload === null
      ? ''
      : stale
        ? 'The draft changed since it was checked.'
        : checkedSummary(previewPayload));
    el.previewState.className = stale ? 'status is-stale' : previewPayload !== null ? 'status is-ok' : 'status';
    if (previewing) setText(el.previewState, 'Checking the draft against the pull request\u2026');
    else if (failed && placeAnchor === el.previewButton) {
      setText(el.previewState, 'Check failed: ' + lastError);
      el.previewState.className = 'status is-error';
    }
  }

  function renderPreview() {
    if (!composerReady()) {
      show(el.previewSection, false);
      return;
    }
    show(el.previewSection, true);
    el.previewButton.disabled = composeDisabled() || unvalidatedCount() > 0;
    setText(el.previewJson, previewPayload === null ? 'Nothing checked yet.' : JSON.stringify(previewPayload, null, 2));
  }

  function renderReceipt() {
    var receipt = state && state.receipt && typeof state.receipt === 'object' ? state.receipt : null;
    show(el.receiptSection, Boolean(receipt));
    el.receiptBody.textContent = '';
    // Once posted, the rail's footer points at the receipt, not at a draft that no longer exists.
    setText(el.railFinish, receipt ? 'See the receipt' : 'Finish review');
    el.railFinish.href = receipt ? '#receipt-heading' : '#compose-heading';
    if (!receipt) return;
    setText(el.railDraft, 'Review posted to GitHub');
    var dl = make('dl', 'facts');
    addFact(dl, 'Review id', typeof receipt.id === 'number' ? String(receipt.id) : 'unknown');
    addFact(dl, 'GitHub state', typeof receipt.state === 'string' ? receipt.state : 'unknown');
    addFact(dl, 'Reviewed commit', typeof receipt.commitId === 'string' ? receipt.commitId : 'unknown', true);
    addLinkFact(dl, 'On GitHub', receipt.url, typeof receipt.url === 'string' ? receipt.url : 'unknown');
    el.receiptBody.appendChild(dl);
    el.receiptBody.appendChild(make('p', 'note', 'GitHub recorded this review. This session has posted its one review: further loads, previews and submissions are refused, and Check GitHub state re-reads the recorded outcome. Start diffninja again to review another revision.'));
  }

  function renderMessage() {
    var status = state ? state.status : '';
    var message = state && typeof state.message === 'string' ? state.message : '';
    // On a ready snapshot the message is informational — a fork head, for
    // instance — so it never replaces the readiness line. Everywhere else the
    // status line carries it, and a failure's own text does too.
    var informational = status === 'ready' && message !== '' && lastError === '';
    show(el.messageNote, informational);
    setText(el.messageNote, informational ? message : '');
  }

  /**
   * Re-render without moving what the reviewer is looking at: the control they
   * last pressed stays where it was on screen, even when a status line or an
   * error box appears above it.
   */
  function render() {
    var anchor = placeAnchor && placeAnchor.isConnected && placeAnchor.offsetParent !== null ? placeAnchor : null;
    var before = anchor ? anchor.getBoundingClientRect().top : 0;
    renderAll();
    queueStationMark();
    if (revealReceipt && !el.receiptSection.hidden) {
      revealReceipt = false;
      el.receiptSection.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (!anchor || !anchor.isConnected || anchor.offsetParent === null) return;
    var drift = anchor.getBoundingClientRect().top - before;
    if (drift !== 0) window.scrollBy(0, drift);
  }

  function renderAll() {
    var snap = snapshot();
    var status = state ? state.status : '';
    var blocked = status === 'unknown' || status === 'submitting';
    setText(el.statusLine, statusMessage());
    show(el.statusLine, !(snap && status === 'ready' && !busy && !submitting && lastError === '' && !submitUncertain));
    document.body.classList.toggle('is-busy', busy || submitting);
    if (submitUncertain) {
      // The write's fate is unknown, so this box says only what is true and
      // points at the one action that can resolve it.
      setText(el.errorText, 'The submission request to the local diffninja server did not complete, so it is unknown whether GitHub recorded this review. Do not submit again. Use Check GitHub state to re-read what GitHub has; it settles the outcome.'
        + (serverError && lastError !== '' ? ' Last transport error: ' + lastError : ''));
    } else if (lastError !== '') setText(el.errorText, lastError);
    else if (status === 'unknown') setText(el.errorText, 'The last submission outcome is unknown: GitHub may or may not have recorded the review. Check the pull request on GitHub before submitting anything again.');
    else if (status === 'submitting') setText(el.errorText, 'A review submission is already in progress in this session. Check GitHub state to see how it ended.');
    else setText(el.errorText, 'The request failed.');
    show(el.errorBox, lastError !== '' || blocked || submitUncertain);
    show(el.refreshButton, serverError || blocked || submitUncertain);
    el.refreshButton.disabled = busy;
    el.loadButton.disabled = busy;
    el.prUrl.disabled = busy;
    show(el.emptyNote, !snap && !busy);
    renderIdentity();
    renderSnapshot();
    renderMessage();
    renderAnalysis();
    renderDiff();
    renderCompose();
    renderPreview();
    renderReceipt();
    updateActionState();
  }

  /* ------------------------------------------------------------ listeners -- */

  function onLoad(event_) {
    event_.preventDefault();
    if (busy) return;
    showLoad = false;
    var url = el.prUrl.value.trim();
    if (url === '') {
      lastError = 'Enter the pull request URL first.';
      serverError = false;
      render();
      return;
    }
    if (url.indexOf('https://github.com/') !== 0) {
      lastError = 'Enter a full https://github.com pull request URL.';
      serverError = false;
      render();
      return;
    }
    loadPullRequest(url);
  }

  function onClick(event_) {
    var target = event_.target;
    if (!target || !target.closest) return;
    var node = target.closest('[data-action]');
    if (!node) return;
    var action = node.getAttribute('data-action');
    placeAnchor = action === 'preview' || action === 'submit' || action === 'refresh' ? node : null;
    if (action === 'comment') { event_.preventDefault(); addComment(node); return; }
    if (action === 'open-flow') { event_.preventDefault(); openFlow(node.getAttribute('data-path') || '', node); return; }
    if (action === 'close-flow') { event_.preventDefault(); closeFlow(); return; }
    if (action === 'add-suggestion') { event_.preventDefault(); addSuggestion(node); return; }
    if (action === 'add-all-suggestions') { event_.preventDefault(); addAllSuggestions(); return; }
    if (action === 'dismiss-suggestion') { event_.preventDefault(); dismissSuggestion(node); return; }
    if (action === 'remove-comment') { event_.preventDefault(); removeComment(node); return; }
    if (action === 'edit-comment') { event_.preventDefault(); editComment(node); return; }
    if (action === 'confirm-comment') { event_.preventDefault(); confirmComment(node); return; }
    if (action === 'reattach-comment') { event_.preventDefault(); armComment(node); return; }
    if (action === 'cancel-reattach') { event_.preventDefault(); cancelReattach(); return; }
    if (action === 'preview') { event_.preventDefault(); previewReview(); return; }
    if (action === 'submit') { event_.preventDefault(); submitReview(); return; }
    if (action === 'refresh') { event_.preventDefault(); refreshState(); return; }
    if (action === 'goto') { event_.preventDefault(); gotoLine(node); return; }
    if (action === 'goto-stop') { event_.preventDefault(); gotoStop(Number(node.getAttribute('data-rank'))); return; }
    if (action === 'view') { event_.preventDefault(); setView(node.getAttribute('data-view') || ''); return; }
    if (action === 'show-in-file') { event_.preventDefault(); setView('file'); gotoLine(node); return; }
    if (action === 'show-load') { event_.preventDefault(); showLoad = true; render(); el.prUrl.focus(); return; }
  }

  function onChange(event_) {
    var target = event_.target;
    if (target && target.name === 'event') setEvent(target.value);
  }

  function onInput(event_) {
    var target = event_.target;
    if (!target) return;
    if (target === el.reviewBody) {
      body = target.value;
      saveDraft();
      updateActionState();
      return;
    }
    if (target.classList && target.classList.contains('editor-input')) {
      var index = Number(target.getAttribute('data-index'));
      if (!Number.isInteger(index) || index < 0 || index >= comments.length) return;
      comments[index].body = target.value;
      saveDraft();
      var mirror = document.querySelector('.draft-item[data-index="' + index + '"] [data-role="body"]');
      if (mirror) setText(mirror, target.value === '' ? '(empty)' : target.value);
      updateActionState();
    }
  }

  function initialise() {
    el.loadForm = byId('load-form');
    el.prUrl = byId('pr-url');
    el.loadButton = byId('load-button');
    el.statusLine = byId('status-line');
    el.emptyNote = byId('empty-note');
    el.errorBox = byId('error-box');
    el.errorText = byId('error-text');
    el.refreshButton = byId('refresh-button');
    el.pageTitle = byId('page-title');
    el.pageMeta = byId('page-meta');
    el.lede = byId('lede');
    el.loadSection = byId('load-section');
    el.detailsSection = byId('details-section');
    el.detailsAnalysis = byId('details-analysis');
    el.identitySection = byId('identity-section');
    el.identityBody = byId('identity-body');
    el.snapshotSection = byId('snapshot-section');
    el.snapshotBody = byId('snapshot-body');
    el.messageNote = byId('message-note');
    el.analysisSection = byId('analysis-section');
    el.analysisBody = byId('analysis-body');
    el.analysisSub = byId('analysis-sub');
    el.railDraft = byId('rail-draft');
    el.railFinish = byId('rail-finish');
    el.railProgress = byId('rail-progress');
    el.railAt = byId('rail-at');
    el.viewSwitch = byId('view-switch');
    view = readView();
    el.analysisActions = byId('analysis-actions');
    el.diffSub = byId('diff-sub');
    el.diffSection = byId('diff-section');
    el.diffBody = byId('diff-body');
    el.composeSection = byId('compose-section');
    el.draftCount = byId('draft-count');
    el.draftList = byId('draft-list');
    el.anchorNotice = byId('anchor-notice');
    el.revalidateSection = byId('revalidate-section');
    el.revalidateNote = byId('revalidate-note');
    el.revalidateList = byId('revalidate-list');
    el.eventNote = byId('event-note');
    el.reviewBody = byId('review-body');
    el.previewSection = byId('preview-section');
    el.previewButton = byId('preview-button');
    el.previewState = byId('preview-state');
    el.previewJson = byId('preview-json');
    el.submitButton = byId('submit-button');
    el.submitHint = byId('submit-hint');
    el.receiptSection = byId('receipt-section');
    el.receiptBody = byId('receipt-body');
    el.eventInputs = document.querySelectorAll('input[name="event"]');
    el.loadForm.addEventListener('submit', onLoad);
    el.flowDrawer = byId('flow-drawer');
    el.flowTitle = byId('flow-title');
    el.flowClose = byId('flow-close');
    el.flowFrame = byId('flow-frame');
    // Escape closes the drawer from inside the diagram too: it is served from this origin.
    el.flowFrame.addEventListener('load', function () {
      try { el.flowFrame.contentDocument.addEventListener('keydown', onFlowKey); } catch (error) { /* not ours to reach */ }
    });
    document.addEventListener('keydown', onFlowKey);
    document.addEventListener('keydown', onStepKey);
    window.addEventListener('message', onFlowMessage);
    window.addEventListener('scroll', queueStationMark, { passive: true });
    window.addEventListener('resize', queueStationMark);
    document.addEventListener('click', onClick);
    document.addEventListener('change', onChange);
    document.addEventListener('input', onInput);
    run(function () {
      return api('GET', '/api/state', null).then(function (data) { setState(data); });
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialise);
  else initialise();
}());
`;
}

const STYLES = `
${PALETTE_STYLES}
*, *::before, *::after { box-sizing: border-box; }
/* Class rules below set display, which would otherwise beat the UA's hidden
   rule and leave every collapsed panel visible. */
[hidden] { display: none !important; }
/* File headers stay pinned to the top while the diff scrolls. Anything scrolled
   into view (a jump, a focused control, a reattached comment) must land below
   one, or a click meant for it hits the header and folds the file. */
html { -webkit-text-size-adjust: 100%; max-width: 100%; scroll-padding-top: 56px; }
body {
  margin: 0; background: var(--bg); color: var(--ink);
  font: 400 14px/1.5 var(--sans); max-width: 100%; overflow-wrap: break-word;
  -webkit-font-smoothing: antialiased;
}
.wrap {
  max-width: 1480px; margin: 0 auto; padding: 0 24px 64px;
  display: grid; grid-template-columns: minmax(0, 1fr); column-gap: 28px; align-items: start;
}
.wrap:has(> #analysis-section:not([hidden])) { grid-template-columns: minmax(280px, 340px) minmax(0, 1fr); }
.wrap > * { grid-column: -2; min-width: 0; }
.wrap > .masthead { grid-column: 1 / -1; }
h1, h2, h3, h4 { margin: 0; line-height: 1.3; }
h1 { font-size: 28px; line-height: 1.2; font-weight: 650; letter-spacing: -0.02em; overflow-wrap: anywhere; max-width: 36em; }
h2 { font-size: 14px; font-weight: 600; }
h3.subhead { font-size: 12px; font-weight: 600; color: var(--ink-soft); margin-top: 4px; }
p { margin: 0; }
a { color: var(--accent); text-decoration: none; overflow-wrap: anywhere; }
a:hover { text-decoration: underline; }
.mono, code, .payload { font-family: var(--mono); }
.note, .hint, .count, .status { font-size: 12px; color: var(--ink-soft); }
.lede { font-size: 14px; color: var(--ink-soft); }
.status { overflow-wrap: anywhere; }
.status.is-stale { color: var(--warn); }
.status.is-ok { color: var(--ok); }
.is-error { color: var(--alarm) !important; }
.sr-only {
  position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0;
  overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0;
}
:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; border-radius: 4px; }
:focus:not(:focus-visible) { outline: none; }

/* ---------------------------------------------------------------- header */
.masthead { display: flex; flex-direction: column; gap: 10px; padding: 18px 0 22px; margin-bottom: 20px; border-bottom: 1px solid var(--line); }
.brand { display: flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 650; letter-spacing: -0.01em; color: var(--ink); }
${BRAND_MARK_STYLES}
.brand .brand-mark { width: 20px; height: 20px; }
.page-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; font-size: 13px; color: var(--ink-soft); }
.page-meta a { font-weight: 600; }
.meta-item.sha { font: 12px var(--mono); padding: 2px 7px; border-radius: 6px; background: var(--neutral-soft); color: var(--ink); }
.state-badge {
  display: inline-flex; align-items: center; height: 24px; padding: 0 10px; border-radius: 999px;
  font-size: 12px; font-weight: 600; color: #fff; background: var(--ink-faint);
}
.state-badge.state-open { background: #2f8f4e; }
.state-badge.state-merged { background: #8250df; }
.state-badge.state-closed { background: var(--del-ink); }
#message-note { font-size: 12px; color: var(--ink-faint); }

/* ----------------------------------------------------------------- cards */
.panel {
  border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel);
  padding: 16px; margin: 0 0 20px; box-shadow: var(--shadow);
  display: flex; flex-direction: column; gap: 12px; min-width: 0;
}
.panel.card { padding: 0; gap: 0; overflow: hidden; }
/* The diff is the page's main surface: file blocks are its only frames. */
#diff-section { background: none; border: 0; box-shadow: none; overflow: visible; }
#diff-section > .card-head { background: none; border: 0; padding: 0 0 12px; }
#diff-section > .card-head h2 { font-size: 16px; font-weight: 650; }
#diff-section > .card-body { padding: 0; }
.card-head {
  display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px 16px;
  padding: 12px 16px; background: var(--panel-head); border-bottom: 1px solid var(--line);
}
.card-titles { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1 1 320px; }
.card-sub { font-size: 12px; color: var(--ink-soft); }
.card-sub:empty { display: none; }
.card-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.card-actions:empty { display: none; }
.card-body { padding: 16px; min-width: 0; }
.card-body.stack { display: flex; flex-direction: column; gap: 14px; }

/* --------------------------------------------------------------- buttons */
button { font: inherit; color: inherit; cursor: pointer; max-width: 100%; }
button:disabled { cursor: not-allowed; }
button:not([class]), .btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  height: 32px; padding: 0 12px; border-radius: var(--radius);
  font-size: 13px; font-weight: 500; line-height: 1; white-space: nowrap;
  color: var(--ink); background: var(--btn-bg); border: 1px solid var(--line);
  transition: background 0.1s, border-color 0.1s;
}
button:not([class]):hover:not(:disabled), .btn:hover:not(:disabled) { background: var(--btn-hover); border-color: var(--line-strong); }
button:not([class]):disabled, .btn:disabled { color: var(--ink-faint); background: var(--btn-bg); opacity: 0.7; }
.btn-primary { color: var(--primary-ink); background: var(--primary); border-color: rgba(31, 35, 40, 0.15); }
.btn-primary:hover:not(:disabled) { background: var(--primary-hover); border-color: rgba(31, 35, 40, 0.15); }
.btn-primary:disabled { color: rgba(255, 255, 255, 0.8); background: var(--primary); opacity: 0.45; }
.btn-quiet { background: transparent; border-color: transparent; color: var(--ink-soft); }
.btn-quiet:hover:not(:disabled) { background: var(--hover); border-color: transparent; color: var(--ink); }
.btn-sm { height: 26px; padding: 0 9px; font-size: 12px; }
.link-button {
  border: 0; background: none; color: var(--accent); padding: 0; font-size: 12px; cursor: pointer;
}
.link-button:hover { text-decoration: underline; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; }
body.is-busy button { cursor: progress; }
.btn.is-loading::before, button.is-loading::before {
  content: ""; width: 12px; height: 12px; flex: 0 0 auto; border-radius: 50%;
  border: 2px solid currentColor; border-right-color: transparent; animation: spin 0.8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .btn.is-loading::before, button.is-loading::before { animation-duration: 2.4s; } }

/* ------------------------------------------------------------ tags, paths */
.path { font-family: var(--mono); font-size: 12.5px; min-width: 0; overflow-wrap: anywhere; }
.path-dir { color: var(--ink-soft); }
.path-base { color: var(--ink); font-weight: 600; }
.path-line { color: var(--ink-faint); }
.size { display: inline-flex; gap: 6px; font: 12px var(--mono); white-space: nowrap; }
.size .plus { color: var(--add-ink); }
.size .minus { color: var(--del-ink); }
.status-tag {
  display: inline-flex; align-items: center; height: 20px; padding: 0 7px; border-radius: 999px;
  font-size: 11.5px; font-weight: 600; white-space: nowrap;
  color: var(--ink-soft); background: var(--neutral-soft);
}
.status-tag.status-attention { color: var(--alarm); background: var(--alarm-bg); }
.status-tag.status-uncertain { color: var(--warn); background: var(--warn-soft); }
.tag-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 6px; }
.tag {
  display: inline-flex; align-items: center; gap: 6px; height: 22px; padding: 0 8px;
  border-radius: 999px; border: 1px solid var(--line); font-size: 12px; color: var(--ink); white-space: nowrap;
}
.tag::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--ink-faint); }
.tag.tone-ok::before { background: var(--ok); }
.tag.tone-watch { border-color: var(--warn); color: var(--warn); }
.tag.tone-watch::before { background: var(--warn); }
.tag.tone-unsure { color: var(--ink-soft); border-style: dashed; }
.tag.tone-unsure::before { background: transparent; border: 1px solid var(--ink-faint); }
.tag-lead { font-size: 12px; color: var(--ink-faint); margin-left: 6px; }
.tag + .tag-lead { margin-left: 10px; }
.tag-row > .tag-lead:first-child { margin-left: 0; }
.fact {
  display: inline-flex; align-items: center; gap: 6px; height: 22px; padding: 0 8px;
  border-radius: 6px; border: 1px solid transparent; background: var(--neutral-soft);
  font-size: 12px; color: var(--ink); white-space: nowrap;
}
button.fact:hover { border-color: var(--accent); background: var(--accent-soft); }
.fact-line { font: 11px var(--mono); color: var(--ink-soft); }
.agent-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #8250df; margin-right: 6px; vertical-align: 1px; }

/* ------------------------------------------------ the reading-order rail */
.rail {
  grid-column: 1; grid-row: 2 / span 40; position: sticky; top: 16px;
  display: flex; flex-direction: column; max-height: calc(100vh - 32px); min-width: 0;
  background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: var(--shadow);
}
.rail-head { padding: 14px 16px 10px; border-bottom: 1px solid var(--line-soft); display: flex; flex-direction: column; gap: 4px; }
.rail-head h2 { font-size: 16px; font-weight: 650; letter-spacing: -0.01em; }
.rail-sub { font-size: 12px; color: var(--ink-soft); }
.rail-sub:empty { display: none; }
.rail-actions { display: flex; gap: 6px; margin-top: 6px; }
.rail-actions:empty { display: none; }
.rail-body { flex: 1 1 auto; overflow-y: auto; overscroll-behavior: contain; padding: 6px 0; }
.rail-body > .note, .rail-body > .inline-note { padding: 10px 16px; }
.rail-foot {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 10px 12px 10px 16px; border-top: 1px solid var(--line-soft); background: var(--panel-head);
  border-radius: 0 0 var(--radius) var(--radius);
}
.rail-draft { font-size: 12px; color: var(--ink-soft); }
.rail-foot .btn { text-decoration: none; }
.order-list { list-style: none; margin: 0; padding: 0; }
/* Stations sit on one continuous line: the route through the pull request. */
.order-item {
  position: relative; display: grid; grid-template-columns: 26px minmax(0, 1fr); column-gap: 10px;
  padding: 6px 14px 6px 12px; cursor: pointer;
}
.order-item::before {
  content: ""; position: absolute; left: 24px; top: 0; bottom: 0; width: 2px; background: var(--route);
}
.order-item:first-child::before { top: 16px; }
.order-item:last-child::before { bottom: calc(100% - 16px); }
/* The route fills in behind the reader: a read station and the line after it turn accent. */
.order-item.is-seen::before { background: var(--accent); opacity: 0.55; }
.order-item:hover { background: var(--hover); }
.order-item:focus-within { outline: 2px solid var(--accent); outline-offset: -2px; }
.order-rank {
  position: relative; z-index: 1; width: 26px; height: 26px; border-radius: 50%;
  display: grid; place-items: center; font-size: 12px; font-weight: 650; font-variant-numeric: tabular-nums;
  color: var(--ink-soft); background: var(--panel); border: 2px solid var(--route);
  transition: background 0.15s, border-color 0.15s, color 0.15s;
}
.order-item.is-seen .order-rank { color: var(--accent); border-color: var(--accent); }
.order-item.is-current { background: var(--accent-soft); }
.order-item.is-current .order-rank { color: var(--primary-ink); background: var(--accent); border-color: var(--accent); }
.order-main { min-width: 0; padding-top: 1px; display: flex; flex-direction: column; gap: 3px; }
.order-path { display: flex; min-width: 0; font-size: 12.5px; white-space: nowrap; }
.order-path .path-base { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.order-path .path-line { flex: 0 0 auto; }
.order-path .path-dir { display: none; }
.order-meta { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.rail-progress { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 6px; font-size: 12px; color: var(--ink); font-variant-numeric: tabular-nums; }
.rail-progress[hidden] { display: none; }
.rail-keys { color: var(--ink-faint); white-space: nowrap; }
kbd {
  display: inline-block; min-width: 18px; padding: 0 4px; font: 11px/16px var(--mono); text-align: center;
  color: var(--ink-soft); background: var(--bg); border: 1px solid var(--line); border-bottom-width: 2px; border-radius: 4px;
}
.inline-note { font-size: 12px; color: var(--ink-soft); }
.btn-xs { height: 22px; padding: 0 6px; font-size: 12px; margin-left: -6px; color: var(--accent); }

/* ------------------------------------------------------------------ diff */
.suggest-bar {
  display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 16px;
  padding: 10px 12px; margin: 0 0 16px; border-radius: var(--radius);
  background: var(--accent-soft); border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent);
  font-size: 13px;
}
.suggest-bar p { flex: 1 1 280px; }
.bar-link { font-size: 13px; font-weight: 500; }
.file-block, .stop { border: 1px solid var(--line); border-radius: var(--radius); margin: 0 0 16px; min-width: 0; }
.file-block:last-child, .stop:last-child { margin-bottom: 0; }
/* ------------------------------------------- a change in the reading order */
.stop-head {
  position: sticky; top: 0; z-index: 2;
  display: flex; flex-wrap: nowrap; gap: 4px 12px; align-items: center;
  padding: 6px 8px 6px 10px; min-height: 42px; background: var(--panel-head);
  border-bottom: 1px solid var(--line); border-radius: var(--radius) var(--radius) 0 0;
}
.stop-head:focus { outline: none; }
.stop-head:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.stop-rank, .why-rank {
  flex: 0 0 auto; width: 24px; height: 24px; border-radius: 50%; display: grid; place-items: center;
  font: 650 12px var(--sans); font-variant-numeric: tabular-nums; color: var(--primary-ink); background: var(--accent);
}
.why-rank { width: 22px; height: 22px; font-size: 11.5px; }
.is-same-file .path-dir { display: none; }
.stop-why { display: flex; gap: 10px; align-items: flex-start; padding: 8px 12px 10px; background: var(--panel); border-bottom: 1px solid var(--line-soft); font-family: var(--sans); }
.stop-why .tag-row:first-child { margin-top: 0; }
.why-main { min-width: 0; flex: 1 1 auto; }
.why-note { font-size: 12px; color: var(--ink-soft); margin-top: 4px; }
.why-main > .why-note:first-child { margin-top: 0; }
/* By file, a ranked hunk opens with its number, between the code around it. */
.diff-rows > .stop-why { border-top: 1px solid var(--line-soft); }
.diff-rows > .stop-why:first-child { border-top: 0; }
.stop-why.has-rank { padding-left: 16px; }
.stop-why.has-rank .why-main:empty { display: none; }
.rest-head { margin: 28px 0 12px; }
.rest-head h3 { font-size: 14px; font-weight: 650; }
.rest-head p { font-size: 12px; color: var(--ink-soft); margin-top: 2px; }
.view-switch { display: inline-flex; gap: 2px; padding: 2px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); flex: 0 0 auto; }
.view-switch[hidden] { display: none; }
.view-switch button {
  height: 26px; padding: 0 10px; border: 0; border-radius: 6px; background: transparent;
  font-size: 12px; font-weight: 600; color: var(--ink-soft);
}
.view-switch button:hover { color: var(--ink); background: var(--hover); }
.view-switch button[aria-pressed="true"] { color: var(--ink); background: var(--accent-soft); box-shadow: inset 0 0 0 1px var(--accent); }
.view-switch button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.file-head {
  position: sticky; top: 0; z-index: 2;
  display: flex; flex-wrap: nowrap; gap: 4px 12px; align-items: center;
  padding: 6px 8px 6px 12px; min-height: 42px; background: var(--panel-head);
  border-radius: var(--radius) var(--radius) 0 0; cursor: pointer; list-style: none;
}
.file-block:not([open]) > .file-head { border-radius: var(--radius); }
.file-head::-webkit-details-marker { display: none; }
.file-head::before {
  content: ""; width: 6px; height: 6px; margin: 0 2px 0 2px;
  border-right: 1.5px solid var(--ink-soft); border-bottom: 1.5px solid var(--ink-soft);
  transform: rotate(-45deg); transition: transform 0.12s;
}
.file-block[open] > .file-head { border-bottom: 1px solid var(--line); }
.file-block[open] > .file-head::before { transform: rotate(45deg); }
.file-tools { margin-left: auto; display: flex; gap: 4px; flex: 0 0 auto; }
/* A long path gives way first: its directory truncates, the file name stays whole. */
.file-head .file-path, .stop-head .file-path { display: flex; min-width: 0; flex: 0 1 auto; overflow: hidden; }
.file-head .path-dir, .stop-head .path-dir { flex: 0 1000 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file-head .path-base, .stop-head .path-base { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.stop-head .path-line { flex: 0 0 auto; white-space: nowrap; }
.file-head .size, .file-head .status-tag, .stop-head .size, .stop-head .status-tag { flex: 0 0 auto; }
.diff-rows { min-width: 0; overflow: hidden; border-radius: 0 0 var(--radius) var(--radius); }
.diff-row { display: flex; align-items: stretch; font: 12px/20px var(--mono); min-height: 20px; }
/* The number column fits the widest line number of its block, set by the page as --ln-digits. */
.diff-rows { --gutter: calc(36px + var(--ln-digits, 3) * 1ch); }
.diff-gutter { position: relative; flex: 0 0 auto; width: var(--gutter); background: var(--panel); }
.diff-ln { display: block; padding: 0 10px 0 26px; text-align: right; white-space: nowrap; color: var(--ink-faint); user-select: none; }
.diff-action {
  position: absolute; left: 4px; top: 0; width: 20px; height: 20px; padding: 0;
  border: 0; border-radius: 6px; background: var(--accent); color: #fff;
  font: 600 14px/20px var(--sans); cursor: pointer; opacity: 0; transform: scale(0.9);
  transition: opacity 0.08s, transform 0.08s;
}
.diff-row:hover .diff-action:not(:disabled), .diff-action:focus-visible { opacity: 1; transform: scale(1); }
.diff-action.has-comment { opacity: 1; transform: scale(1); background: var(--warn); }
.diff-action.is-armed { opacity: 1; transform: scale(1); width: auto; padding: 0 6px; font-size: 11px; color: #fff; }
.diff-mark { flex: 0 0 auto; width: 20px; text-align: center; color: var(--ink-faint); user-select: none; }
.diff-code { display: block; flex: 1 1 auto; min-width: 0; padding: 0 12px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--ink); }
.kind-add { background: var(--add-bg); }
.kind-delete { background: var(--del-bg); }
.kind-add .diff-gutter { background: var(--add-gutter); }
.kind-delete .diff-gutter { background: var(--del-gutter); }
.kind-add .diff-ln, .kind-delete .diff-ln { color: var(--ink-soft); }
.kind-add .diff-mark { color: var(--add-ink); }
.kind-delete .diff-mark { color: var(--del-ink); }
.diff-row.is-target { box-shadow: inset 3px 0 0 var(--accent); background: var(--accent-soft); }
.diff-gap {
  display: flex; align-items: center; gap: 10px; min-height: 28px;
  background: var(--gap-bg); color: var(--ink-soft); font: 12px var(--mono);
}
.diff-gap-mark { width: var(--gutter); text-align: center; color: var(--accent); }
.tok-k { color: var(--syn-keyword); }
.tok-s { color: var(--syn-string); }
.tok-c { color: var(--syn-comment); font-style: italic; }
.tok-n { color: var(--syn-number); }
.tok-t { color: var(--syn-type); }
.tok-f { color: var(--syn-func); }
.tok-p { color: var(--syn-number); }

/* ------------------------------------------------ inline comments on lines */
.editor, .suggestion {
  margin: 8px 12px 10px 60px; padding: 10px 12px; border: 1px solid var(--line); border-radius: var(--radius);
  background: var(--panel); font-family: var(--sans); display: flex; flex-direction: column; gap: 8px; min-width: 0;
}
.editor { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent-soft); }
.editor-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.editor-input { flex: 1 1 240px; min-width: 0; }
.suggestion-by { font-size: 12px; color: var(--ink-soft); }
.suggestion-by strong { color: var(--ink); font-weight: 600; }
.suggestion-body { font-size: 14px; line-height: 1.5; overflow-wrap: anywhere; }
.suggestion-actions { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }

/* ---------------------------------------------------------------- forms */
.field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
label { font-weight: 600; font-size: 13px; }
input[type="text"], input[type="url"], textarea {
  font: 14px/1.5 var(--sans); color: var(--ink); background: var(--bg);
  border: 1px solid var(--line); border-radius: var(--radius);
  padding: 6px 10px; width: 100%; max-width: 100%; min-width: 0;
  transition: border-color 0.1s, box-shadow 0.1s;
}
input[type="text"]:focus, input[type="url"]:focus, textarea:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
textarea { resize: vertical; min-height: 88px; }
form { display: flex; flex-direction: column; gap: 12px; align-items: flex-start; }
.event-fieldset { border: 0; padding: 0; margin: 0; min-width: 0; }
.event-options { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 8px; }
.event-option {
  display: grid; grid-template-columns: auto 1fr; column-gap: 8px; align-items: center;
  padding: 10px 12px; border: 1px solid var(--line); border-radius: var(--radius); cursor: pointer; font-weight: 400;
}
.event-option:hover { background: var(--hover); }
.event-option:has(input:checked) { border-color: var(--accent); background: var(--accent-soft); }
.event-option input { grid-row: span 2; margin: 0; accent-color: var(--accent); }
.event-name { font-weight: 600; font-size: 13px; }
.event-help { grid-column: 2; font-size: 12px; color: var(--ink-soft); }

/* --------------------------------------------------------- draft comments */
.draft-list { list-style: none; margin: 0; padding: 0; border: 1px solid var(--line); border-radius: var(--radius); }
.draft-item { display: flex; flex-direction: column; gap: 4px; padding: 10px 12px; border-top: 1px solid var(--line-soft); min-width: 0; }
.draft-item:first-child { border-top: 0; }
.draft-head { display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: center; }
.draft-head .btn-quiet:first-of-type { margin-left: auto; }
.draft-body { font-size: 14px; white-space: pre-wrap; overflow-wrap: anywhere; }
.empty {
  border: 1px dashed var(--line); border-radius: var(--radius); padding: 14px 16px;
  color: var(--ink-soft); font-size: 13px; text-align: center;
}
#empty-note { margin: 0 0 16px; }

/* ----------------------------------------------------------------- submit */
.submit-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
.submit-row .status { flex: 1 1 200px; }
.payload-details > summary { cursor: pointer; font-size: 12px; color: var(--ink-soft); width: fit-content; }
.payload-details[open] > summary { margin-bottom: 8px; }
.payload-details .hint { margin-top: 8px; }
.payload {
  background: var(--sunken); border: 1px solid var(--line); border-radius: var(--radius);
  padding: 12px; margin: 0; max-height: 40vh; max-width: 100%; overflow: auto; font-size: 12px; white-space: pre;
}

/* ------------------------------------------------------ alerts and states */
.error {
  border: 1px solid var(--alarm); background: var(--alarm-bg); border-radius: var(--radius);
  padding: 12px 16px; margin: 0 0 16px; display: flex; flex-direction: column; gap: 8px; align-items: flex-start;
}
.error-title { font-weight: 600; font-size: 13px; }
.error-text { font-size: 13px; overflow-wrap: anywhere; }
#status-line:empty { display: none; }
#status-line { margin: 0 0 12px; }
.revalidate-section {
  border: 1px solid var(--warn); background: var(--warn-soft); border-radius: var(--radius);
  padding: 12px; display: flex; flex-direction: column; gap: 10px; min-width: 0;
}
.revalidate-item { position: static; width: auto; margin: 0; }
/* The shared editor row sizes its input by flex-basis; inside this column
   container that basis would become a 240px height. */
.revalidate-item .editor-input { flex: 0 0 auto; }
.revalidate-item.is-armed { outline: 2px solid var(--accent); outline-offset: 2px; }
.revalidate-where { overflow-wrap: anywhere; }
.revalidate-code {
  display: block; white-space: pre; overflow-x: auto; max-width: 100%;
  background: var(--sunken); border: 1px solid var(--line); border-radius: 4px; padding: 4px 8px; font-size: 12px;
}
.revalidate-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }

/* ---------------------------------------------------------------- details */
.details-panel > summary { cursor: pointer; font-weight: 600; font-size: 13px; color: var(--ink-soft); }
.details-panel[open] > summary { margin-bottom: 8px; color: var(--ink); }
.facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px 18px; margin: 0; }
.facts dt { font-size: 12px; color: var(--ink-soft); }
.facts dd { margin: 2px 0 0; font-size: 13px; overflow-wrap: anywhere; }
.facts dd.mono { font-size: 12px; }
.agenda-list { margin: 6px 0; padding-left: 20px; font-size: 13px; }
.foot { padding-top: 4px; }

/* -------------------------------------------------------- call-flow drawer */
.flow-drawer {
  position: fixed; top: 0; right: 0; bottom: 0; z-index: 20;
  width: min(760px, 60vw); display: flex; flex-direction: column;
  background: var(--bg); border-left: 1px solid var(--line);
  box-shadow: -8px 0 24px rgba(1, 4, 9, 0.2);
}
.flow-bar {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 10px 12px 10px 16px; background: var(--panel-head); border-bottom: 1px solid var(--line);
}
.flow-title { font: 600 13px var(--sans); overflow-wrap: anywhere; }
.flow-frame { flex: 1 1 auto; width: 100%; border: 0; background: var(--bg); }
/* Beside the diff only when both still have room; otherwise it lies over the page. */
@media (min-width: 1760px) { body.flow-open .wrap { margin-right: min(760px, 44vw); } }
@media (max-width: 1099px) { .flow-drawer { width: 100%; } }
body.flow-full .flow-drawer { width: 100%; box-shadow: none; border-left: 0; }
body.flow-full .flow-bar { display: none; }

@media (max-width: 960px) {
  .wrap:has(> #analysis-section:not([hidden])) { grid-template-columns: minmax(0, 1fr); }
  .rail { grid-column: 1; grid-row: auto; position: static; max-height: 60vh; margin-bottom: 20px; }
}
@media (max-width: 700px) {
  .wrap { padding: 16px 12px 48px; }
  h1 { font-size: 20px; }
  .panel { padding: 12px; }
  .card-head, .card-body { padding: 12px; }
  .facts { grid-template-columns: 1fr; }
  .editor, .suggestion { margin-left: 8px; margin-right: 8px; }
}
`;
