/**
 * PhotoSwipe v5, bundled by Astro (never a CDN).
 *
 * The gallery is DOM-driven (`gallery` + `children`) rather than fed a JS
 * data source, which is what gives us the zoom-from-thumbnail animation for
 * free and keeps the counter honest when an album filter is active — the
 * `:not(.is-hidden)` in the child selector means PhotoSwipe only ever sees
 * the photos currently on screen.
 *
 * Caption text is pre-formatted at build time and read from a JSON island,
 * so no formatting code ships to the browser.
 */
import PhotoSwipeLightbox from 'photoswipe/lightbox';
import 'photoswipe/style.css';

const ICON_DOWNLOAD = `<svg class="pswp__icn pswp-icn" viewBox="0 0 32 32" width="32" height="32" aria-hidden="true">
<path d="M16 7v13.6"/><path d="M10.6 15.2L16 20.6l5.4-5.4"/><path d="M7.4 23v1.6c0 .9.7 1.6 1.6 1.6h14c.9 0 1.6-.7 1.6-1.6V23"/></svg>`;

const ICON_INFO = `<svg class="pswp__icn pswp-icn" viewBox="0 0 32 32" width="32" height="32" aria-hidden="true">
<circle cx="16" cy="16" r="10.4"/><path d="M16 21.6v-6.4"/><path d="M16 11.1h.01"/></svg>`;

function readMeta() {
  const node = document.getElementById('photo-meta');
  if (!node) return {};
  try {
    return JSON.parse(node.textContent || '{}');
  } catch {
    return {};
  }
}

export function createLightbox({ gallery, onPhotoChange }) {
  if (!gallery) return { openById: () => false };

  const meta = readMeta();
  let infoOpen = false;
  let infoButton = null;
  let captionEl = null;

  const lightbox = new PhotoSwipeLightbox({
    gallery,
    children: 'a.tile:not(.is-hidden)',
    pswpModule: () => import('photoswipe'),
    showHideAnimationType: 'zoom',
    bgOpacity: 1,
    wheelToZoom: true,
    // The dark chrome is already very quiet; don't also dim the photo.
    imageClickAction: 'zoom-or-close',
    closeTitle: '关闭',
    zoomTitle: '缩放',
    arrowPrevTitle: '上一张',
    arrowNextTitle: '下一张',
    errorMsg: '这张照片加载失败了',
    indexIndicatorSep: ' / ',
  });

  const currentId = (pswp) => {
    const element = pswp.currSlide && pswp.currSlide.data && pswp.currSlide.data.element;
    return element ? element.dataset.id || null : null;
  };

  function syncInfoButton() {
    if (infoButton) {
      infoButton.classList.toggle('is-active', infoOpen);
      infoButton.setAttribute('aria-pressed', String(infoOpen));
    }
  }

  function renderCaption(pswp) {
    if (!captionEl) return;
    captionEl.replaceChildren();

    const info = meta[currentId(pswp)];
    if (!info) return;

    const inner = document.createElement('div');
    inner.className = 'pswp-caption__inner';

    const line = (className, text) => {
      if (!text) return;
      const el = document.createElement('p');
      el.className = className;
      el.textContent = text;
      el.style.margin = '0';
      inner.append(el);
    };

    line('pswp-caption__date', info.date);
    line('pswp-caption__text', info.caption);
    // Omitted entirely when the uploader found no EXIF at all.
    line('pswp-caption__exif', info.exif);

    if (info.locUrl) {
      const link = document.createElement('a');
      link.className = 'pswp-caption__loc';
      link.href = info.locUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = info.loc || '在地图上查看';
      inner.append(link);
    }

    if (inner.childElementCount) captionEl.append(inner);
  }

  lightbox.on('uiRegister', () => {
    const pswp = lightbox.pswp;

    pswp.ui.registerElement({
      name: 'download',
      ariaLabel: '下载这张照片',
      title: '下载',
      order: 8,
      isButton: true,
      tagName: 'a',
      html: ICON_DOWNLOAD,
      onInit: (el) => {
        // A real <a download>, not a JS blob dance: this is the one form that
        // actually saves a file on iOS Safari.
        el.setAttribute('rel', 'noopener');
        el.setAttribute('target', '_blank');
        const sync = () => {
          const data = pswp.currSlide && pswp.currSlide.data;
          const id = currentId(pswp);
          el.href = (data && data.src) || '#';
          el.setAttribute('download', id ? id + '.avif' : '');
        };
        pswp.on('change', sync);
        sync();
      },
    });

    pswp.ui.registerElement({
      name: 'pswp-info',
      ariaLabel: '照片信息',
      title: '信息',
      order: 9,
      isButton: true,
      html: ICON_INFO,
      onInit: (el) => {
        infoButton = el;
        syncInfoButton();
      },
      onClick: () => {
        infoOpen = !infoOpen;
        pswp.element.classList.toggle('pswp--info-open', infoOpen);
        syncInfoButton();
      },
    });

    pswp.ui.registerElement({
      name: 'caption',
      order: 10,
      isButton: false,
      appendTo: 'root',
      onInit: (el) => {
        el.classList.add('pswp-caption');
        captionEl = el;
        renderCaption(pswp);
      },
    });
  });

  lightbox.on('change', () => {
    const pswp = lightbox.pswp;
    if (!pswp) return;
    renderCaption(pswp);
    onPhotoChange(currentId(pswp));
  });

  lightbox.on('close', () => {
    infoOpen = false;
    infoButton = null;
    captionEl = null;
    onPhotoChange(null);
  });

  lightbox.init();

  /** Open a specific photo by manifest id, used for `#p=<id>` deep links. */
  function openById(id) {
    const index = Array.from(gallery.querySelectorAll('a.tile:not(.is-hidden)')).findIndex(
      (el) => el.dataset.id === id,
    );
    if (index < 0) return false;
    return lightbox.loadAndOpen(index, { gallery });
  }

  return { openById };
}
