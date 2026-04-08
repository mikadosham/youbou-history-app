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
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2026-04';
const METAOBJECT_TYPE = process.env.YOUBOU_METAOBJECT_TYPE || 'youbou_history_event';
const REDIRECT_SUCCESS_URL = process.env.YOUBOU_SUCCESS_REDIRECT || '/pages/youbou-history?submitted=1';
const MAX_BODY_BYTES = 10 * 1024;
const MAX_FILE_BYTES = 15 * 1024 * 1024;

let cachedToken = null;
let tokenExpiresAt = 0;

async function getAccessToken(shop) {
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

function parseProxyQuery(rawQuery) {
  if (!rawQuery) return {};
  return querystring.parse(rawQuery);
}

function verifyShopifyProxySignature(rawQuery, secret) {
  if (!secret || !rawQuery) return false;
  const params = parseProxyQuery(rawQuery);
  const signature = params.signature;
  if (!signature || typeof signature !== 'string') return false;
  delete params.signature;
  const sorted = Object.keys(params)
    .sort()
    .map((k) => {
      const v = params[k];
      const val = Array.isArray(v) ? v.join(',') : v ?? '';
      return `${k}=${val}`;
    })
    .join('');
  const digest = crypto.createHmac('sha256', secret).update(sorted).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(digest, 'hex'), Buffer.from(signature, 'hex'));
  } catch {
    return false;
  }
}

function verifyTimestamp(params) {
  const ts = parseInt(params.timestamp, 10);
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
  if (!verifyShopifyProxySignature(q, SHOPIFY_CLIENT_SECRET) || !verifyTimestamp(params)) {
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

app.get('/proxy/health', proxyAuthMiddleware, (req, res) => {
  res.type('html').send('<p>youbou-history-app proxy OK</p>');
});

const submitMiddleware = [proxyAuthMiddleware, upload.single('image')];

async function handleSubmit(req, res) {
    try {
      if (!SHOPIFY_CLIENT_ID || !SHOPIFY_CLIENT_SECRET) {
        res.status(500).type('html').send('<p>Server misconfiguration: missing SHOPIFY_CLIENT_ID or SHOPIFY_CLIENT_SECRET</p>');
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
      const filename = `youbou-history-${Date.now()}.${ext}`;

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

app.get('/healthz', (_req, res) => {
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`youbou-history-app listening on :${PORT}`);
});
