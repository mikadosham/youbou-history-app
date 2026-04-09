/**
 * Bulk-publish all draft metaobjects of type youbou_history_event.
 *
 * Usage:
 *   SHOPIFY_SHOP=3e1248-2.myshopify.com node scripts/publish-all.mjs
 * (reads SHOPIFY_ADMIN_ACCESS_TOKEN from env / .env)
 */
const SHOP = process.env.SHOPIFY_SHOP || '';
const TOKEN = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || '';
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2026-04';
const METAOBJECT_TYPE = process.env.YOUBOU_METAOBJECT_TYPE || 'youbou_history_event';

if (!SHOP || !TOKEN) {
  console.error('Missing SHOPIFY_SHOP or SHOPIFY_ADMIN_ACCESS_TOKEN');
  process.exit(1);
}

async function gql(query, variables) {
  const res = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': TOKEN },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(json)}`);
  if (json.errors?.length) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

async function fetchAllDrafts() {
  const ids = [];
  let cursor = null;
  while (true) {
    const data = await gql(
      `query($type: String!, $cursor: String) {
        metaobjects(type: $type, first: 100, after: $cursor) {
          edges { cursor node { id capabilities { publishable { status } } } }
          pageInfo { hasNextPage }
        }
      }`,
      { type: METAOBJECT_TYPE, cursor },
    );
    for (const edge of data.metaobjects.edges) {
      if (edge.node.capabilities?.publishable?.status === 'DRAFT') ids.push(edge.node.id);
      cursor = edge.cursor;
    }
    if (!data.metaobjects.pageInfo.hasNextPage) break;
  }
  return ids;
}

const ids = await fetchAllDrafts();
console.log(`Found ${ids.length} drafts.`);

let ok = 0, fail = 0;
for (const id of ids) {
  try {
    const data = await gql(
      `mutation($id: ID!, $metaobject: MetaobjectUpdateInput!) {
        metaobjectUpdate(id: $id, metaobject: $metaobject) {
          metaobject { id }
          userErrors { field message }
        }
      }`,
      { id, metaobject: { capabilities: { publishable: { status: 'ACTIVE' } } } },
    );
    const errs = data.metaobjectUpdate.userErrors;
    if (errs?.length) throw new Error(errs.map((e) => e.message).join('; '));
    ok++;
    console.log(`✔ ${id}`);
  } catch (e) {
    fail++;
    console.error(`✘ ${id}: ${e.message}`);
  }
}
console.log(`Done. published=${ok} failed=${fail}`);
