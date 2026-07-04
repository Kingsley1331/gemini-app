# TODO

## Migrate preview sandbox to Babel 8

The preview sandbox currently pins `@babel/standalone` to version 7 on the CDN
(`https://unpkg.com/@babel/standalone@7/babel.min.js`). This was done because
Babel 8 removed the `isTSX` and `allExtensions` options from
`@babel/preset-typescript`, which broke live previews with:

> Uncaught Error: [BABEL] /Inline Babel script: @babel/preset-typescript:
> The .allExtensions and .isTSX options have been removed.

### Long-term fix

Migrate the custom `tsx` preset to Babel 8:

- Update the preset registration (in `src/components/CodePreview.tsx` and
  `src/app/preview/[id]/PreviewClient.tsx`) to stop passing `isTSX` and
  `allExtensions`. Per the Babel 8 migration notes: JSX detection is now on by
  default; to force JSX parsing, enable the `@babel/plugin-syntax-jsx` plugin
  instead.
- Change the CDN URL pin from `@babel/standalone@7` to `@babel/standalone@8`
  (or a specific 8.x version for reproducible previews) in all 5 references,
  including the `CDN_URLS` offline-cache list in `PreviewClient.tsx`.
- Test all preview paths: inline chat previews, the Studio preview, and the
  standalone/PWA preview page (including offline mode, which caches the Babel
  script URL in the service worker cache).
