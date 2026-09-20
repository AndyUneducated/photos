// @ts-check
import { defineConfig } from 'astro/config';

// The site lives under site/ so that studio/ and scripts/ stay out of Astro's way.
// Real gallery photos are NOT in publicDir; scripts/collect.mjs copies them into
// dist/p/... after `astro build`. Nothing here may import image files.
export default defineConfig({
  site: 'https://photos.anning.org',
  base: '/',
  output: 'static',
  srcDir: './site/src',
  publicDir: './site/public',
  outDir: './dist',
  trailingSlash: 'ignore',
  devToolbar: { enabled: false },
  build: {
    assets: '_assets',
    inlineStylesheets: 'auto',
  },
});
