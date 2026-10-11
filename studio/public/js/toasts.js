/**
 * A stack of dismissible messages rather than one shared line.
 *
 * Long jobs need a message that stays put and mutates in place (uploading -> processing ->
 * published), while a failure needs to survive whatever status update comes next. Both fall out
 * of returning a handle: keep it to update or close that toast, drop it to fire and forget.
 *
 * Successes clear themselves. Errors never do — a failed photo is something to act on.
 */

import { errorPayload } from './api.js';
import { $ } from './core.js';

const DISMISS_MS = { ok: 4500, info: 3500, progress: 0, error: 0 };

export function toast(message, kind = 'info') {
  const el = document.createElement('div');
  el.className = `toast toast--${kind}`;

  const icon = document.createElement('span');
  icon.className = 'toast__icon';
  icon.setAttribute('aria-hidden', 'true');

  const body = document.createElement('div');
  body.className = 'toast__body';

  const text = document.createElement('p');
  text.className = 'toast__text';
  text.textContent = message;

  // Everything below the headline is rebuilt on each update; the headline node stays put so
  // screen readers announce changes to it rather than a whole new toast.
  const extra = document.createElement('div');
  extra.className = 'toast__extra';
  body.append(text, extra);

  const close = document.createElement('button');
  close.className = 'toast__close';
  close.type = 'button';
  close.setAttribute('aria-label', 'Close');
  close.textContent = '\u00d7';

  el.append(icon, body, close);
  $('toasts').append(el);
  // Next frame, so the entry transition has a start state to animate from.
  requestAnimationFrame(() => el.classList.add('is-in'));

  let timer = null;
  const handle = {
    update(nextMessage, nextKind = kind) {
      text.textContent = nextMessage;
      el.className = `toast toast--${nextKind} is-in`;
      kind = nextKind;
      extra.replaceChildren();
      handle.arm();
      return handle;
    },
    /** Shows the milestones of a server operation; see renderSteps. */
    steps(steps) {
      extra.replaceChildren(renderSteps(steps));
      return handle;
    },
    /** Turns this toast into an error: headline, what went wrong, what to do, and the raw detail. */
    fail(headline, err) {
      const payload = errorPayload(err);
      handle.update(headline, 'error');
      extra.append(errorBlock(payload));
      return handle;
    },
    /** Adds a button, e.g. "Upload now". */
    action(label, onClick) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'toast__action';
      btn.textContent = label;
      btn.onclick = () => { handle.close(); onClick(); };
      extra.append(btn);
      return handle;
    },
    arm() {
      clearTimeout(timer);
      const ms = DISMISS_MS[kind] ?? 0;
      if (ms) timer = setTimeout(handle.close, ms);
      return handle;
    },
    close() {
      clearTimeout(timer);
      el.classList.remove('is-in');
      el.addEventListener('transitionend', () => el.remove(), { once: true });
      // transitionend never fires if the element is already hidden or motion is reduced.
      setTimeout(() => el.remove(), 400);
    },
  };

  close.addEventListener('click', handle.close);
  return handle.arm();
}

const STEP_MARK = { pending: '○', running: '◌', done: '✓', skipped: '–', failed: '✕', cancelled: '–' };

function renderSteps(steps) {
  const ol = document.createElement('ol');
  ol.className = 'steps';
  for (const step of steps) {
    const li = document.createElement('li');
    li.className = `step step--${step.state}`;

    const mark = document.createElement('span');
    mark.className = 'step__mark';
    mark.setAttribute('aria-hidden', 'true');
    mark.textContent = STEP_MARK[step.state] || '○';

    const label = document.createElement('span');
    label.className = 'step__label';
    label.textContent = step.label;
    if (step.state === 'running' && step.startedAt) {
      const secs = Math.round((Date.now() - step.startedAt) / 1000);
      if (secs >= 3) label.textContent += ` (${secs}s)`;
    }

    li.append(mark, label);
    if (step.detail && step.state !== 'pending') {
      const detail = document.createElement('span');
      detail.className = 'step__detail';
      detail.textContent = step.detail;
      li.append(detail);
    }
    if (step.state === 'running' && typeof step.progress === 'number') {
      const bar = document.createElement('span');
      bar.className = 'step__bar';
      const fill = document.createElement('i');
      fill.style.width = `${Math.round(step.progress * 100)}%`;
      bar.append(fill);
      li.append(bar);
    }
    ol.append(li);
  }
  return ol;
}

/** The readable part of an error, plus a collapsed, copyable block for debugging. */
function errorBlock(payload) {
  const wrap = document.createElement('div');
  wrap.className = 'errblock';

  const what = document.createElement('p');
  what.className = 'errblock__what';
  what.textContent = payload.error;
  wrap.append(what);

  if (payload.hint) {
    const hint = document.createElement('p');
    hint.className = 'errblock__hint';
    hint.textContent = payload.hint;
    wrap.append(hint);
  }

  if (payload.steps) wrap.append(renderSteps(payload.steps));

  const debug = { code: payload.code, ...(payload.rolledBack ? { rolledBack: true } : {}), ...(payload.detail || {}) };
  wrap.append(detailsBlock(debug));
  return wrap;
}

export function detailsBlock(debug) {
  const details = document.createElement('details');
  details.className = 'errblock__details';
  const summary = document.createElement('summary');
  summary.textContent = 'Technical details';
  const pre = document.createElement('pre');
  const text = JSON.stringify(debug, null, 2);
  pre.textContent = text;
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'errblock__copy';
  copy.textContent = 'Copy';
  copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(text);
      copy.textContent = 'Copied';
    } catch {
      copy.textContent = 'Select the text and copy it';
    }
  };
  details.append(summary, copy, pre);
  return details;
}
