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

    try {
        const response = await fetch(`${OPENSEA_API_BASE_URL}${endpoint}`, { headers, ...options });
        if (!response.ok) {
            // Try to parse error response from OpenSea, otherwise use status text
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
        console.error(`Error fetching from OpenSea endpoint ${endpoint}:`, error);
        throw error; // Re-throw the error to be caught by the caller
    }
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
    perRequestDelayMs = 0
) {
    // Returns an array containing ALL active listings (may perform multiple requests)
    const allListings = [];
    let cursor = null;
    let pagesFetched = 0;
    do {
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

        if (perRequestDelayMs && perRequestDelayMs > 0) {
            await new Promise(res => setTimeout(res, perRequestDelayMs));
        }
    } while (cursor && pagesFetched < maxPages);

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
            return allListings.filter(l => !suspectKeys.has(priceKeyFn(l)));
        }
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
    allowedSources = null,
    perRequestDelayMs = 0
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
        if (perRequestDelayMs) await new Promise(res => setTimeout(res, perRequestDelayMs));
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
    allowedSources = null,
    perRequestDelayMs = 0
) {
    try {
        const best = await fetchBestListingsForCollection(collectionSlug, apiKey, chain, 100, 20, allowedSources, perRequestDelayMs);
        if (best && best.length) return best;
    } catch (err) {
        // If unauthorized or endpoint not available, fall back silently.
        console.warn('fetchBestListingsForCollection failed, falling back to /all:', err.message || err);
    }

    // Fallback: get all listings and dedupe to cheapest per token
    const all = await fetchAllListingsForSale(collectionSlug, apiKey, chain, 100, 20, allowedSources, 0, perRequestDelayMs);
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