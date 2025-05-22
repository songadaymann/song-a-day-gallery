// src/opensea-api.js

const OPENSEA_API_BASE_URL = 'https://api.opensea.io/api/v2';

// Helper function to make authenticated requests to OpenSea API
async function fetchOpenSeaData(endpoint, apiKey, chain = 'ethereum', options = {}) {
    const headers = {
        'X-API-KEY': apiKey,
        'accept': 'application/json'
    };
    // For POST requests, add content type
    if (options.method === 'POST' && options.body) {
        headers['content-type'] = 'application/json';
    }

    let retries = 0;
    const maxRetries = 5; // Max number of retries
    const initialDelay = 1000; // Initial delay in ms (1 second)
    const maxDelay = 16000; // Max delay in ms (16 seconds)

    while (retries <= maxRetries) {
        try {
            const response = await fetch(`${OPENSEA_API_BASE_URL}${endpoint}`, { headers, ...options });
            if (!response.ok) {
                if (response.status === 429) {
                    retries++;
                    if (retries > maxRetries) {
                        console.error(`OpenSea API Error (429): Max retries exceeded for endpoint ${endpoint}`);
                        throw new Error(`OpenSea API request failed: ${response.status} - Max retries exceeded`);
                    }
                    // Calculate delay: initialDelay * 2^(retries-1), capped by maxDelay
                    const delay = Math.min(initialDelay * Math.pow(2, retries - 1), maxDelay);
                    // Add some jitter to avoid thundering herd problem
                    const jitter = delay * 0.2 * Math.random();
                    const totalDelay = Math.floor(delay + jitter);

                    console.warn(`OpenSea API (429) - Retrying endpoint ${endpoint} in ${totalDelay}ms (attempt ${retries}/${maxRetries})`);
                    await new Promise(resolve => setTimeout(resolve, totalDelay));
                    continue; // Retry the request
                }

                // Try to parse other error responses from OpenSea
                let errorMessage = response.statusText;
                try {
                    const errorData = await response.json();
                    errorMessage = errorData.message || (typeof errorData === 'string' ? errorData : JSON.stringify(errorData));
                    if (errorData.errors) { // OpenSea sometimes returns errors in an array
                        errorMessage = errorData.errors.join(', ');
                    }
                } catch (e) {
                    // Ignore if error response is not JSON
                }
                console.error(`OpenSea API Error (${response.status}): ${errorMessage} for endpoint ${endpoint}`);
                throw new Error(`OpenSea API request failed: ${response.status} - ${errorMessage}`);
            }
            if (response.status === 204) { // No content
                return null;
            }
            return await response.json();
        } catch (error) {
            // Check if it's a network error or an error thrown from the retry logic
            if (retries > maxRetries || (error.message && !error.message.includes('OpenSea API request failed'))) {
                 // If max retries exceeded or it's not an error we want to retry from the `throw new Error` above
                console.error(`Error fetching from OpenSea endpoint ${endpoint}:`, error);
                throw error; // Re-throw the error to be caught by the caller
            }
            // If it's an error like a network issue that didn't get a response.status, we might want to retry here too.
            // For simplicity, current logic only retries 429s. To retry other errors, adjust the condition above.
            // For now, if it's not a 429 that we've handled, or max retries not hit, we rethrow.
            // This could happen if fetch itself fails (e.g. network error)
             if (retries === 0) { // if it's the first attempt and it's not a 429, throw immediately
                console.error(`Error fetching from OpenSea endpoint ${endpoint} (will not retry):`, error);
                throw error;
            }
            // If it's a subsequent attempt (meaning we are in a retry loop from a previous 429) and a new error occurs,
            // we might want to log it and continue the loop or break. For now, let's assume we only retry 429s.
            // This path should ideally not be hit if the error is not a 429.
            console.error(`Unhandled error during retry for OpenSea endpoint ${endpoint}:`, error);
            throw error;

        }
    }
    // This part should ideally not be reached if maxRetries leads to an error throw.
    // Adding a fallback throw in case the loop exits unexpectedly.
    throw new Error('Exited retry loop unexpectedly in fetchOpenSeaData');
}

// Fetches the collection slug for a given contract address
export async function getCollectionSlug(contractAddress, apiKey, chain = 'ethereum') {
    if (!contractAddress || !apiKey) {
        console.error("Contract address and API key are required to get collection slug.");
        throw new Error("Contract address and API key are required.");
    }
    try {
        const data = await fetchOpenSeaData(`/chain/${chain}/contract/${contractAddress}`, apiKey, chain);
        if (data && data.collection) {
            return data.collection;
        } else {
            throw new Error("Could not retrieve collection slug from contract data.");
        }
    } catch (error) {
        console.error(`Error fetching collection slug for ${contractAddress}:`, error);
        throw error;
    }
}

