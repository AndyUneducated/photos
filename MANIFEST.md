# `gallery/manifest.json` schema

The studio uploader writes this file; the Astro site reads it at build time. It is the only
contract between the two halves of the project, so treat it as frozen unless `version` is bumped.

```jsonc
{
  "version": 1,
  "updatedAt": "2026-09-19T21:40:11.000Z",

  "site": {
    "title": "Anning Photos",
    "tagline": "家庭相册",
    // SHA-256 (hex, lowercase) of the passcode. Empty string = no gate at all.
    "passcodeHash": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
  },

  "budgetBytes": 838860800,
  "usedBytes": 41235067,

  // Newest album first.
  "albums": [
    {
      "id": "2026-09-19-shanghai-night",     // slug, also the folder name under gallery/albums/
      "title": "上海夜色",
      "date": "2026-09-19",                  // shoot date, YYYY-MM-DD, from EXIF or user override
      "coverPhotoId": "a1b2c3d4",
      "showLocation": false,                 // per-album GPS opt-in; default false
      "photoCount": 24,
      "bytes": 11235067
    }
  ],

  // Flat list, newest first. The feed renders this directly; album pages filter by albumId.
  "photos": [
    {
      "id": "a1b2c3d4",                      // first 12 hex chars of the source file's SHA-256
      "albumId": "2026-09-19-shanghai-night",
      "web": "p/2026-09-19-shanghai-night/w/a1b2c3d4.avif",   // relative to site root
      "thumb": "p/2026-09-19-shanghai-night/t/a1b2c3d4.avif",
      "w": 2560, "h": 1707,                  // web-size pixel dimensions (post-rotation)
      "tw": 640, "th": 427,                  // thumb pixel dimensions
      "lqip": "data:image/webp;base64,UklGR...",  // ~16px blur-up placeholder, inline
      "bytes": 412331,                       // web + thumb on disk
      "takenAt": "2026-09-19T20:14:03",      // camera local time, no timezone suffix
      "caption": "",                         // optional, set in the studio
      "exif": {
        "make": "SONY",
        "model": "ILCE-7RM5",
        "lens": "FE 24-70mm F2.8 GM II",
        "fNumber": 2.8,
        "exposure": "1/125",
        "iso": 400,
        "focal": 55
      },
      // Present only when the album has showLocation === true.
      "location": { "lat": 31.2304, "lon": 121.4737, "label": "黄浦区, 上海市" }
    }
  ]
}
```

## Invariants the site can rely on

- `photos` is sorted by `takenAt` descending; `albums` likewise by `date` descending.
- Every `photo.albumId` resolves to an entry in `albums`.
- `web`/`thumb` paths are site-root-relative and always exist as files under `gallery/albums/...`;
  `scripts/collect.mjs` copies them into `dist/p/...` at build time.
- `lqip` is always present and is a tiny WebP data URI (WebP, not AVIF: it decodes faster at 16px
  and every browser that can show the page can show it).
- `exif` fields are individually optional — any of them may be missing or null.
- `location` is absent unless the album opted in.
