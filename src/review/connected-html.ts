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
    '<p class="brand"><span class="brand-mark" aria-hidden="true"></span>diffninja</p>',
    "<h1>Connected pull request review</h1>",
    '<p class="lede">Load a GitHub pull request, read its canonical diff, and post a human-authored review through the <span class="mono">gh</span> CLI. Loading contacts GitHub; review text stays in this browser and local server until you press Submit.</p>',
    "</header>",
    '<section class="panel" aria-labelledby="load-heading">',
    '<h2 id="load-heading">Load a pull request</h2>',
    '<form id="load-form">',
    '<div class="field">',
    '<label for="pr-url">Pull request URL</label>',
    '<input id="pr-url" name="url" type="url" required inputmode="url" autocomplete="off" spellcheck="false" placeholder="https://github.com/owner/repo/pull/123" aria-describedby="pr-url-help">',
    '<p class="hint" id="pr-url-help">A full github.com pull request URL. No other host is accepted, and no other GitHub data is reachable from this page.</p>',
    "</div>",
    '<button type="submit" id="load-button">Load pull request</button>',
    "</form>",
    '<p class="note">Authentication is delegated to the <span class="mono">gh</span> CLI running diffninja. When <span class="mono">GH_TOKEN</span> or <span class="mono">GITHUB_TOKEN</span> is set it overrides the gh login; otherwise gh uses its own signed-in account. This page never reads, displays, or stores a token, and static reports never probe a local server.</p>',
    "</section>",
    '<p id="status-line" class="status" role="status" aria-live="polite"></p>',
    '<p id="empty-note" class="empty">No pull request loaded. Paste a pull request URL above to begin.</p>',
    '<div id="error-box" class="error" role="alert" hidden>',
    '<p class="error-title">Request failed</p>',
    '<p id="error-text" class="error-text"></p>',
    '<p class="hint">Your draft is kept. Check GitHub state to re-read the pull request and the account before deciding what to do next.</p>',
    '<button type="button" id="refresh-button" data-action="refresh">Check GitHub state</button>',
    "</div>",
    '<section id="identity-section" class="panel" aria-labelledby="identity-heading" hidden>',
    '<h2 id="identity-heading">Review identity</h2>',
    '<div id="identity-body"></div>',
    "</section>",
    '<section id="snapshot-section" class="panel" aria-labelledby="snapshot-heading" hidden>',
    '<h2 id="snapshot-heading">Pull request revision</h2>',
    '<div id="snapshot-body"></div>',
    '<p id="message-note" class="note" role="status" aria-live="polite" hidden></p>',
    "</section>",
    '<section id="diff-section" class="panel" aria-labelledby="diff-heading" hidden>',
    '<h2 id="diff-heading">Canonical diff</h2>',
    '<p class="hint">Comments attach only to the lines below, from the revision that was loaded. Line comments are a single line of plain text, written by you.</p>',
    '<div id="diff-body"></div>',
    "</section>",
    '<section id="compose-section" class="panel" aria-labelledby="compose-heading" hidden>',
    '<h2 id="compose-heading">Review draft <span id="draft-count" class="count"></span></h2>',
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
    '<p class="hint" id="review-body-help">Written by you; diffninja never generates review text. The body may be empty when line comments are present.</p>',
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
    '<footer class="foot">',
    '<p class="note">Reports and this page contain source code. Keep them private. Diffninja gives no automatic approval.</p>',
    "</footer>",
    "</div>",
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
        comments: comments
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
        needsRevalidation: c.needsRevalidation === true
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
    addFact(dl, 'Signed in as', typeof identity.login === 'string' && identity.login !== '' ? identity.login : 'unknown');
    addFact(dl, 'Account id', typeof identity.id === 'number' ? String(identity.id) : 'unknown');
    el.identityBody.appendChild(dl);
    el.identityBody.appendChild(make('p', 'note', 'Reviews are posted as the gh account above. GH_TOKEN or GITHUB_TOKEN in the server environment overrides the stored gh login; otherwise gh uses its signed-in account. This page never reads or stores a token.'));
  }

  function renderSnapshot() {
    var snap = snapshot();
    show(el.snapshotSection, Boolean(snap));
    el.snapshotBody.textContent = '';
    if (!snap) return;
    var dl = make('dl', 'facts');
    addFact(dl, 'Repository', (typeof snap.owner === 'string' ? snap.owner : 'unknown') + '/' + (typeof snap.repo === 'string' ? snap.repo : 'unknown'), true);
    addLinkFact(dl, 'Pull request', snap.url, '#' + String(snap.number));
    addLinkFact(dl, 'URL', snap.url, typeof snap.url === 'string' ? snap.url : 'unknown');
    addFact(dl, 'GitHub state', typeof snap.state === 'string' ? snap.state : 'unknown');
    addFact(dl, 'Base commit', typeof snap.baseSha === 'string' ? snap.baseSha : 'unknown', true);
    addFact(dl, 'Head commit', typeof snap.headSha === 'string' ? snap.headSha : 'unknown', true);
    addFact(dl, 'Snapshot id', typeof snap.id === 'string' ? snap.id : 'unknown', true);
    addFact(dl, 'Diff lines', String(lines().length));
    el.snapshotBody.appendChild(dl);
    el.snapshotBody.appendChild(make('p', 'note', 'The snapshot binds host, repository, PR number, base/head commits and the exact diff hash. Detected changes block submission and require refresh plus explicit anchor revalidation. A branch change after the final check remains possible; commit_id binds the review to this reviewed commit, not necessarily the latest head.'));
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
    var help = make('p', 'hint', 'One line of plain text, written by you. Kept in this browser tab for this pull request until it is submitted.');
    help.id = inputId + '-help';
    wrap.appendChild(help);
    return wrap;
  }

  function renderDiff() {
    var snap = snapshot();
    show(el.diffSection, Boolean(snap));
    // A render rebuilds every block, so keep each file's scroll offset by path:
    // a reviewer deep in a long diff must not be thrown back to the top by a
    // preview or a reconcile.
    var offsets = {};
    var previous = el.diffBody.querySelectorAll('.file-block');
    for (var p = 0; p < previous.length; p += 1) {
      var scroller = previous[p].querySelector('.diff-scroll');
      if (scroller) offsets[previous[p].getAttribute('data-path')] = { top: scroller.scrollTop, left: scroller.scrollLeft };
    }
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
      if (!group) { group = { path: line.path, lines: [] }; index[line.path] = group; groups.push(group); }
      group.lines.push(line);
    }
    var disabled = composeDisabled();
    for (var g = 0; g < groups.length; g += 1) {
      var block = renderFileBlock(groups[g], disabled);
      el.diffBody.appendChild(block);
      var kept = offsets[groups[g].path];
      if (!kept) continue;
      var target = block.querySelector('.diff-scroll');
      if (target) { target.scrollTop = kept.top; target.scrollLeft = kept.left; }
    }
  }

  function renderFileBlock(group, disabled) {
    var block = make('section', 'file-block');
    block.dataset.path = group.path;
    var head = make('h4', 'file-head');
    head.appendChild(make('span', 'file-path', group.path));
    head.appendChild(make('span', 'file-count', group.lines.length + ' line' + (group.lines.length === 1 ? '' : 's')));
    block.appendChild(head);
    var scroll = make('div', 'diff-scroll');
    var rows = make('div', 'diff-rows');
    for (var i = 0; i < group.lines.length; i += 1) {
      var line = group.lines[i];
      var row = make('div', 'diff-row kind-' + String(line.kind));
      var attached = commentIndexAt(line);
      var arming = reattachIndex >= 0;
      var action = make('button', 'diff-action' + (arming ? ' is-armed' : ''), arming ? 'Attach' : (attached >= 0 ? 'Edit' : 'Comment'));
      action.type = 'button';
      action.dataset.action = 'comment';
      action.dataset.path = line.path;
      action.dataset.line = String(line.line);
      action.dataset.side = line.side;
      action.disabled = disabled;
      action.setAttribute('aria-label', arming
        ? 'Attach the comment awaiting revalidation to line ' + line.line + ' of ' + line.path + ' (' + sideLabel(line.side) + ' side)'
        : 'Comment on line ' + line.line + ' of ' + line.path + ' (' + sideLabel(line.side) + ' side)');
      row.appendChild(action);
      row.appendChild(make('span', 'diff-ln', line.line));
      row.appendChild(make('span', 'diff-side', sideLabel(line.side)));
      row.appendChild(make('code', 'diff-code', line.text));
      rows.appendChild(row);
      if (attached >= 0) rows.appendChild(editorRow(attached));
    }
    scroll.appendChild(rows);
    block.appendChild(scroll);
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
        ? 'No line comments yet. Use the Comment button on a diff line.'
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
    el.submitButton.disabled = hint !== '';
    setText(el.submitHint, hint === '' ? 'Previewed payload matches the current draft. Submit posts this review to GitHub and cannot be undone from this page.' : hint);
    var stale = previewPayload !== null && previewSignature !== JSON.stringify(draftInput());
    setText(el.previewState, previewPayload === null
      ? 'No payload has been previewed yet.'
      : stale
        ? 'The draft changed since this preview. Preview again before submitting.'
        : 'This payload matches the current draft exactly.');
    el.previewState.className = stale ? 'status is-stale' : 'status';
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

  function render() {
    var snap = snapshot();
    var status = state ? state.status : '';
    var blocked = status === 'unknown' || status === 'submitting';
    setText(el.statusLine, statusMessage());
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
    if (action === 'comment') { event_.preventDefault(); addComment(node); return; }
    if (action === 'remove-comment') { event_.preventDefault(); removeComment(node); return; }
    if (action === 'edit-comment') { event_.preventDefault(); editComment(node); return; }
    if (action === 'confirm-comment') { event_.preventDefault(); confirmComment(node); return; }
    if (action === 'reattach-comment') { event_.preventDefault(); armComment(node); return; }
    if (action === 'cancel-reattach') { event_.preventDefault(); cancelReattach(); return; }
    if (action === 'preview') { event_.preventDefault(); previewReview(); return; }
    if (action === 'submit') { event_.preventDefault(); submitReview(); return; }
    if (action === 'refresh') { event_.preventDefault(); refreshState(); return; }
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
    el.identitySection = byId('identity-section');
    el.identityBody = byId('identity-body');
    el.snapshotSection = byId('snapshot-section');
    el.snapshotBody = byId('snapshot-body');
    el.messageNote = byId('message-note');
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
h1, h2, h3, h4 { margin: 0; line-height: 1.25; }
h1 { font-size: clamp(1.3rem, 1.05rem + 1.1vw, 1.8rem); overflow-wrap: anywhere; }
h2 { font-size: 1.02rem; }
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
.brand-mark {
  width: 15px; height: 15px; flex: 0 0 auto;
  background: linear-gradient(90deg, var(--ink-soft) 0 50%, var(--teal) 50% 100%);
  clip-path: polygon(50% 0, 100% 100%, 0 100%);
}
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
  display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: baseline;
  padding: 8px 12px; background: var(--sunken); border-bottom: 1px solid var(--line);
  font-size: 13px;
}
.file-path { font-family: var(--mono); font-size: 12.5px; overflow-wrap: anywhere; min-width: 0; }
.file-count { font-size: 12px; color: var(--ink-soft); }
.diff-scroll { max-height: 65vh; overflow: auto; max-width: 100%; }
.diff-rows { width: max-content; min-width: 100%; }
.diff-row {
  display: flex; align-items: stretch; border-top: 1px solid var(--line);
  font-family: var(--mono); font-size: 12.5px; line-height: 1.5; min-height: 22px;
}
.diff-rows > .diff-row:first-child { border-top: 0; }
.diff-action {
  position: sticky; left: 0; z-index: 2; flex: 0 0 auto; width: 62px;
  border: 0; border-right: 1px solid var(--line); border-radius: 0;
  background: var(--panel); color: var(--ink-soft);
  padding: 1px 6px; font-size: 11.5px; cursor: pointer; white-space: nowrap;
}
.diff-action:hover:not(:disabled) { background: var(--sunken); color: var(--ink); }
.diff-ln { flex: 0 0 auto; width: 54px; padding: 1px 8px; text-align: right; color: var(--ink-soft); border-right: 1px solid var(--line); }
.diff-side { flex: 0 0 auto; width: 40px; padding: 1px 8px; color: var(--ink-soft); border-right: 1px solid var(--line); }
.diff-code { display: block; padding: 1px 10px; white-space: pre; }
.kind-add { background: var(--add-bg); }
.kind-delete { background: var(--del-bg); }
.kind-add .diff-action { background: var(--add-bg); }
.kind-delete .diff-action { background: var(--del-bg); }
.kind-add .diff-code { color: var(--add); }
.kind-delete .diff-code { color: var(--del); }
.editor {
  position: sticky; left: 0; z-index: 1;
  width: min(960px, calc(100vw - 96px));
  background: var(--warn-bg); border-top: 1px solid var(--line-strong);
  border-bottom: 1px solid var(--line-strong); padding: 10px 12px;
  display: flex; flex-direction: column; gap: 6px;
}
.editor-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.editor-input { flex: 1 1 240px; min-width: 0; }
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
@media (max-width: 700px) {
  .wrap { padding: 18px 12px 48px; }
  .panel { padding: 12px; }
  .facts { grid-template-columns: 1fr; }
  .editor { width: min(960px, calc(100vw - 64px)); }
  .diff-ln { width: 44px; }
}
`;