// Fetches listings for sale for a given collection slug
export async function fetchListingsForSale(collectionSlug, apiKey, chain = 'ethereum', limit = 100) {
    if (!collectionSlug || !apiKey) {
        console.error("Collection slug and API key are required to fetch listings.");
        throw new Error("Collection slug and API key are required.");
    }
    try {
        // OpenSea API allows up to 100 listings per request.
        const safeLimit = Math.min(limit, 100);
        // OpenSea's newer v2 Marketplace endpoint for fetching all active listings on a collection
        // Docs: https://docs.opensea.io/reference/get_all_listings_on_collection_v2
        // Supports cursor-based pagination; we keep it simple and just fetch the first page with the specified limit.
        const data = await fetchOpenSeaData(`/listings/collection/${collectionSlug}/all?limit=${safeLimit}`, apiKey, chain);
        return data.listings || []; // Expects { listings: [...] }
    } catch (error) {
        console.error(`Error fetching listings for sale for slug ${collectionSlug}:`, error);
        throw error;
    }
}

// Fetches activity (events) for a given collection slug
export async function fetchActivity(collectionSlug, apiKey, chain = 'ethereum', eventType = null, limit = 50) {
    if (!collectionSlug || !apiKey) {
        console.error("Collection slug and API key are required to fetch activity.");
        throw new Error("Collection slug and API key are required.");
    }
    try {
        // OpenSea API enforces a maximum limit of 50 per request.
        const safeLimit = Math.min(limit, 50);
        let endpoint = `/events/collection/${collectionSlug}?limit=${safeLimit}`;
        if (eventType) {
            endpoint += `&event_type=${eventType}`; // e.g., event_type=sale
        }
        const data = await fetchOpenSeaData(endpoint, apiKey, chain);
        return data.asset_events || []; // Expects { asset_events: [...] }
    } catch (error) {
        console.error(`Error fetching activity for slug ${collectionSlug}:`, error);
        throw error;
    }
}

// Fetches a sample of collectors by looking at owners of a batch of NFTs
export async function fetchCollectors(collectionSlug, apiKey, chain = 'ethereum', limit = 200) {
    if (!collectionSlug || !apiKey) {
        console.error("Collection slug and API key are required to fetch collectors.");
        throw new Error("Collection slug and API key are required.");
    }
    console.warn('Fetching collectors for ' + collectionSlug + '. This provides a sample based on the first ' + limit + ' NFTs and may not be exhaustive for large collections.');
    try {
        // Fetching NFTs. Note: OpenSea's /collection/{slug}/nfts endpoint max limit is 200.
        // To get all NFTs for a large collection, pagination would be needed.
        const data = await fetchOpenSeaData(`/collection/${collectionSlug}/nfts?limit=${Math.min(limit, 200)}`, apiKey, chain);
        const nfts = data.nfts || [];

        if (nfts.length === 0) return { collectors: [], totalScanned: 0 };

        const ownerCounts = {};
        nfts.forEach(nft => {
            // NFT structure from /collection/{collection_slug}/nfts has 'owners' array
            // { identifier: "...", owners: [ { address: "0x...", quantity: 1 } ] ... }
            if (nft.owners && nft.owners.length > 0) {
                // Assuming the first owner in the array is the relevant one for ERC721
                const ownerAddress = nft.owners[0].address;
                if (ownerAddress) {
                    ownerCounts[ownerAddress] = (ownerCounts[ownerAddress] || 0) + 1;
                }
            }
        });

        const sortedCollectors = Object.entries(ownerCounts)
            .map(([address, count]) => ({ address, count }))
            .sort((a, b) => b.count - a.count);

        return { collectors: sortedCollectors, totalScanned: nfts.length };
    } catch (error) {
        console.error(`Error fetching collectors for slug ${collectionSlug}:`, error);
        throw error; // Re-throw to allow caller to handle
    }
}

