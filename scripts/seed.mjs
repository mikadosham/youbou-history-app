/**
 * One-shot seeder for Youbou history timeline.
 * Parses the legacy HTML timeline and creates draft metaobjects in Shopify.
 *
 * Usage:
 *   SHOPIFY_SHOP=3e1248-2.myshopify.com \
 *   SHOPIFY_ADMIN_ACCESS_TOKEN=shpua_xxx \
 *   node scripts/seed.mjs
 *
 * Optional:
 *   SHOPIFY_API_VERSION (default 2026-04)
 *   YOUBOU_METAOBJECT_TYPE (default youbou_history_event)
 *   DRY_RUN=1 to print parsed entries without writing
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SHOP = process.env.SHOPIFY_SHOP || '';
const TOKEN = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || '';
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2026-04';
const METAOBJECT_TYPE = process.env.YOUBOU_METAOBJECT_TYPE || 'youbou_history_event';
const DRY_RUN = process.env.DRY_RUN === '1';

if (!SHOP || !TOKEN) {
  console.error('Missing SHOPIFY_SHOP or SHOPIFY_ADMIN_ACCESS_TOKEN env vars.');
  process.exit(1);
}

const html = fs.readFileSync(path.join(__dirname, 'seed-source.html'), 'utf8');

function parseEntries(source) {
  const entries = [];
  // Split on each year marker, then parse fields per chunk.
  const yearRe = /<div class="date-year">\s*<p>\s*(\d{4})\s*<\/p>/g;
  const matches = [];
  let m;
  while ((m = yearRe.exec(source)) !== null) {
    matches.push({ year: m[1], start: m.index });
  }
  for (let i = 0; i < matches.length; i++) {
    const chunk = source.slice(matches[i].start, matches[i + 1]?.start ?? source.length);
    const imgMatch = chunk.match(/background-image:\s*url\(([^)]+)\)/);
    const imageUrl = imgMatch ? imgMatch[1].trim() : '';
    const textMatch = chunk.match(/<div class="date-text">([\s\S]*?)<\/div>/);
    let body = textMatch ? textMatch[1] : '';
    body = body.replace(/\s+/g, ' ').trim();
    entries.push({ year: matches[i].year, body, imageUrl });
  }
  return entries;
}

async function adminGraphql(query, variables) {
  const res = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(json)}`);
  if (json.errors?.length) throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
  return json.data;
}

async function fileCreateFromUrl(url) {
  const data = await adminGraphql(
    `mutation fileCreate($files: [FileCreateInput!]!) {
      fileCreate(files: $files) {
        files {
          ... on MediaImage { id }
          ... on GenericFile { id }
        }
        userErrors { field message }
      }
    }`,
    { files: [{ contentType: 'IMAGE', originalSource: url }] },
  );
  const errs = data?.fileCreate?.userErrors;
  if (errs?.length) throw new Error(errs.map((e) => e.message).join('; '));
  const file = data?.fileCreate?.files?.[0];
  if (!file?.id) throw new Error('fileCreate returned no id');
  return file.id;
}

async function createDraftMetaobject(fields) {
  const mutation = `mutation metaobjectCreate($metaobject: MetaobjectCreateInput!) {
    metaobjectCreate(metaobject: $metaobject) {
      metaobject { id handle }
      userErrors { field message code }
    }
  }`;
  const input = {
    metaobject: {
      type: METAOBJECT_TYPE,
      handle: `seed-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
      capabilities: { publishable: { status: 'DRAFT' } },
      fields,
    },
  };
  const data = await adminGraphql(mutation, input);
  const errs = data?.metaobjectCreate?.userErrors;
  if (errs?.length) throw new Error(errs.map((e) => `${e.field}: ${e.message}`).join('; '));
  return data.metaobjectCreate.metaobject;
}

const entries = parseEntries(html);
console.log(`Parsed ${entries.length} entries.`);

if (DRY_RUN) {
  for (const e of entries) {
    console.log(`${e.year}${e.imageUrl ? ' [img]' : ''}: ${e.body.slice(0, 80)}${e.body.length > 80 ? '…' : ''}`);
  }
  process.exit(0);
}

let created = 0;
let failed = 0;
for (const entry of entries) {
  try {
    const fields = [
      { key: 'event_date', value: `${entry.year}-01-01` },
      { key: 'year_display', value: entry.year },
      { key: 'body', value: entry.body },
    ];
    if (entry.imageUrl) {
      try {
        const fileId = await fileCreateFromUrl(entry.imageUrl);
        fields.push({ key: 'image', value: fileId });
      } catch (e) {
        console.warn(`  ${entry.year}: image upload failed (${e.message}); creating without image`);
      }
    }
    const meta = await createDraftMetaobject(fields);
    created++;
    console.log(`✔ ${entry.year} → ${meta.handle}`);
  } catch (e) {
    failed++;
    console.error(`✘ ${entry.year}: ${e.message}`);
  }
}
console.log(`Done. created=${created} failed=${failed}`);
