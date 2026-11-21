import { OPENAPI_PATH } from './openapi.js';

/**
 * The Swagger UI page, served at /docs. Pure HTML that loads Swagger UI's assets
 * from a pinned cdnjs version and points the viewer at /openapi.json. No node
 * imports and no dependency, so it is mounted directly in createApp (public,
 * next to /openapi.json) and testable through buildTestApp.
 *
 * Trade-off: the page needs internet to render (the CDN assets). /openapi.json
 * is unaffected and stays self-contained.
 */
const SWAGGER_UI_VERSION = '5.35.0';
const CDN = `https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/${SWAGGER_UI_VERSION}`;

export const SWAGGER_UI_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Tower of Habit API — Docs</title>
    <link rel="stylesheet" href="${CDN}/swagger-ui.min.css" />
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="${CDN}/swagger-ui-bundle.min.js" crossorigin></script>
    <script src="${CDN}/swagger-ui-standalone-preset.min.js" crossorigin></script>
    <script>
      window.ui = SwaggerUIBundle({
        url: '${OPENAPI_PATH}',
        dom_id: '#swagger-ui',
        presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
        layout: 'StandaloneLayout',
      });
    </script>
  </body>
</html>`;