// Fetches all listings for sale for a given collection slug
export async function fetchAllListingsForSale(
    collectionSlug,
    apiKey,
    chain = 'ethereum',
    limitPerPage = 100,
    maxPages = 20,
    allowedSources = null,
    priceClusterThreshold = 10, // if >10 identical-price listings, assume NFTx cluster and drop all of them
    progressCallback = null // Optional callback: (progress, status) => void, progress is 0-1
) {
    // Returns an array containing ALL active listings (may perform multiple requests)
    const allListings = [];
    let cursor = null;
    let pagesFetched = 0;
    do {
        if (progressCallback) {
            const progress = pagesFetched / maxPages;
            const status = `Fetching page ${pagesFetched + 1}${maxPages ? ` of ${maxPages}` : ''}...`;
            progressCallback(progress, status);
        }

        const endpoint = cursor
            ? `/listings/collection/${collectionSlug}/all?limit=${Math.min(limitPerPage, 100)}&cursor=${encodeURIComponent(cursor)}`
            : `/listings/collection/${collectionSlug}/all?limit=${Math.min(limitPerPage, 100)}`;
        const data = await fetchOpenSeaData(endpoint, apiKey, chain);
        if (data?.listings?.length) {
            let pageListings = data.listings;
            if (Array.isArray(allowedSources) && allowedSources.length) {
                pageListings = pageListings.filter(l => {
                    const src = l.order_source || l.order_source_name || l.order_provider || '';
                    if (!src) return true; // keep when source not specified
                    // Allow substring match so "opensea.io" or "blur.io" are accepted when list contains "opensea" or "blur"
                    return allowedSources.some(allowed => src.toLowerCase().includes(allowed));
                });
            }
            allListings.push(...pageListings);
        }
        cursor = data?.next || null;
        pagesFetched += 1;
    } while (cursor && pagesFetched < maxPages);

    if (progressCallback) {
        progressCallback(0.9, 'Processing price clusters...');
    }

    // Detect large clusters of identical price listings (common with NFTx floor vault listings)
    if (priceClusterThreshold && priceClusterThreshold > 0) {
        const priceMap = new Map(); // key -> count
        const priceKeyFn = (l) => {
            const p = l.price?.current;
            if (!p) return null;
            return `${p.value}-${p.currency ?? ''}-${p.decimals ?? ''}`;
        };

        for (const l of allListings) {
            const key = priceKeyFn(l);
            if (!key) continue;
            priceMap.set(key, (priceMap.get(key) || 0) + 1);
        }

        const suspectKeys = new Set(
            [...priceMap.entries()]
                .filter(([, cnt]) => cnt >= priceClusterThreshold)
                .map(([k]) => k)
        );

        if (suspectKeys.size) {
            if (progressCallback) {
                progressCallback(0.95, `Filtering out ${suspectKeys.size} price clusters...`);
            }
            return allListings.filter(l => !suspectKeys.has(priceKeyFn(l)));
        }
    }

    if (progressCallback) {
        progressCallback(1.0, `Found ${allListings.length} listings`);
    }

    return allListings;
}

// Lightweight helper – returns only the count of listings that come from allowedSources
export async function countListingsForSale(
    collectionSlug,
    apiKey,
    chain = 'ethereum',
    limitPerPage = 100,
    maxPages = 20,
    allowedSources = null,
    _ignoredParam = null // kept for backwards-compatibility
) {
    // Returns the *number of unique token IDs* that have at least one active listing
    // after optional allowedSources filtering. No price-cluster logic.
    if (!collectionSlug || !apiKey) {
        throw new Error('Collection slug and API key are required.');
    }

    const tokenIds = new Set();
    let cursor = null;
    let pagesFetched = 0;

    do {
        const endpoint = cursor
            ? `/listings/collection/${collectionSlug}/all?limit=${Math.min(limitPerPage, 100)}&cursor=${encodeURIComponent(cursor)}`
            : `/listings/collection/${collectionSlug}/all?limit=${Math.min(limitPerPage, 100)}`;

        const data = await fetchOpenSeaData(endpoint, apiKey, chain);
        if (data?.listings?.length) {
            let listings = data.listings;
            if (Array.isArray(allowedSources) && allowedSources.length) {
                listings = listings.filter(l => {
                    const src = l.order_source || l.order_source_name || l.order_provider || '';
                    if (!src) return true;
                    return allowedSources.some(allowed => src.toLowerCase().includes(allowed));
                });
            }
            for (const l of listings) {
                const tokenId = l?.protocol_data?.parameters?.offer?.[0]?.identifierOrCriteria ?? null;
                if (tokenId !== null && tokenId !== undefined) {
                    tokenIds.add(tokenId.toString());
                }
            }
        }
        cursor = data?.next || null;
        pagesFetched += 1;
    } while (cursor && pagesFetched < maxPages);

    return tokenIds.size;
}

// Fetches active listings for a specific NFT (tokenId) inside a collection
export async function fetchListingsForToken(
    collectionSlug,
    tokenId,
    apiKey,
    chain = 'ethereum',
    limit = 20
) {
    if (!collectionSlug || !tokenId || !apiKey) {
        throw new Error('Collection slug, token ID and API key are required.');
    }

    const safeLimit = Math.min(limit, 100);
    // OpenSea provides only a "best" listing (cheapest) endpoint per NFT
    const endpoint = `/listings/collection/${collectionSlug}/nfts/${tokenId}/best`;
    const data = await fetchOpenSeaData(endpoint, apiKey, chain);
    // The per-NFT endpoint returns either {listing: {...}} or 204 when no listing
    if (!data) return [];
    if (data.listing) return [data.listing];
    if (data.listings) return data.listings; // just in case
    return [];
}

