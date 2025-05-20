import algoliasearch from 'algoliasearch';

// Replace with your actual Algolia Application ID and Search API Key
const APP_ID = '8I4QUDIYPJ';
const API_KEY = '0b78c3d3ea56c86c7d766052bad49abe';
const INDEX_NAME = 'songs';

async function getAlgoliaData() {
  try {
    // Initialize the client
    const client = algoliasearch(APP_ID, API_KEY);
    const index = client.initIndex(INDEX_NAME);

    console.log(`Fetching data from Algolia index: "${INDEX_NAME}"...\n`);

    // 1. Fetch a few sample records
    console.log("--- Sample Records (first 5 hits) ---");
    const { hits } = await index.search('', { hitsPerPage: 5 });
    if (hits.length === 0) {
      console.log("No records found in the index.");
    } else {
      hits.forEach((hit, i) => {
        console.log(`Record ${i + 1}:`);
        console.log(JSON.stringify(hit, null, 2));
        console.log('---');
      });
    }
    console.log("\n");

    // 2. Fetch index settings
    console.log("--- Index Settings ---");
    const settings = await index.getSettings();
    console.log(JSON.stringify(settings, null, 2));
    console.log("\n");

    console.log("Successfully fetched data and settings from Algolia.");

  } catch (error) {
    console.error("Error fetching data from Algolia:", error);
    if (error.message && error.message.includes('Index_not_exists')) {
      console.error(`\nDouble-check if the index name "${INDEX_NAME}" is correct and exists in your Algolia application.`);
    } else if (error.message && error.message.includes('Invalid Application-ID or API-Key')) {
      console.error("\nDouble-check your Algolia Application ID and API Key.");
    }
  }
}

getAlgoliaData(); 