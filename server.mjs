/**
 * Shopify app proxy handler: multipart form → staged upload → fileCreate → metaobjectCreate (draft).
 * Configure App proxy: prefix apps, subpath youbou-history → POST /apps/youbou-history/submit → this server /proxy/submit (or /submit).
 */
import crypto from 'crypto';
import { File } from 'node:buffer';
import express from 'express';
import multer from 'multer';
import querystring from 'querystring';

const PORT = Number(process.env.PORT || 8787);
const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID || '';
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET || '';
const SHOPIFY_ADMIN_ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || '';
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2026-04';
const METAOBJECT_TYPE = process.env.YOUBOU_METAOBJECT_TYPE || 'youbou_history_event';
const REDIRECT_SUCCESS_URL = process.env.YOUBOU_SUCCESS_REDIRECT || '/pages/youbou-history?submitted=1';
const SHOPIFY_SCOPES = process.env.SHOPIFY_SCOPES || 'write_metaobjects,read_metaobjects,write_files,read_files';
const SHOPIFY_APP_URL = process.env.SHOPIFY_APP_URL || '';
const MAX_BODY_BYTES = 10 * 1024;
const MAX_FILE_BYTES = 15 * 1024 * 1024;

let cachedToken = null;
let tokenExpiresAt = 0;

async function getAccessToken(shop) {
  // Preferred for custom apps: use the long-lived Admin API access token directly.
  if (SHOPIFY_ADMIN_ACCESS_TOKEN) return SHOPIFY_ADMIN_ACCESS_TOKEN;

  if (cachedToken && Date.now() < tokenExpiresAt - 60_000) return cachedToken;

  const response = await fetch(
    `https://${shop}/admin/oauth/access_token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: SHOPIFY_CLIENT_ID,
        client_secret: SHOPIFY_CLIENT_SECRET,
      }),
    },
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token request failed (${response.status}): ${text}`);
  }

  const { access_token, expires_in } = await response.json();
  cachedToken = access_token;
  tokenExpiresAt = Date.now() + expires_in * 1000;
  return cachedToken;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, fieldSize: MAX_BODY_BYTES },
});

const app = express();

app.get('/', (req, res) => {
  const shop = typeof req.query?.shop === 'string' ? req.query.shop : '';
  const host = typeof req.query?.host === 'string' ? req.query.host : '';
  const shopValid = shop && /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shop);

  // Embedded admin context: serve App Bridge bootstrap that token-exchanges and logs the offline token.
  if (shopValid && host && SHOPIFY_CLIENT_ID) {
    res
      .type('html')
      .set('Content-Security-Policy', `frame-ancestors https://${shop} https://admin.shopify.com`)
      .send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Youbou History App — Token Bootstrap</title>
    <meta name="shopify-api-key" content="${SHOPIFY_CLIENT_ID}" />
    <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 2rem; line-height: 1.5; }
      pre { background: #f6f6f7; padding: 1rem; border-radius: 6px; white-space: pre-wrap; }
    </style>
  </head>
  <body>
    <h1>Youbou History App</h1>
    <p id="status">Requesting session token…</p>
    <pre id="output"></pre>
    <script>
      (async () => {
        const status = document.getElementById('status');
        const output = document.getElementById('output');
        try {
          const token = await shopify.idToken();
          status.textContent = 'Exchanging session token for offline access token…';
          const res = await fetch('/token-exchange', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
            body: JSON.stringify({ shop: ${JSON.stringify(shop)} }),
          });
          const data = await res.json();
          if (!res.ok) {
            status.textContent = 'Token exchange failed.';
            output.textContent = JSON.stringify(data, null, 2);
            return;
          }
          status.textContent = 'Done. Check Railway logs for SHOPIFY_ADMIN_ACCESS_TOKEN, paste it into your env vars.';
          output.textContent = 'scope: ' + (data.scope || '(unknown)');
        } catch (e) {
          status.textContent = 'Error: ' + (e && e.message ? e.message : String(e));
        }
      })();
    </script>
  </body>
</html>`);
    return;
  }

  // Non-embedded fallback (e.g. visited directly).
  res.type('html').send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Youbou History App</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 2rem; line-height: 1.5; }
      code { background: #f6f6f7; border-radius: 4px; padding: 0.1rem 0.3rem; }
    </style>
  </head>
  <body>
    <h1>Youbou History App</h1>
    <p>The service is running and ready to receive app proxy submissions.</p>
    <p>Shop context: <code>${shopValid ? shop : 'unknown'}</code></p>
    <p>Submit endpoint: <code>POST /proxy/submit</code> (Shopify app proxy)</p>
    <p>Health check: <code>GET /healthz</code></p>
  </body>
</html>`);
});

