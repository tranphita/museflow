# Museta — Requirements

## Required

1. Google Chrome or another Chromium browser with Manifest V3 support
2. A Muse.ai account
3. A signed-in Muse chat tab in the same browser profile

Museta has **no runtime dependencies** and no build step. The folder is a loadable Chrome extension. After replacing files, click **Reload** on the extensions page and reload the Muse tab.

Museta uses the signed-in Muse.ai tab directly; it does not need a local backend or API key. Keep the Muse chat tab open while generating. Text-to-image, text-to-video and reference images are supported. The integration follows Muse's current page UI; if Muse changes it, **Settings → Check Muse session** shows which page hooks in `bridge/muse-ui.js` need updating.

## Development only

Node.js 22+ for `npm test`. Lint and format run through `npx` and are not installed into the project.
