import 'dotenv/config';
import * as openSeaApi from '../src/opensea-api.js';

async function main() {
  const API_KEY = process.env.VITE_OPENSEA_API_KEY || process.env.OPENSEA_API_KEY;
  const CONTRACT = process.env.VITE_OPENSEA_CONTRACT_ADDRESS || process.env.OPENSEA_CONTRACT_ADDRESS;

  if (!API_KEY || !CONTRACT) {
    console.error('Missing OpenSea API key or contract address in env');
    console.error('Ensure VITE_OPENSEA_API_KEY and VITE_OPENSEA_CONTRACT_ADDRESS (or OPENSEA_API_KEY / OPENSEA_CONTRACT_ADDRESS) are set.');
    process.exit(1);
  }

  try {
    const slug = await openSeaApi.getCollectionSlug(CONTRACT, API_KEY);
    console.log('Collection slug:', slug);

    // Fetch up to 100 listings per page, up to 20 pages (maximum 2,000 NFTs) – adjust if needed.
    const listings = await openSeaApi.fetchBestListingsForCollection(slug, API_KEY, 'ethereum', 100, 20);
    console.log(`Fetched ${listings.length} best listings (one per NFT)`);

    // Print a brief summary of the first few entries
    listings.slice(0, 10).forEach((listing, idx) => {
      const tokenId = listing?.protocol_data?.parameters?.offer?.[0]?.identifierOrCriteria ?? 'unknown';
      const priceObj = listing?.price?.current;
      const priceStr = priceObj ? `${priceObj.value} ${priceObj.currency}` : 'N/A';
      console.log(`${idx + 1}. tokenId=${tokenId} | price=${priceStr}`);
    });

    // Optionally, output the full data structure as JSON
    // console.dir(listings, { depth: null });
  } catch (err) {
    console.error('Error:', err);
    process.exit(1);
  }
}

main(); 