app.post('/token-exchange', express.json(), async (req, res) => {
  try {
    const auth = req.headers.authorization || '';
    const sessionToken = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const shop = typeof req.body?.shop === 'string' ? req.body.shop : '';
    if (!sessionToken) return res.status(401).json({ error: 'missing_session_token' });
    if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shop)) {
      return res.status(400).json({ error: 'invalid_shop' });
    }
    if (!SHOPIFY_CLIENT_ID || !SHOPIFY_CLIENT_SECRET) {
      return res.status(500).json({ error: 'missing_client_credentials' });
    }
    const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        client_id: SHOPIFY_CLIENT_ID,
        client_secret: SHOPIFY_CLIENT_SECRET,
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        subject_token: sessionToken,
        subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
        requested_token_type: 'urn:shopify:params:oauth:token-type:offline-access-token',
      }),
    });
    const data = await tokenRes.json();
    if (!tokenRes.ok || !data.access_token) {
      console.error('[token-exchange] failed', tokenRes.status, data);
      return res.status(500).json({ error: 'exchange_failed', details: data });
    }
    console.log('=================================================');
    console.log(`[token-exchange] shop=${shop}`);
    console.log(`[token-exchange] SHOPIFY_ADMIN_ACCESS_TOKEN=${data.access_token}`);
    console.log(`[token-exchange] scope=${data.scope}`);
    console.log('Copy the token above into your Railway env as SHOPIFY_ADMIN_ACCESS_TOKEN.');
    console.log('=================================================');
    return res.json({ ok: true, scope: data.scope });
  } catch (e) {
    console.error('[token-exchange] error', e);
    return res.status(500).json({ error: 'internal', message: String(e?.message || e) });
  }
});

function parseProxyQuery(rawQuery) {
  if (!rawQuery) return {};
  return querystring.parse(rawQuery);
}

function timingSafeEqualHex(expectedHex, providedHex) {
  if (!expectedHex || !providedHex) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expectedHex, 'hex'), Buffer.from(providedHex, 'hex'));
  } catch {
    return false;
  }
}

function buildCanonicalProxyString(params) {
  return Object.keys(params)
    .sort()
    .map((k) => {
      const v = params[k];
      const val = Array.isArray(v) ? v.join(',') : v ?? '';
      return `${k}=${val}`;
    })
    .join('');
}

function verifyShopifyProxySignature(rawQuery, secret) {
  if (!secret || !rawQuery) return { valid: false, reason: 'missing_secret_or_query' };
  const params = parseProxyQuery(rawQuery);

  const signature = typeof params.signature === 'string' ? params.signature : '';
  const hmac = typeof params.hmac === 'string' ? params.hmac : '';
  if (!signature && !hmac) return { valid: false, reason: 'missing_signature_and_hmac' };

  delete params.signature;
  delete params.hmac;

  const sorted = buildCanonicalProxyString(params);
  const digestHex = crypto.createHmac('sha256', secret).update(sorted).digest('hex');

  if (signature && timingSafeEqualHex(digestHex, signature)) {
    return { valid: true, reason: 'signature_ok' };
  }
  if (hmac && timingSafeEqualHex(digestHex, hmac)) {
    return { valid: true, reason: 'hmac_ok' };
  }
  return { valid: false, reason: 'digest_mismatch' };
}

function verifyTimestamp(params) {
  if (params.timestamp == null || params.timestamp === '') return true;
  const ts = parseInt(String(params.timestamp), 10);
  if (Number.isNaN(ts)) return false;
  const now = Math.floor(Date.now() / 1000);
  return Math.abs(now - ts) <= 300;
}

