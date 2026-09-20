/**
 * The passcode gate.
 *
 * This is a soft gate by design. The manifest and the photo files are public
 * URLs; what the gate actually buys is that the album is not readable by
 * anyone who merely loads the page, and that no thumbnail is fetched before
 * someone types the passcode. It is not, and does not pretend to be, access
 * control.
 */

const STORAGE_KEY = 'photos.unlock';

function readStored() {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStored(value) {
  try {
    window.localStorage.setItem(STORAGE_KEY, value);
  } catch {
    /* private mode; the visitor will just have to type it again */
  }
}

async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await window.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function createGate(onUnlock) {
  const root = document.documentElement;
  const gate = document.getElementById('gate');
  const expected = gate ? (gate.dataset.hash || '').trim().toLowerCase() : '';

  const release = () => {
    root.classList.remove('is-locked');
    onUnlock();
  };

  // No passcode configured, or already unlocked in this browser.
  if (!gate || !expected || readStored() === expected) {
    if (gate) gate.classList.add('is-gone');
    root.classList.add('is-unlocked');
    release();
    return;
  }

  const form = document.getElementById('gate-form');
  const input = document.getElementById('gate-input');
  const submit = document.getElementById('gate-submit');
  const error = document.getElementById('gate-error');

  const say = (message) => {
    if (error) error.textContent = message;
  };

  // crypto.subtle only exists in secure contexts. Say so instead of failing
  // silently when the site is opened over plain http from another machine.
  if (!window.crypto || !window.crypto.subtle) {
    say('当前连接不是安全连接（需要 HTTPS 或 localhost），无法校验密码。');
    if (input) input.disabled = true;
    if (submit) submit.disabled = true;
    return;
  }

  window.setTimeout(() => {
    // Not on touch: a forced keyboard on a phone hides half the overlay.
    if (input && window.matchMedia('(hover: hover) and (pointer: fine)').matches) input.focus();
  }, 60);

  const reject = () => {
    say('密码不对，再试一次。');
    if (!input) return;
    input.classList.remove('is-wrong');
    // Force a reflow so the shake animation restarts on a repeat miss.
    void input.offsetWidth;
    input.classList.add('is-wrong');
    input.select();
  };

  const accept = () => {
    writeStored(expected);
    gate.classList.add('is-gone');
    root.classList.remove('is-locked');
    // Let the fade finish before display:none takes the overlay out of flow.
    window.setTimeout(() => root.classList.add('is-unlocked'), 450);
    release();
  };

  if (input) {
    input.addEventListener('input', () => {
      input.classList.remove('is-wrong');
      say('');
    });
  }

  if (form) {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      // Trimmed because the passcode usually arrives pasted from a chat app, which
      // tends to bring a trailing space or newline along with it.
      const value = input ? input.value.trim() : '';
      if (!value) {
        reject();
        return;
      }
      if (submit) submit.disabled = true;
      try {
        const hex = await sha256Hex(value);
        if (hex === expected) accept();
        else reject();
      } catch {
        say('校验密码时出错了，请刷新页面重试。');
      } finally {
        if (submit) submit.disabled = false;
      }
    });
  }
}
