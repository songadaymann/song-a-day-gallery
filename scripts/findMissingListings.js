import 'dotenv/config';
import * as openSeaApi from '../src/api/opensea.js';

async function fetchAllNFTIds(collectionSlug, apiKey, chain = 'ethereum', limitPerPage = 200, maxPages = 50, perRequestDelayMs = 500) {
  const tokenIds = new Set();
  let cursor = null;
  let pagesFetched = 0;
  do {
    const endpoint = cursor
      ? `/collection/${collectionSlug}/nfts?limit=${Math.min(limitPerPage, 200)}&cursor=${encodeURIComponent(cursor)}`
      : `/collection/${collectionSlug}/nfts?limit=${Math.min(limitPerPage, 200)}`;

    const url = `https://api.opensea.io/api/v2${endpoint}`;
    const response = await fetch(url, {
      headers: { 'X-API-KEY': apiKey, accept: 'application/json' }
    }).catch(err => {
      console.error('Fetch error:', err.message);
      return null;
    });
    if (!response || !response.ok) {
      console.error('Failed NFT fetch page', pagesFetched, response && response.status);
      break;
    }
    const data = await response.json().catch(err => {
      console.error('JSON parse error:', err.message);
      return null;
    });
    if (!data) break;
    (data.nfts || []).forEach(nft => tokenIds.add(nft.identifier));
    cursor = data.next || null;
    pagesFetched += 1;
    if (perRequestDelayMs) await new Promise(res => setTimeout(res, perRequestDelayMs));
  } while (cursor && pagesFetched < maxPages);

  return [...tokenIds];
}

async function main() {
  const API_KEY = process.env.VITE_OPENSEA_API_KEY || process.env.OPENSEA_API_KEY;
  const CONTRACT = process.env.VITE_OPENSEA_CONTRACT_ADDRESS || process.env.OPENSEA_CONTRACT_ADDRESS;
  if (!API_KEY || !CONTRACT) {
    console.error('Missing OpenSea API key or contract address in env');
    process.exit(1);
  }

  const slug = await openSeaApi.getCollectionSlug(CONTRACT, API_KEY);
  console.log('Collection slug:', slug);

  const allNFTIds = await fetchAllNFTIds(slug, API_KEY);
  console.log(`Total NFTs fetched: ${allNFTIds.length}`);

  const listings = await openSeaApi.fetchAllListingsForSale(slug, API_KEY, 'ethereum', 100, 20, null, 0, 600);
  const listedTokenIds = new Set(listings.map(l => l?.protocol_data?.parameters?.offer?.[0]?.identifierOrCriteria).filter(id => id !== undefined && id !== null).map(id => id.toString()));

  console.log(`Tokens with listings via collection endpoint: ${listedTokenIds.size}`);

  const missing = allNFTIds.filter(id => !listedTokenIds.has(id));
  console.log(`Missing tokens (no listing found): ${missing.length}`);
  console.log('Sample missing token IDs:', missing.slice(0, 10));

  if (missing.length) {
    const testId = missing[0];
    console.log(`\nFetching per-token listings for ${testId}...`);
    const perTokenListings = await openSeaApi.fetchListingsForToken(slug, testId, API_KEY);
    console.log(`Per-token endpoint returned ${perTokenListings.length} listings for ${testId}`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
}); 