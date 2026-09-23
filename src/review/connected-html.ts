import { BRAND_MARK, BRAND_MARK_STYLES } from "./brand.js";
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
    `<p class="brand">${BRAND_MARK}diffninja</p>`,
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
    '<section id="analysis-section" class="panel" aria-labelledby="analysis-heading" hidden>',
    '<h2 id="analysis-heading">Read in this order</h2>',
    '<div id="analysis-body"></div>',
    "</section>",
    '<section id="diff-section" class="panel" aria-labelledby="diff-heading" hidden>',
    '<h2 id="diff-heading">Diff</h2>',
    '<p class="hint">The diff GitHub has for the commit shown above. Add a line comment on any line; comments stay in this tab until you submit.</p>',
    '<div id="diff-body"></div>',
    "</section>",
    '<section id="compose-section" class="panel" aria-labelledby="compose-heading" hidden>',
    '<h2 id="compose-heading">Your review <span id="draft-count" class="count"></span></h2>',
    '<p id="anchor-notice" class="status" role="status" aria-live="polite" hidden></p>',
    '<fieldset class="event-fieldset">',
    "<legend>Review action</legend>",
    '<div class="event-options">',
    '<label class="event-option"><input type="radio" name="event" value="COMMENT" checked><span>Comment</span></label>',
    '<label class="event-option"><input type="radio" name="event" value="APPROVE"><span>Approve</span></label>',
    '<label class="event-option"><input type="radio" name="event" value="REQUEST_CHANGES"><span>Request changes</span></label>',
    "</div>",
    '<p class="hint">Comment is the default. Approve and Request changes record a formal GitHub review state; nothing is preselected for you.</p>',
    "</fieldset>",
    '<div class="field">',
    '<label for="review-body">Review body</label>',
    '<textarea id="review-body" rows="5" aria-describedby="review-body-help"></textarea>',
    '<p class="hint" id="review-body-help">Written by you; diffninja never writes review text. Comments your agent suggests join your draft only when you add them. The body may be empty when line comments are present.</p>',
    "</div>",
    '<p id="event-note" class="status" role="status" aria-live="polite" hidden></p>',
    '<div id="revalidate-section" class="revalidate-section" hidden>',
    '<h3 class="subhead" id="revalidate-heading">Awaiting revalidation</h3>',
    '<p id="revalidate-note" class="status" role="status" aria-live="polite"></p>',
    '<div id="revalidate-list"></div>',
    "</div>",
    '<h3 class="subhead">Line comments</h3>',
    '<div id="draft-list"></div>',
    "</section>",
    '<section id="preview-section" class="panel" aria-labelledby="preview-heading" hidden>',
    '<h2 id="preview-heading">Preview and submit</h2>',
    '<p class="hint">This is the exact JSON payload sent to GitHub. <span class="mono">commit_id</span> pins the review to the commit shown. We check for changes before submission, but GitHub offers no atomic “submit only if head is unchanged” operation: the branch can still move between the final check and the write. The receipt identifies the reviewed commit.</p>',
    '<div class="actions"><button type="button" id="preview-button" data-action="preview">Preview payload</button></div>',
    '<p id="preview-state" class="status" role="status" aria-live="polite"></p>',
    '<pre id="preview-json" class="payload" tabindex="0" aria-label="Previewed GitHub review payload">No payload has been previewed yet.</pre>',
    '<div class="actions"><button type="button" id="submit-button" data-action="submit" disabled>Submit review to GitHub</button></div>',
    '<p id="submit-hint" class="hint" role="status" aria-live="polite"></p>',
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
    '<button type="button" id="flow-close" class="link-button" data-action="close-flow">Close</button>',
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
      anchorNotice = 'Draft restored from this browser tab for ' + owner + '. Nothing is sent to GitHub until you preview and submit.';
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
        ? 'One line comment is waiting to be attached to the current revision. Attach or confirm it before previewing or submitting.'
        : pending + ' line comments are waiting to be attached to the current revision. Attach or confirm each one before previewing or submitting.';
    }
    for (var i = 0; i < comments.length; i += 1) {
      if (comments[i].body.trim() === '') return 'Every line comment needs text, or remove it.';
    }
    if (body.trim() === '' && comments.length === 0) return 'Write a review body or add a line comment.';
    if (previewPayload === null) return 'Preview the payload before submitting.';
    if (previewSignature !== JSON.stringify(draftInput())) return 'The draft changed since the preview. Preview again.';
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
    el.pageMeta.appendChild(make('span', 'meta-item', typeof snap.state === 'string' ? snap.state.toLowerCase() : 'state unknown'));
    el.pageMeta.appendChild(make('span', 'meta-item mono', 'commit ' + shortSha(snap.headSha)));
    var login = reviewerLogin();
    if (login !== '') el.pageMeta.appendChild(make('span', 'meta-item', 'reviewing as ' + login));
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
    var remove = make('button', 'link-button', 'Remove');
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
      renderAnalysis();
      renderDiff();
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

  function renderHunkEntry(hunk) {
    var entry = make('li', 'order-item');
    var head = make('div', 'order-head');
    head.appendChild(make('span', 'chip status-' + (STATUS_ORDER.indexOf(hunk.status) >= 0 ? hunk.status : 'uncertain'), String(hunk.status)));
    head.appendChild(make('span', 'mono hunk-where', String(hunk.file) + ':' + String(hunk.line)));
    var size = make('span', 'hunk-size mono');
    size.appendChild(make('span', 'plus', '+' + String(hunk.added)));
    size.appendChild(document.createTextNode(' '));
    size.appendChild(make('span', 'minus', '\u2212' + String(hunk.removed)));
    head.appendChild(size);
    var go = make('button', 'link-button go-button', 'Go to the diff');
    go.type = 'button';
    go.dataset.action = 'goto';
    go.dataset.path = String(hunk.file);
    go.dataset.line = String(hunk.line);
    go.dataset.side = hunk.side === 'LEFT' ? 'LEFT' : 'RIGHT';
    head.appendChild(go);
    if (hasCallFlow(String(hunk.file))) head.appendChild(flowButton(String(hunk.file), 'Call flow'));
    entry.appendChild(head);
    var verdicts = answeredVerdicts(hunk);
    if (verdicts.length > 0) {
      var chips = make('p', 'verdicts');
      chips.appendChild(make('span', 'sr-only', 'Your agent says: '));
      for (var v = 0; v < verdicts.length; v += 1) {
        var chip = make('span', 'verdict verdict-' + String(verdicts[v].verdict.tone), String(verdicts[v].verdict.label));
        chip.title = String(verdicts[v].text);
        chips.appendChild(chip);
      }
      entry.appendChild(chips);
    }
    if (typeof hunk.note === 'string') entry.appendChild(make('p', 'note', hunk.note));
    var factCount = Array.isArray(hunk.facts) ? hunk.facts.length : 0;
    if (factCount > 0) {
      var more = make('details', 'fact-details');
      more.appendChild(make('summary', '', factCount === 1 ? '1 thing diffninja noticed' : factCount + ' things diffninja noticed'));
      var facts = make('ul', 'fact-list');
      for (var f = 0; f < hunk.facts.length; f += 1) {
        var fact = hunk.facts[f];
        var item = make('li', '');
        item.appendChild(make('span', 'fact-label', String(fact.label) + ', ' + String(fact.side) + ' line: '));
        item.appendChild(make('code', '', String(fact.text)));
        facts.appendChild(item);
      }
      more.appendChild(facts);
      entry.appendChild(more);
    }
    return entry;
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
    el.analysisBody.appendChild(make('p', 'order-source', byAgent
      ? 'Order recommended by ' + String(analysis.order.orderedBy) + ', the agent that opened this page. Labels are its answers; statuses come from diffninja.'
      : 'Waiting for your agent\u2019s recommended order. Until it arrives, this is the order diffninja computed.'));
    var flowFiles = Array.isArray(analysis.callFlowFiles) ? analysis.callFlowFiles : [];
    if (flowFiles.length > 0) {
      var flows = make('p', 'flow-line');
      flows.appendChild(flowButton('', flowFiles.length === 1 ? 'See the call flow (1 file)' : 'See the call flows (' + flowFiles.length + ' files)'));
      el.analysisBody.appendChild(flows);
    } else if (analysis.scope && analysis.scope.source === 'patch' && typeof analysis.scope.note === 'string') {
      el.analysisBody.appendChild(make('p', 'note flow-missing', 'No call-flow diagrams for this review. ' + analysis.scope.note));
    }
    if (!el.flowDrawer.hidden && flowSnapshot !== analysis.snapshotId) closeFlow();
    var total = analysis.questions ? analysis.questions.total : 0;
    var answered = analysis.questions ? analysis.questions.answered : 0;
    if (total > 0 && answered < total) {
      el.analysisBody.appendChild(make('p', 'note', 'Your agent has answered ' + answered + ' of ' + total + ' questions about these hunks; the rest appear as they arrive.'));
    }
    var list = make('ol', 'order-list');
    var hunks = Array.isArray(analysis.hunks) ? analysis.hunks : [];
    for (var h = 0; h < hunks.length; h += 1) list.appendChild(renderHunkEntry(hunks[h]));
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
    target.scrollIntoView({ block: 'center' });
    target.classList.add('is-target');
    setTimeout(function () { target.classList.remove('is-target'); }, 2000);
    var action = target.querySelector('button');
    if (action) action.focus({ preventScroll: true });
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

  /** Files in the reading order: the first hunk each file has in the analysis, then any file it does not list. */
  /* ------------------------------------------------------------ call flow -- */

  function hasCallFlow(path) {
    var current = currentAnalysis();
    return Boolean(current && Array.isArray(current.callFlowFiles) && current.callFlowFiles.indexOf(path) >= 0);
  }

  function flowButton(path, label) {
    var button = make('button', 'flow-button', label);
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
    document.body.classList.remove('flow-open');
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

  function onFlowKey(event_) {
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
    var head = make('p', 'suggestion-by', 'Suggested by ' + suggestedBy());
    wrap.appendChild(head);
    wrap.appendChild(make('p', 'suggestion-body', suggestion.body));
    var actions = make('div', 'suggestion-actions');
    var add = make('button', 'suggestion-add', 'Add to my review');
    add.type = 'button';
    add.dataset.action = 'add-suggestion';
    add.dataset.path = suggestion.path;
    add.dataset.line = String(suggestion.line);
    add.dataset.side = suggestion.side;
    add.disabled = disabled;
    add.setAttribute('aria-label', 'Add the suggested comment on line ' + suggestion.line + ' of ' + suggestion.path + ' to your review');
    var dismiss = make('button', 'link-button', 'Dismiss');
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
      bar.appendChild(make('p', '', suggestedBy() + ' suggested ' + open.length + (open.length === 1 ? ' comment' : ' comments')
        + ' under the lines below. Nothing is posted until you submit.'));
      var all = make('button', 'suggestion-add', open.length === 1 ? 'Add it to my review' : 'Add all ' + open.length + ' to my review');
      all.type = 'button';
      all.dataset.action = 'add-all-suggestions';
      all.disabled = disabled;
      bar.appendChild(all);
    } else {
      bar.appendChild(make('p', '', adopted + (adopted === 1 ? ' suggested comment is' : ' suggested comments are')
        + ' in your draft. Read them over, then preview and submit under Your review.'));
      var go = make('a', '', 'Go to Your review');
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

  function renderDiff() {
    var snap = snapshot();
    show(el.diffSection, Boolean(snap));
    el.diffBody.textContent = '';
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
    var disabled = composeDisabled();
    var open = openSuggestions();
    var bar = suggestionBar(open, disabled);
    if (bar) el.diffBody.appendChild(bar);
    var suggestions = Object.create(null);
    for (var o = 0; o < open.length; o += 1) suggestions[anchorKeyOf(open[o])] = open[o];
    for (var g = 0; g < groups.length; g += 1) el.diffBody.appendChild(renderFileBlock(groups[g], disabled, suggestions));
  }

  function renderFileBlock(group, disabled, suggestions) {
    var block = make('details', 'file-block');
    block.dataset.path = group.path;
    block.open = closedFiles[group.path] !== true;
    block.addEventListener('toggle', function () { closedFiles[group.path] = !block.open; });
    var head = make('summary', 'file-head');
    head.appendChild(make('span', 'file-path', group.path));
    var added = 0;
    var removed = 0;
    for (var c = 0; c < group.lines.length; c += 1) {
      if (group.lines[c].kind === 'add') added += 1;
      else if (group.lines[c].kind === 'delete') removed += 1;
    }
    var size = make('span', 'file-size mono');
    size.appendChild(make('span', 'plus', '+' + added));
    size.appendChild(document.createTextNode(' '));
    size.appendChild(make('span', 'minus', '−' + removed));
    head.appendChild(size);
    var worst = worstStatusFor(group.path);
    if (worst !== '') head.appendChild(make('span', 'chip status-' + worst, worst));
    if (hasCallFlow(group.path)) head.appendChild(flowButton(group.path, 'Call flow'));
    block.appendChild(head);
    var rows = make('div', 'diff-rows');
    var language = languageOf(group.path);
    var state = { block: false, quote: '' };
    for (var i = 0; i < group.lines.length; i += 1) {
      var line = group.lines[i];
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
    block.appendChild(rows);
    return block;
  }

  function renderDraftList(disabled) {
    el.draftList.textContent = '';
    var anchored = [];
    for (var i = 0; i < comments.length; i += 1) {
      if (!comments[i].needsRevalidation) anchored.push(i);
    }
    setText(el.draftCount, comments.length === 0 ? 'no line comments yet' : comments.length + ' line comment' + (comments.length === 1 ? '' : 's'));
    if (anchored.length === 0) {
      el.draftList.appendChild(make('p', 'empty', comments.length === 0
        ? 'No line comments yet. Hover a diff line and press + to add one.'
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
      head.appendChild(make('span', 'draft-where mono', comment.path + ':' + comment.line + ' (' + sideLabel(comment.side) + ' side)'));
      var edit = make('button', 'link-button', 'Edit');
      edit.type = 'button';
      edit.dataset.action = 'edit-comment';
      edit.dataset.index = String(index);
      edit.disabled = disabled;
      edit.setAttribute('aria-label', 'Edit the comment on ' + comment.path + ' line ' + comment.line);
      var remove = make('button', 'link-button', 'Remove');
      remove.type = 'button';
      remove.dataset.action = 'remove-comment';
      remove.dataset.index = String(index);
      remove.disabled = disabled;
      remove.setAttribute('aria-label', 'Remove the comment on ' + comment.path + ' line ' + comment.line);
      head.appendChild(edit);
      head.appendChild(remove);
      item.appendChild(head);
      var text = make('p', 'draft-body mono', comment.body === '' ? '(empty)' : comment.body);
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

  function updateActionState() {
    var hint = validationHint();
    var previewing = busyAction === 'preview';
    var posting = busyAction === 'submit' && submitting;
    el.submitButton.disabled = hint !== '' || posting;
    setText(el.submitButton, posting ? 'Submitting to GitHub\u2026' : 'Submit review to GitHub');
    el.submitButton.classList.toggle('is-loading', posting);
    el.submitButton.setAttribute('aria-busy', posting ? 'true' : 'false');
    setText(el.previewButton, previewing ? 'Preparing preview\u2026' : 'Preview payload');
    el.previewButton.classList.toggle('is-loading', previewing);
    el.previewButton.setAttribute('aria-busy', previewing ? 'true' : 'false');
    if (previewing) el.previewButton.disabled = true;
    var failed = lastError !== '' && !busy && !submitting;
    setText(el.submitHint, posting
      ? 'Posting your review to GitHub. This takes a few seconds; keep this tab open.'
      : failed && placeAnchor === el.submitButton
        ? 'Not submitted: ' + lastError
        : hint === '' ? 'Previewed payload matches the current draft. Submit posts this review to GitHub and cannot be undone from this page.' : hint);
    el.submitHint.classList.toggle('is-error', failed && placeAnchor === el.submitButton);
    var stale = previewPayload !== null && previewSignature !== JSON.stringify(draftInput());
    setText(el.previewState, previewPayload === null
      ? 'No payload has been previewed yet.'
      : stale
        ? 'The draft changed since this preview. Preview again before submitting.'
        : 'This payload matches the current draft exactly.');
    el.previewState.className = stale ? 'status is-stale' : 'status';
    if (previewing) setText(el.previewState, 'Checking the draft against the pull request\u2026');
    else if (failed && placeAnchor === el.previewButton) {
      setText(el.previewState, 'Preview failed: ' + lastError);
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
    setText(el.previewJson, previewPayload === null ? 'No payload has been previewed yet.' : JSON.stringify(previewPayload, null, 2));
  }

  function renderReceipt() {
    var receipt = state && state.receipt && typeof state.receipt === 'object' ? state.receipt : null;
    show(el.receiptSection, Boolean(receipt));
    el.receiptBody.textContent = '';
    if (!receipt) return;
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
:root {
  color-scheme: light dark;
  --bg: #ffffff;
  --panel: #ffffff;
  --sunken: #f6f8fa;
  --ink: #1f2328;
  --ink-soft: #59636e;
  --line: #d1d9e0;
  --line-strong: #afb8c1;
  --teal: #4d8d86;
  --warn: #a2701f;
  --warn-bg: #fdf3e2;
  --alarm: #c22e2e;
  --alarm-bg: #fdecec;
  --add: #116329;
  --add-bg: #dafbe1;
  --del: #82071e;
  --del-bg: #ffebe9;
  --cursor: #2f6fae;
  --add-ink: #1a7f37;
  --del-ink: #cf222e;
  --add-gutter: #ccffd8;
  --del-gutter: #ffd7d5;
  --syn-keyword: #cf222e;
  --syn-string: #0a3069;
  --syn-comment: #6e7781;
  --syn-number: #0550ae;
  --syn-type: #953800;
  --syn-func: #8250df;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  --sans: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0d1117;
    --panel: #0d1117;
    --sunken: #161b22;
    --ink: #e6edf3;
    --ink-soft: #9198a1;
    --line: #30363d;
    --line-strong: #6e7681;
    --teal: #6cc5bd;
    --warn: #e0b372;
    --warn-bg: #2e2418;
    --alarm: #ff8a8a;
    --alarm-bg: #331f1e;
    --add: #aff5b4;
    --add-bg: #123821;
    --del: #ffdcd7;
    --del-bg: #3f1b22;
    --cursor: #7aa7d8;
    --add-ink: #3fb950;
    --del-ink: #f85149;
    --add-gutter: #1b4721;
    --del-gutter: #5a1e25;
    --syn-keyword: #ff7b72;
    --syn-string: #a5d6ff;
    --syn-comment: #8b949e;
    --syn-number: #79c0ff;
    --syn-type: #ffa657;
    --syn-func: #d2a8ff;
  }
}
*, *::before, *::after { box-sizing: border-box; }
/* Class rules below set display, which would otherwise beat the UA's hidden
   rule and leave every collapsed panel visible. */
[hidden] { display: none !important; }
html { -webkit-text-size-adjust: 100%; max-width: 100%; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font: 400 16px/1.55 var(--sans);
  max-width: 100%;
  overflow-wrap: break-word;
}
.wrap { max-width: 1240px; margin: 0 auto; padding: 26px 20px 64px; }
.flow-button {
  font-size: 12.5px; padding: 2px 9px; border-radius: 999px; margin-left: 8px;
  color: var(--teal); border-color: var(--teal); background: transparent;
}
.flow-line .flow-button { margin-left: 0; font-size: 13.5px; padding: 5px 12px; }
.flow-drawer {
  position: fixed; top: 0; right: 0; bottom: 0; z-index: 20;
  width: min(760px, 52vw); display: flex; flex-direction: column;
  background: var(--panel); border-left: 1px solid var(--line-strong);
  box-shadow: -12px 0 32px rgba(0, 0, 0, 0.25);
}
.flow-drawer[hidden] { display: none; }
.flow-bar {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 10px 14px; border-bottom: 1px solid var(--line);
}
.flow-title { font-size: 14px; overflow-wrap: anywhere; font-family: var(--mono); }
.flow-frame { flex: 1 1 auto; width: 100%; border: 0; background: var(--panel); }
@media (min-width: 1100px) { body.flow-open .wrap { margin-right: min(760px, 52vw); } }
@media (max-width: 1099px) { .flow-drawer { width: 100%; } }
h1, h2, h3, h4 { margin: 0; line-height: 1.25; }
h1 { font-size: clamp(1.3rem, 1.05rem + 1.1vw, 1.8rem); overflow-wrap: anywhere; }
h2 { font-size: 1.02rem; }
.chip { display: inline-block; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; padding: 1px 7px; border-radius: 999px; margin-left: 8px; border: 1px solid var(--line); color: var(--ink-soft); }
.chip.status-attention { color: var(--alarm); border-color: var(--alarm); background: var(--alarm-bg); }
.chip.status-uncertain { color: var(--warn); border-color: var(--warn); background: var(--warn-bg); }
.chip.status-low { color: var(--teal); border-color: var(--teal); }
.hunk-list { display: grid; gap: 6px; }
.page-meta { display: flex; flex-wrap: wrap; gap: 6px 16px; margin: 6px 0 0; font-size: 14px; color: var(--ink-soft); }
.page-meta a { font-weight: 600; }
.order-source { margin: 0 0 12px; color: var(--ink-soft); }
.order-list { margin: 0; padding: 0 0 0 2.2em; display: grid; gap: 10px; }
.order-list > li::marker { font-weight: 700; color: var(--ink-soft); font-variant-numeric: tabular-nums; }
.order-item { border: 1px solid var(--line); border-radius: 6px; padding: 8px 12px; background: var(--sunken); }
.order-head { display: flex; align-items: center; gap: 8px 12px; flex-wrap: wrap; }
.order-head .chip { margin-left: 0; }
.hunk-size { font-size: 12.5px; color: var(--ink-soft); }
.hunk-size .plus { color: var(--add); }
.hunk-size .minus { color: var(--del); }
.go-button { margin-left: auto; }
.verdicts { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0 0; }
.verdict { font-size: 12.5px; padding: 1px 9px; border-radius: 999px; border: 1px solid var(--line); color: var(--ink); background: var(--panel); }
.verdict-ok { border-color: var(--teal); color: var(--teal); }
.verdict-watch { border-color: var(--warn); color: var(--warn); background: var(--warn-bg); font-weight: 600; }
.verdict-unsure { border-style: dashed; color: var(--ink-soft); }
.fact-details { margin-top: 6px; }
.fact-details > summary { cursor: pointer; font-size: 13px; color: var(--ink-soft); }
.details-panel > summary { cursor: pointer; font-weight: 600; }
.details-panel[open] > summary { margin-bottom: 8px; }
@media (max-width: 640px) { .go-button { margin-left: 0; } .order-list { padding-left: 1.6em; } }
.hunk-entry { border: 1px solid var(--line); border-radius: 6px; padding: 6px 10px; background: var(--sunken); }
.hunk-entry summary { cursor: pointer; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.hunk-entry summary .chip { margin-left: 0; }
.hunk-where { font-size: 13px; overflow-wrap: anywhere; }
.fact-list, .question-list, .agenda-list { margin: 6px 0; padding-left: 20px; font-size: 13px; }
.fact-list code { font-family: var(--mono); font-size: 12.5px; overflow-wrap: anywhere; }
.fact-label { color: var(--ink-soft); }
.question-list li { margin: 4px 0; }
.question-text { display: block; }
.answer { display: block; font-weight: 600; }
.answer.pending { font-weight: 400; color: var(--ink-soft); font-style: italic; }
.summary-line { font-weight: 600; }
.diff-row.is-target { outline: 2px solid var(--cursor); outline-offset: -2px; }
h3.subhead { font-size: 0.9rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--ink-soft); }
p { margin: 0; }
a { color: var(--teal); overflow-wrap: anywhere; }
.mono, code, .payload { font-family: var(--mono); }
.lede { font-size: 13.5px; color: var(--ink-soft); }
.note, .hint, .count, .status { font-size: 12.5px; color: var(--ink-soft); }
.status { margin: 0 0 12px; overflow-wrap: anywhere; min-height: 1.2em; }
.status.is-stale { color: var(--warn); font-weight: 600; }
.sr-only {
  position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0;
  overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0;
}
.masthead {
  display: flex; flex-direction: column; gap: 8px;
  padding-bottom: 16px; border-bottom: 2px solid var(--line-strong); margin-bottom: 18px;
}
.brand {
  display: flex; align-items: center; gap: 9px; font-size: 12px; font-weight: 700;
  letter-spacing: 0.18em; text-transform: uppercase; color: var(--ink-soft);
}
${BRAND_MARK_STYLES}
.panel {
  border: 1px solid var(--line); border-radius: 8px; background: var(--panel);
  padding: 16px; margin: 0 0 16px;
  display: flex; flex-direction: column; gap: 12px; min-width: 0;
}
.field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
label { font-weight: 600; font-size: 13.5px; }
input[type="text"], input[type="url"], textarea {
  font: inherit; color: var(--ink); background: var(--sunken);
  border: 1px solid var(--line-strong); border-radius: 6px;
  padding: 8px 10px; width: 100%; max-width: 100%; min-width: 0;
}
input:focus-visible, textarea:focus-visible, button:focus-visible, .payload:focus-visible, a:focus-visible {
  outline: 2px solid var(--cursor); outline-offset: 2px;
}
button {
  font: inherit; color: var(--ink); background: var(--panel);
  border: 1px solid var(--line-strong); border-radius: 6px;
  padding: 7px 12px; cursor: pointer; max-width: 100%;
}
button:hover:not(:disabled) { border-color: var(--teal); }
button:disabled { cursor: default; opacity: 0.6; }
form { display: flex; flex-direction: column; gap: 12px; align-items: flex-start; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; }
.error {
  border: 1px solid var(--alarm); background: var(--alarm-bg); border-radius: 8px;
  padding: 12px 14px; margin: 0 0 16px;
  display: flex; flex-direction: column; gap: 8px; align-items: flex-start;
}
.error-title { font-weight: 700; font-size: 13.5px; }
.error-text { font-size: 13.5px; overflow-wrap: anywhere; }
.empty {
  border: 1px dashed var(--line-strong); border-radius: 8px; padding: 14px 16px;
  color: var(--ink-soft); font-size: 13.5px; margin: 0 0 12px;
}
.facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px 18px; margin: 0; }
.facts dt { font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--ink-soft); }
.facts dd { margin: 2px 0 0; font-size: 13.5px; overflow-wrap: anywhere; }
.facts dd.mono { font-size: 12px; }
.file-block { border: 1px solid var(--line); border-radius: 8px; margin: 0 0 14px; overflow: hidden; min-width: 0; }
.file-head {
  display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: center;
  padding: 8px 12px; background: var(--sunken); font-size: 13px; cursor: pointer; list-style: none;
}
.file-head::-webkit-details-marker { display: none; }
.file-head::before { content: ""; width: 7px; height: 7px; border-right: 2px solid var(--ink-soft); border-bottom: 2px solid var(--ink-soft); transform: rotate(-45deg); transition: transform 0.12s; margin-right: 2px; }
.file-block[open] > .file-head { border-bottom: 1px solid var(--line); }
.file-block[open] > .file-head::before { transform: rotate(45deg); }
.file-path { font-family: var(--mono); font-size: 12.5px; font-weight: 600; overflow-wrap: anywhere; min-width: 0; }
.file-size { font-size: 12px; }
.file-size .plus, .hunk-size .plus { color: var(--add-ink); }
.file-size .minus, .hunk-size .minus { color: var(--del-ink); }
.diff-rows { min-width: 0; }
.diff-row {
  display: flex; align-items: stretch;
  font-family: var(--mono); font-size: 12.5px; line-height: 1.6; min-height: 22px;
}
.diff-gutter { position: relative; flex: 0 0 auto; width: 64px; border-right: 1px solid var(--line); }
.diff-ln { display: block; padding: 0 10px 0 28px; text-align: right; color: var(--ink-soft); user-select: none; }
.diff-action {
  position: absolute; left: 4px; top: 1px; width: 20px; height: 20px; padding: 0;
  border: 0; border-radius: 6px; background: var(--cursor); color: #fff;
  font: 700 15px/20px var(--sans); cursor: pointer; opacity: 0;
}
.diff-row:hover .diff-action:not(:disabled), .diff-action:focus-visible { opacity: 1; }
.diff-action:focus-visible { outline: 2px solid var(--ink); outline-offset: 1px; }
.diff-action.has-comment { opacity: 1; background: var(--warn); }
.diff-action.is-armed { opacity: 1; width: auto; padding: 0 6px; font-size: 11px; }
.diff-mark { flex: 0 0 auto; width: 20px; text-align: center; color: var(--ink-soft); user-select: none; }
.diff-code { display: block; flex: 1 1 auto; min-width: 0; padding: 0 10px 0 2px; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--ink); }
.kind-add { background: var(--add-bg); }
.kind-delete { background: var(--del-bg); }
.kind-add .diff-mark { color: var(--add-ink); }
.kind-delete .diff-mark { color: var(--del-ink); }
.kind-add .diff-gutter { background: var(--add-gutter); }
.kind-delete .diff-gutter { background: var(--del-gutter); }
.tok-k { color: var(--syn-keyword); }
.tok-s { color: var(--syn-string); }
.tok-c { color: var(--syn-comment); font-style: italic; }
.tok-n { color: var(--syn-number); }
.tok-t { color: var(--syn-type); }
.tok-f { color: var(--syn-func); }
.tok-p { color: var(--syn-number); }
.editor {
  background: var(--warn-bg); border-top: 1px solid var(--line-strong);
  border-bottom: 1px solid var(--line-strong); padding: 10px 12px;
  display: flex; flex-direction: column; gap: 6px;
}
.editor-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.editor-input { flex: 1 1 240px; min-width: 0; }
.suggest-bar {
  display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 14px;
  border: 1px solid var(--teal); border-radius: 8px; padding: 10px 14px; margin: 0 0 14px;
  font-size: 13.5px;
}
.suggest-bar p { flex: 1 1 260px; }
.suggestion {
  border-top: 1px solid var(--line); border-bottom: 1px solid var(--line);
  border-left: 4px solid var(--teal); background: var(--panel);
  padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; min-width: 0;
}
.suggestion-by { font-size: 12px; color: var(--ink-soft); }
.suggestion-body { font-size: 14px; overflow-wrap: anywhere; }
.suggestion-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.suggestion-add { background: var(--teal); border-color: var(--teal); color: var(--panel); font-weight: 600; }
.suggestion-add:hover:not(:disabled) { filter: brightness(1.08); }
.link-button {
  border: 0; background: none; color: var(--teal);
  padding: 2px 4px; text-decoration: underline; font-size: 12.5px; cursor: pointer;
}
.draft-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
.draft-item {
  border: 1px solid var(--line); border-left: 4px solid var(--warn); border-radius: 6px;
  padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; min-width: 0;
}
.draft-head { display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: center; }
.draft-where { font-size: 12.5px; overflow-wrap: anywhere; min-width: 0; }
.draft-body { font-size: 12.5px; white-space: pre-wrap; overflow-wrap: anywhere; }
.revalidate-section {
  border: 1px solid var(--warn); background: var(--warn-bg); border-radius: 8px;
  padding: 12px; display: flex; flex-direction: column; gap: 10px; min-width: 0;
}
.revalidate-item {
  position: static; width: auto; margin: 0; background: var(--panel);
  border: 1px solid var(--line-strong); border-left: 4px solid var(--warn);
  border-radius: 6px;
}
/* The shared editor row sizes its input by flex-basis; inside this column
   container that basis would become a 240px height. */
.revalidate-item .editor-input { flex: 0 0 auto; }
.revalidate-item.is-armed { border-left-color: var(--cursor); outline: 2px solid var(--cursor); outline-offset: 2px; }
.revalidate-where { overflow-wrap: anywhere; }
.revalidate-code {
  display: block; white-space: pre; overflow-x: auto; max-width: 100%;
  background: var(--sunken); border: 1px solid var(--line); border-radius: 4px;
  padding: 4px 8px; font-size: 12px;
}
.revalidate-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.diff-action.is-armed { color: var(--cursor); font-weight: 700; }
.payload {
  background: var(--sunken); border: 1px solid var(--line); border-radius: 6px;
  padding: 12px; margin: 0; max-height: 44vh; max-width: 100%;
  overflow: auto; font-size: 12.5px; white-space: pre;
}
.event-fieldset {
  border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; margin: 0;
  display: flex; flex-direction: column; gap: 8px; min-width: 0;
}
.event-fieldset legend { font-weight: 600; font-size: 13.5px; padding: 0 4px; }
.event-options { display: flex; flex-wrap: wrap; gap: 8px 20px; }
.event-option { display: inline-flex; align-items: center; gap: 7px; font-weight: 500; }
.foot { border-top: 1px solid var(--line); padding-top: 14px; margin-top: 6px; }
body.is-busy button { cursor: progress; }
button.is-loading { display: inline-flex; align-items: center; gap: 8px; }
button.is-loading::before {
  content: ""; width: 12px; height: 12px; flex: 0 0 auto; border-radius: 50%;
  border: 2px solid currentColor; border-right-color: transparent;
  animation: spin 0.8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { button.is-loading::before { animation-duration: 2.4s; } }
.is-error { color: var(--alarm); }
@media (max-width: 700px) {
  .wrap { padding: 18px 12px 48px; }
  .panel { padding: 12px; }
  .facts { grid-template-columns: 1fr; }
  .diff-gutter { width: 56px; }
}
`;
