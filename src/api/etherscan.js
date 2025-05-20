// src/etherscan-api.js

// Fetches collectors and their token IDs using Etherscan NFT transfer history.
// Returns { collectors: [ { address, tokens: [id,...], count } ], totalScanned: <number tokens processed> }
// Note: This walks the transfer history in ascending order so the final owner of each
// token is captured. Pagination is capped by maxPages to stay within API limits.

export async function fetchCollectors(
    contractAddress,
    apiKey,
    {
        pageSize = 1000,
        maxPages = Infinity,
        chain = 'ethereum',
        sort = 'desc' // 'desc' gives us current owners first and avoids the 10k-row cap issue
    } = {}
) {
    if (!contractAddress || !apiKey) {
        throw new Error('Contract address and API key are required');
    }

    const BASE = 'https://api.etherscan.io/api';

    let page = 1;
    const ZERO = '0x0000000000000000000000000000000000000000';

    // Map address -> Set(tokenIds)
    const owners = new Map();
    // Track tokens whose owner we have already determined (so we can stop early)
    const seenTokens = new Set();

    let processedTransfers = 0;

    // Heuristic: if we loop for N pages with no new tokens we break early
    let pagesSinceProgress = 0;
    const PROGRESS_THRESHOLD = 3;

    while (page <= maxPages) {
        const url = `${BASE}?module=account&action=tokennfttx&contractaddress=${contractAddress}&page=${page}&offset=${pageSize}&sort=${sort}&apikey=${apiKey}`;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Etherscan error ${response.status}`);
        const data = await response.json();
        if (data.status !== '1' || !Array.isArray(data.result)) break;
        const batch = data.result;
        if (batch.length === 0) break; // done

        let newTokensInPage = 0;

        for (const tx of batch) {
            const tokenId = parseInt(tx.tokenID, 10);
            if (!Number.isFinite(tokenId)) continue;

            if (sort === 'desc') {
                // First occurrence (most-recent transfer) determines current owner
                if (seenTokens.has(tokenId)) continue;
                seenTokens.add(tokenId);

                const toAddr = tx.to.toLowerCase();
                if (toAddr !== ZERO) {
                    let set = owners.get(toAddr);
                    if (!set) {
                        set = new Set();
                        owners.set(toAddr, set);
                    }
                    set.add(tokenId);
                }
                newTokensInPage++;
            } else {
                // Ascending fallback (original logic)
                const from = tx.from.toLowerCase();
                const toAddr = tx.to.toLowerCase();

                if (from !== ZERO) {
                    const set = owners.get(from);
                    if (set) {
                        set.delete(tokenId);
                        if (set.size === 0) owners.delete(from);
                    }
                }

                if (toAddr !== ZERO) {
                    let set = owners.get(toAddr);
                    if (!set) {
                        set = new Set();
                        owners.set(toAddr, set);
                    }
                    set.add(tokenId);
                }
            }

            processedTransfers += 1;
        }

        if (sort === 'desc') {
            if (newTokensInPage === 0) {
                pagesSinceProgress += 1;
            } else {
                pagesSinceProgress = 0;
            }
            if (pagesSinceProgress >= PROGRESS_THRESHOLD) break; // no new data for a few pages
        }

        if (batch.length < pageSize) break; // last page reached
        page += 1;
    }

    const collectors = [...owners.entries()]
        .map(([address, set]) => ({ address, tokens: [...set], count: set.size }))
        .sort((a, b) => b.count - a.count);

    return { collectors, totalScanned: processedTransfers };
} 