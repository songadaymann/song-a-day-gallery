import 'dotenv/config';
import * as openSeaApi from '../src/opensea-api.js';

async function main() {
  const API_KEY = process.env.VITE_OPENSEA_API_KEY || process.env.OPENSEA_API_KEY;
  const CONTRACT = process.env.VITE_OPENSEA_CONTRACT_ADDRESS || process.env.OPENSEA_CONTRACT_ADDRESS;
  const TOKEN_ID = process.argv[2] || process.env.TOKEN_ID;

  if (!API_KEY || !CONTRACT || !TOKEN_ID) {
    console.error('Usage: TOKEN_ID=<id> node scripts/checkTokenListing.js <tokenId> (env variables OPENSEA_API_KEY & OPENSEA_CONTRACT_ADDRESS must be set)');
    process.exit(1);
  }

  try {
    const slug = await openSeaApi.getCollectionSlug(CONTRACT, API_KEY);
    console.log('Collection slug:', slug);

    const listings = await openSeaApi.fetchListingsForToken(slug, TOKEN_ID, API_KEY);
    if (!listings.length) {
      console.log(`No active listings found for token ${TOKEN_ID}.`);
    } else {
      console.log(`Found ${listings.length} listings for token ${TOKEN_ID}:`);
      console.dir(listings, { depth: null });
    }
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

main(); 