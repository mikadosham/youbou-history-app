# Youbou history submissions (Shopify app proxy)

Forwards `POST /apps/youbou-history/submit` from the storefront to this server, verifies the Shopify proxy signature, uploads the image to **Shopify Files**, and creates a **draft** `youbou_history_event` metaobject.

## Setup

1. **Metaobject** (Admin → Settings → Custom data): create definition `youbou_history_event` with storefront access and optional **Publishable** (for drafts). Fields: `event_date` (date), `year_display` (single line), `title` (single line), `body` (multi-line text), `image` (file), optional `submitter_email` (single line).

2. **Custom app** (Admin → Settings → Apps → Develop apps): enable Admin API scopes `write_metaobjects`, `read_metaobjects`, `write_files`, `read_files`. Install and copy the **Admin API access token**.

3. **App proxy**: In the same app, set proxy URL to your deployed server (must include path prefix used below, e.g. `https://api.example.com/proxy`). Subpath `youbou-history`, prefix `apps`. Copy the app **Client secret** (used as `SHOPIFY_CLIENT_SECRET` for HMAC).

4. **Environment**: copy `.env.example` to `.env` and fill values.  
   - Preferred: set `SHOPIFY_ADMIN_ACCESS_TOKEN` (long-lived token for Admin GraphQL calls).  
   - Required for proxy HMAC verification: `SHOPIFY_CLIENT_SECRET`.  
   - Optional fallback token flow: `SHOPIFY_CLIENT_ID` + `SHOPIFY_CLIENT_SECRET`.

5. **Run**: `npm install && npm start` (or deploy behind HTTPS).

6. **Theme**: use template `youbou-history` on the history page; section setting “App proxy subpath” must stay `youbou-history` unless you change the app proxy subpath in Shopify.

## Local development

Expose port 8787 with a tunnel, set `app_proxy.url` in `shopify.app.toml` / Partner Dashboard to `https://<tunnel>/proxy`, reinstall or update the app proxy if needed, then submit the form on the dev storefront.

## Health

- `GET /healthz` — no auth (for hosting checks).
- `GET /apps/youbou-history/health` on the shop only works when called through the proxy with a valid signature (use Shopify).