function proxyAuthMiddleware(req, res, next) {
  if (!SHOPIFY_CLIENT_SECRET) {
    res.status(500).type('html').send('<p>Server misconfiguration: missing SHOPIFY_CLIENT_SECRET</p>');
    return;
  }
  const q = req.url.includes('?') ? req.url.split('?')[1] : '';
  const params = parseProxyQuery(q);
  const signatureCheck = verifyShopifyProxySignature(q, SHOPIFY_CLIENT_SECRET);
  const timestampOk = verifyTimestamp(params);
  if (!signatureCheck.valid || !timestampOk) {
    const queryKeys = Object.keys(params).sort().join(',');
    console.warn(
      `[proxy-auth] failed path=${req.path} shop=${params.shop || 'unknown'} reason=${signatureCheck.reason} timestamp_ok=${timestampOk} query_keys=${queryKeys}`,
    );
    res.status(401).type('html').send('<p>Unauthorized</p>');
    return;
  }
  req.proxyShop = params.shop;
  next();
}

async function adminGraphql(shop, query, variables) {
  const accessToken = await getAccessToken(shop);
  const url = `https://${shop}/admin/api/${API_VERSION}/graphql.json`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': accessToken,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${JSON.stringify(json)}`);
  }
  if (json.errors?.length) {
    throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
  }
  return json.data;
}

async function uploadImageToShopify(shop, buffer, filename, mimeType) {
  const stagedData = await adminGraphql(
    shop,
    `mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets { url resourceUrl parameters { name value } }
        userErrors { field message }
      }
    }`,
    {
      input: [
        {
          filename,
          mimeType,
          httpMethod: 'POST',
          resource: 'IMAGE',
          fileSize: String(buffer.length),
        },
      ],
    },
  );

  const target = stagedData?.stagedUploadsCreate?.stagedTargets?.[0];
  const errs = stagedData?.stagedUploadsCreate?.userErrors;
  if (errs?.length) throw new Error(errs.map((e) => e.message).join('; '));
  if (!target?.url) throw new Error('stagedUploadsCreate returned no target');

  const form = new FormData();
  for (const p of target.parameters || []) {
    form.append(p.name, p.value);
  }
  form.append('file', new File([buffer], filename, { type: mimeType }));

  const up = await fetch(target.url, { method: 'POST', body: form });
  if (!up.ok) {
    const t = await up.text();
    throw new Error(`Staged upload failed: ${up.status} ${t}`);
  }

  const fileData = await adminGraphql(
    shop,
    `mutation fileCreate($files: [FileCreateInput!]!) {
      fileCreate(files: $files) {
        files {
          ... on MediaImage { id }
          ... on GenericFile { id }
        }
        userErrors { field message }
      }
    }`,
    { files: [{ contentType: 'IMAGE', originalSource: target.resourceUrl }] },
  );

  const ferrs = fileData?.fileCreate?.userErrors;
  if (ferrs?.length) throw new Error(ferrs.map((e) => e.message).join('; '));
  const file = fileData?.fileCreate?.files?.[0];
  if (!file?.id) throw new Error('fileCreate returned no file id');
  return file.id;
}

