import 'dotenv/config';
import * as openSeaApi from '../src/api/opensea.js';

async function main() {
  const API_KEY = process.env.VITE_OPENSEA_API_KEY || process.env.OPENSEA_API_KEY;
  const CONTRACT = process.env.VITE_OPENSEA_CONTRACT_ADDRESS || process.env.OPENSEA_CONTRACT_ADDRESS;
  if (!API_KEY || !CONTRACT) {
    console.error('Missing OpenSea API key or contract address in env');
    process.exit(1);
  }

  const slug = await openSeaApi.getCollectionSlug(CONTRACT, API_KEY);
  console.log('Collection slug:', slug);

  // Parameter grids
  const allowedSourcesGrid = [
    null,
    ['opensea'],
    ['blur'],
    ['opensea', 'blur'],
  ];
  const priceClusterGrid = [null, 0, 5, 10, 20];
  const limitPerPageGrid = [50, 100];
  const maxPagesGrid = [5, 10, 20];

  let found = false;

  for (const allowed of allowedSourcesGrid) {
    for (const pct of priceClusterGrid) {
      for (const limit of limitPerPageGrid) {
        for (const pages of maxPagesGrid) {
          const listings = await openSeaApi.fetchAllListingsForSale(
            slug,
            API_KEY,
            'ethereum',
            limit,
            pages,
            allowed,
            pct ?? undefined,
            1200 // 1.2-s delay between paginated requests to avoid 429s
          );
          const tokenSet = new Set(
            listings
              .map(l => l?.protocol_data?.parameters?.offer?.[0]?.identifierOrCriteria)
              .filter(x => x !== undefined && x !== null)
          );
          const count = tokenSet.size;
          console.log(
            `allowed=${JSON.stringify(allowed)} pct=${pct} limit=${limit} pages=${pages} -> ${count}`
          );
          if (count === 63) {
            console.log('Success! Params that yield exactly 63 unique token IDs found above.');
            found = true;
            return;
          }

          // brief delay between different param combos to be extra safe
          await new Promise(res => setTimeout(res, 500));
        }
      }
    }
  }

  if (!found) {
    console.log('Did not find combination producing exactly 63 unique token IDs.');
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
}); 