// Fetches the cheapest active listing for each NFT in the collection (one row per token)
export async function fetchBestListingsForCollection(
    collectionSlug,
    apiKey,
    chain = 'ethereum',
    limitPerPage = 100,
    maxPages = 20,
    allowedSources = null
) {
    const listings = [];
    let cursor = null;
    let pagesFetched = 0;
    do {
        const endpoint = cursor
            ? `/listings/collection/${collectionSlug}/best?limit=${Math.min(limitPerPage, 100)}&cursor=${encodeURIComponent(cursor)}`
            : `/listings/collection/${collectionSlug}/best?limit=${Math.min(limitPerPage, 100)}`;
        const data = await fetchOpenSeaData(endpoint, apiKey, chain);
        if (data?.listings?.length) {
            let pageListings = data.listings;
            if (Array.isArray(allowedSources) && allowedSources.length) {
                pageListings = pageListings.filter(l => {
                    const src = l.order_source || l.order_source_name || l.order_provider || '';
                    if (!src) return true;
                    return allowedSources.some(allowed => src.toLowerCase().includes(allowed));
                });
            }
            listings.push(...pageListings);
        }
        cursor = data?.next || null;
        pagesFetched += 1;
    } while (cursor && pagesFetched < maxPages);

    // --- Dedupe to the cheapest listing per tokenId (protects against duplicates across pages) ---
    const map = new Map();
    for (const l of listings) {
        const tokenId = l?.protocol_data?.parameters?.offer?.[0]?.identifierOrCriteria;
        if (tokenId === undefined || tokenId === null) continue;
        const key = tokenId.toString();
        const existing = map.get(key);
        const newPrice = l?.price?.current?.value ? BigInt(l.price.current.value) : BigInt(0);
        if (!existing) {
            map.set(key, l);
        } else {
            const oldPrice = existing?.price?.current?.value ? BigInt(existing.price.current.value) : BigInt(0);
            if (newPrice < oldPrice) map.set(key, l);
        }
    }

    return [...map.values()];
}

// Smart helper: try /best endpoint first, fall back to /all with dedupe
export async function fetchCheapestListingsSmart(
    collectionSlug,
    apiKey,
    chain = 'ethereum',
    allowedSources = null
) {
    try {
        const best = await fetchBestListingsForCollection(collectionSlug, apiKey, chain, 100, 20, allowedSources);
        if (best && best.length) return best;
    } catch (err) {
        // If unauthorized or endpoint not available, fall back silently.
        console.warn('fetchBestListingsForCollection failed, falling back to /all:', err.message || err);
    }

    // Fallback: get all listings and dedupe to cheapest per token
    const all = await fetchAllListingsForSale(collectionSlug, apiKey, chain, 100, 20, allowedSources, 0);
    const map = new Map();
    for (const l of all) {
        const tokenId = l?.protocol_data?.parameters?.offer?.[0]?.identifierOrCriteria;
        if (tokenId === undefined || tokenId === null) continue;
        const key = tokenId.toString();
        const existing = map.get(key);
        if (!existing) {
            map.set(key, l);
        } else {
            const newPrice = l.price?.current?.value ? BigInt(l.price.current.value) : BigInt(0);
            const oldPrice = existing.price?.current?.value ? BigInt(existing.price.current.value) : BigInt(0);
            if (newPrice < oldPrice) map.set(key, l);
        }
    }
    return [...map.values()];
}

// --- Example of how these might be used with a contract address ---
/*
async function getSalesData(contractAddress, apiKey, chain = 'ethereum') {
    try {
        const slug = await getCollectionSlug(contractAddress, apiKey, chain);
        if (slug) {
            const listings = await fetchListingsForSale(slug, apiKey, chain);
            console.log('Listings:', listings);

            const activity = await fetchActivity(slug, apiKey, chain, 'sale');
            console.log('Sales Activity:', activity);

            const collectorsInfo = await fetchCollectors(slug, apiKey, chain);
            console.log('Collectors Sample:', collectorsInfo.collectors, 'Total NFTs Scanned:', collectorsInfo.totalScanned);
            return { listings, activity, collectorsInfo };
        }
    } catch (error) {
        console.error("Failed to get OpenSea data:", error);
    }
}
*/ 