async function createDraftMetaobject(shop, fields) {
  const mutation = `mutation metaobjectCreate($metaobject: MetaobjectCreateInput!) {
    metaobjectCreate(metaobject: $metaobject) {
      metaobject { id handle }
      userErrors { field message code }
    }
  }`;

  const withDraft = {
    metaobject: {
      type: METAOBJECT_TYPE,
      handle: `submission-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
      capabilities: {
        publishable: {
          status: 'DRAFT',
        },
      },
      fields,
    },
  };

  let data = await adminGraphql(shop, mutation, withDraft);
  let userErrors = data?.metaobjectCreate?.userErrors;
  if (userErrors?.length && userErrors.some((e) => /publishable|capability/i.test(e.message))) {
    data = await adminGraphql(shop, mutation, {
      metaobject: {
        type: METAOBJECT_TYPE,
        handle: withDraft.metaobject.handle,
        fields,
      },
    });
    userErrors = data?.metaobjectCreate?.userErrors;
  }
  if (userErrors?.length) {
    throw new Error(userErrors.map((e) => e.message).join('; '));
  }
  return data.metaobjectCreate.metaobject;
}

// One-shot OAuth install flow to capture an Admin API access token.
// 1. In Partners → App setup, set Allowed redirection URL to `${SHOPIFY_APP_URL}/auth/callback`.
// 2. Visit `${SHOPIFY_APP_URL}/auth?shop=your-store.myshopify.com` to install.
// 3. The callback logs the access token to stdout — copy into .env as SHOPIFY_ADMIN_ACCESS_TOKEN.
app.get('/auth', (req, res) => {
  const shop = String(req.query?.shop || '');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shop)) {
    res.status(400).type('html').send('<p>Pass ?shop=your-store.myshopify.com</p>');
    return;
  }
  if (!SHOPIFY_CLIENT_ID || !SHOPIFY_APP_URL) {
    res.status(500).type('html').send('<p>Set SHOPIFY_CLIENT_ID and SHOPIFY_APP_URL in .env</p>');
    return;
  }
  const state = crypto.randomBytes(16).toString('hex');
  const redirectUri = `${SHOPIFY_APP_URL.replace(/\/$/, '')}/auth/callback`;
  const installUrl =
    `https://${shop}/admin/oauth/authorize?` +
    new URLSearchParams({
      client_id: SHOPIFY_CLIENT_ID,
      scope: SHOPIFY_SCOPES,
      redirect_uri: redirectUri,
      state,
    }).toString();
  res.redirect(302, installUrl);
});

app.get('/auth/callback', async (req, res) => {
  try {
    const { shop, code, hmac, ...rest } = req.query || {};
    if (typeof shop !== 'string' || typeof code !== 'string' || typeof hmac !== 'string') {
      res.status(400).type('html').send('<p>Missing shop/code/hmac</p>');
      return;
    }
    if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shop)) {
      res.status(400).type('html').send('<p>Invalid shop</p>');
      return;
    }
    const params = { shop, code, ...rest };
    const message = Object.keys(params)
      .sort()
      .map((k) => `${k}=${Array.isArray(params[k]) ? params[k].join(',') : params[k]}`)
      .join('&');
    const digest = crypto.createHmac('sha256', SHOPIFY_CLIENT_SECRET).update(message).digest('hex');
    if (!timingSafeEqualHex(digest, hmac)) {
      res.status(401).type('html').send('<p>HMAC mismatch</p>');
      return;
    }
    const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: SHOPIFY_CLIENT_ID,
        client_secret: SHOPIFY_CLIENT_SECRET,
        code,
      }),
    });
    const tokenJson = await tokenRes.json();
    if (!tokenRes.ok || !tokenJson.access_token) {
      console.error('[oauth] token exchange failed', tokenRes.status, tokenJson);
      res.status(500).type('html').send('<p>Token exchange failed</p>');
      return;
    }
    console.log('=================================================');
    console.log(`[oauth] shop=${shop}`);
    console.log(`[oauth] SHOPIFY_ADMIN_ACCESS_TOKEN=${tokenJson.access_token}`);
    console.log(`[oauth] scope=${tokenJson.scope}`);
    console.log('Copy the token above into your .env file.');
    console.log('=================================================');
    res
      .type('html')
      .send('<p>Install complete. Check the server logs for the access token, then paste it into <code>.env</code> as <code>SHOPIFY_ADMIN_ACCESS_TOKEN</code>.</p>');
  } catch (e) {
    console.error(e);
    res.status(500).type('html').send('<p>OAuth callback error</p>');
  }
});

app.get('/proxy/health', proxyAuthMiddleware, (req, res) => {
  res.type('html').send('<p>youbou-history-app proxy OK</p>');
});

const submitMiddleware = [proxyAuthMiddleware, upload.single('image')];

async function handleSubmit(req, res) {
    try {
      if (!SHOPIFY_ADMIN_ACCESS_TOKEN && (!SHOPIFY_CLIENT_ID || !SHOPIFY_CLIENT_SECRET)) {
        res
          .status(500)
          .type('html')
          .send('<p>Server misconfiguration: set SHOPIFY_ADMIN_ACCESS_TOKEN or both SHOPIFY_CLIENT_ID/SHOPIFY_CLIENT_SECRET</p>');
        return;
      }

      const shop = req.proxyShop;
      if (!shop || !/\.myshopify\.com$/.test(shop)) {
        res.status(400).type('html').send('<p>Invalid shop</p>');
        return;
      }

      if (req.body?.website) {
        res.redirect(302, REDIRECT_SUCCESS_URL);
        return;
      }

      const year = parseInt(String(req.body?.year || ''), 10);
      const body = String(req.body?.body || '').trim();
      const title = String(req.body?.title || '').trim().slice(0, 200);
      const submitterEmail = String(req.body?.submitter_email || '').trim().slice(0, 200);

      if (Number.isNaN(year) || year < 1800 || year > 2100 || !body || !req.file) {
        res.status(400).type('html').send('<p>Missing or invalid year, description, or image.</p>');
        return;
      }

      const allowed = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
      const mime = req.file.mimetype || 'application/octet-stream';
      if (!allowed.has(mime)) {
        res.status(400).type('html').send('<p>Unsupported image type.</p>');
        return;
      }

      const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : mime === 'image/gif' ? 'gif' : 'jpg';
      const slug = title
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80) || 'untitled';
      const filename = `youbou_history-${slug}.${ext}`;

      const imageGid = await uploadImageToShopify(shop, req.file.buffer, filename, mime);

      const eventDate = `${year}-01-01`;
      const fields = [
        { key: 'event_date', value: eventDate },
        { key: 'year_display', value: String(year) },
        { key: 'title', value: title },
        { key: 'body', value: body },
        { key: 'image', value: imageGid },
      ];
      if (submitterEmail) {
        fields.push({ key: 'submitter_email', value: submitterEmail });
      }

      try {
        await createDraftMetaobject(shop, fields);
      } catch (err) {
        const msg = String(err.message || err);
        if (submitterEmail && /submitter_email|unknown field/i.test(msg)) {
          await createDraftMetaobject(shop, fields.filter((f) => f.key !== 'submitter_email'));
        } else {
          throw err;
        }
      }

      res.redirect(302, REDIRECT_SUCCESS_URL);
    } catch (e) {
      console.error(e);
      res
        .status(500)
        .type('html')
        .send(`<p>Could not save submission. Please try again later.</p><!-- ${String(e.message).slice(0, 200)} -->`);
    }
}

app.post('/proxy/submit', ...submitMiddleware, handleSubmit);
app.post('/submit', ...submitMiddleware, handleSubmit);

const addImageMiddleware = [proxyAuthMiddleware, upload.single('image')];

async function handleAddImage(req, res) {
  try {
    if (!SHOPIFY_ADMIN_ACCESS_TOKEN && (!SHOPIFY_CLIENT_ID || !SHOPIFY_CLIENT_SECRET)) {
      res.status(500).type('html').send('<p>Server misconfiguration</p>');
      return;
    }

    const shop = req.proxyShop;
    if (!shop || !/\.myshopify\.com$/.test(shop)) {
      res.status(400).type('html').send('<p>Invalid shop</p>');
      return;
    }

    const handle = String(req.body?.handle || '').trim();
    if (!handle) {
      res.status(400).type('html').send('<p>Missing handle</p>');
      return;
    }

    if (!req.file) {
      res.status(400).type('html').send('<p>Missing image</p>');
      return;
    }

    const allowed = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
    const mime = req.file.mimetype || 'application/octet-stream';
    if (!allowed.has(mime)) {
      res.status(400).type('html').send('<p>Unsupported image type</p>');
      return;
    }

    const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : mime === 'image/gif' ? 'gif' : 'jpg';
    const filename = `youbou_history-${handle}.${ext}`;

    const imageGid = await uploadImageToShopify(shop, req.file.buffer, filename, mime);

    // Look up metaobject by handle.
    const lookupData = await adminGraphql(
      shop,
      `query($type: String!, $handle: String!) {
        metaobjectByHandle(handle: { type: $type, handle: $handle }) {
          id
        }
      }`,
      { type: METAOBJECT_TYPE, handle },
    );

    const metaId = lookupData?.metaobjectByHandle?.id;
    if (!metaId) {
      res.status(404).type('html').send('<p>Entry not found</p>');
      return;
    }

    // Update metaobject with image.
    const updateData = await adminGraphql(
      shop,
      `mutation metaobjectUpdate($id: ID!, $metaobject: MetaobjectUpdateInput!) {
        metaobjectUpdate(id: $id, metaobject: $metaobject) {
          metaobject { id }
          userErrors { field message }
        }
      }`,
      {
        id: metaId,
        metaobject: {
          fields: [{ key: 'image', value: imageGid }],
        },
      },
    );

    const errs = updateData?.metaobjectUpdate?.userErrors;
    if (errs?.length) {
      throw new Error(errs.map((e) => e.message).join('; '));
    }

    res.json({ ok: true });
  } catch (e) {
    console.error('[add-image]', e);
    res.status(500).type('html').send('<p>Could not add image</p>');
  }
}

app.post('/proxy/add-image', ...addImageMiddleware, handleAddImage);
app.post('/add-image', ...addImageMiddleware, handleAddImage);

app.get('/healthz', (_req, res) => {
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`youbou-history-app listening on :${PORT}`);
});
