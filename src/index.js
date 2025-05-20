import { createButton } from './ui/createButton.js';
import { initSearchBar } from './ui/search.js';
import { initAlgoliaIndex } from './api/algolia.js';
import * as openSeaApi from './api/opensea.js';
import * as etherscanApi from './api/etherscan.js';

(function () {
    // Algolia Client Initialization
    const ALGOLIA_APP_ID = '8I4QUDIYPJ';
    const ALGOLIA_SEARCH_KEY = '0b78c3d3ea56c86c7d766052bad49abe'; // Search-only key
    const ALGOLIA_INDEX_NAME = 'songs';
    const algoliaIndex = initAlgoliaIndex(
        ALGOLIA_APP_ID,
        ALGOLIA_SEARCH_KEY,
        ALGOLIA_INDEX_NAME
    );

    // OpenSea / Etherscan Configuration
    const OPENSEA_API_KEY = import.meta.env.VITE_OPENSEA_API_KEY;
    const OPENSEA_CONTRACT_ADDRESS = import.meta.env.VITE_OPENSEA_CONTRACT_ADDRESS;
    const ETHERSCAN_API_KEY = import.meta.env.VITE_ETHERESCAN_API_KEY || import.meta.env.VITE_ETHERESCAN_API_KEY;
    const ALLOWED_MARKETPLACES = ['opensea', 'blur'];
    let collectionSlug = null; // To store the fetched OpenSea collection slug
    let etherscanCollectorsCache = null; // cache collectors data
    console.log('OpenSea ENV Vars:', { key: OPENSEA_API_KEY ? 'Loaded' : 'MISSING', contract: OPENSEA_CONTRACT_ADDRESS ? 'Loaded' : 'MISSING' });

    // In-memory cache for cheapest listings so we only fetch once per session
    let bestListingsCache = null;
    let bestListingsFetchPromise = null;

    async function getBestListings() {
        if (bestListingsCache) return bestListingsCache;
        if (bestListingsFetchPromise) return bestListingsFetchPromise;

        // Kick off the fetch; store the promise so concurrent callers share it
        bestListingsFetchPromise = (async () => {
            // Safety: if collectionSlug hasn't been resolved yet, fetch it first
            if (!collectionSlug) {
                if (OPENSEA_CONTRACT_ADDRESS && OPENSEA_API_KEY) {
                    collectionSlug = await openSeaApi.getCollectionSlug(OPENSEA_CONTRACT_ADDRESS, OPENSEA_API_KEY);
                } else {
                    throw new Error('OpenSea configuration missing');
                }
            }

            // Fetch every active order (up to ~6 500) then keep the cheapest one per token
            const raw = await openSeaApi.fetchAllListingsForSale(
                collectionSlug,
                OPENSEA_API_KEY,
                'ethereum',
                100,   // page size
                65,    // max pages ( ≈ 6 500 rows )
                ALLOWED_MARKETPLACES,
                0,     // price cluster threshold off (we'll dedupe per-token next)
                800    // 0.8-s delay between pages to stay under 429
            );

            // De-duplicate → keep cheapest order for each tokenId
            const map = new Map(); // tokenId -> cheapest listing
            for (const l of raw) {
                const t = l?.protocol_data?.parameters?.offer?.[0]?.identifierOrCriteria;
                if (t === undefined || t === null) continue;
                const key = t.toString();
                const price = l?.price?.current?.value ? BigInt(l.price.current.value) : BigInt(0);
                const existing = map.get(key);
                if (!existing) {
                    map.set(key, l);
                } else {
                    const oldPrice = existing.price?.current?.value ? BigInt(existing.price.current.value) : BigInt(0);
                    if (price < oldPrice) map.set(key, l);
                }
            }

            const deduped = [...map.values()];
            bestListingsCache = deduped;
            return deduped;
        })().catch(err => {
            // Reset so we can retry later
            bestListingsFetchPromise = null;
            throw err;
        });

        return bestListingsFetchPromise;
    }

    // BEGIN copied logic --------------------------------------------------
    const viewer = OpenSeadragon({
        id: "viewer",
        prefixUrl: "https://cdnjs.cloudflare.com/ajax/libs/openseadragon/4.1.0/images/",
        showNavigator: false,
        // Hide OpenSeadragon's default UI buttons (we render our own)
        showNavigationControl: false,
        showHomeControl: false,
        showZoomControl: false,
        showFullPageControl: false,
        constrainDuringPan: true,
        // Prevent background from ever showing while panning
        visibilityRatio: 1,
        minZoomImageRatio: 0.8,
        defaultZoomLevel: 0.8,
        springStiffness: 5,
        animationTime: 0.7,
        homeFitBounds: true,
        tileSources: {
            height: 20520,
            width: 36960,
            tileSize: 256,
            minLevel: 0,
            maxLevel: 7,
            getTileUrl: function (level, x, y) {
                return `https://songadaygallery.blob.core.windows.net/dzi/level_${level}/tiles/${x}_${y}.jpg`;
            }
        }
    });

    const GRID_COLS = 77;
    const GRID_ROWS = 76;
    const CELL_WIDTH = 36960 / GRID_COLS;
    const CELL_HEIGHT = 20520 / GRID_ROWS;

    // Create container for all GIFs
    const gifContainer = document.createElement('div');
    gifContainer.id = 'gif-container';
    viewer.canvas.appendChild(gifContainer);

    // Create highlight box
    const highlightBox = document.createElement('div');
    highlightBox.className = 'highlight-box';
    // Attach to the outer viewer element (not the inner canvas) so it isn't
    // affected by the canvas CSS transform during zoom, eliminating scale lag.
    viewer.element.appendChild(highlightBox);

    // Track the currently highlighted song
    let currentSongId = null;
    let currentGifOverlays = new Map();
    let gifEnabled = true; // user-toggleable GIF visibility

    // Overlays for recently sold tokens (sales view)
    const soldHighlightOverlays = new Map();
    const salesShadeOverlays = new Map();
    let activeSoldSet = null; // null when Sales view inactive, otherwise Set of tokenIds

    function clearSoldHighlights() {
        soldHighlightOverlays.forEach(o => o.remove());
        soldHighlightOverlays.clear();
    }

    function createSoldOverlay(songId) {
        const col = (songId - 1) % GRID_COLS;
        const row = Math.floor((songId - 1) / GRID_COLS);
        const rect = new OpenSeadragon.Rect(col * CELL_WIDTH, row * CELL_HEIGHT, CELL_WIDTH, CELL_HEIGHT);

        const overlay = document.createElement('div');
        overlay.style.position = 'absolute';
        overlay.style.pointerEvents = 'none';
        overlay.style.zIndex = '1001';
        overlay.style.border = '2px solid #1f7a3d'; // green border for sales

        const viewportRect = viewer.viewport.imageToViewportRectangle(rect);
        const elementRect = viewer.viewport.viewportToViewerElementRectangle(viewportRect);
        overlay.style.left = elementRect.x + 'px';
        overlay.style.top = elementRect.y + 'px';
        overlay.style.width = elementRect.width + 'px';
        overlay.style.height = elementRect.height + 'px';

        viewer.element.appendChild(overlay);

        // Keep it in sync during animations
        viewer.addHandler('animation', () => {
            if (!overlay.parentNode) return;
            const vRect = viewer.viewport.imageToViewportRectangle(rect);
            const eRect = viewer.viewport.viewportToViewerElementRectangle(vRect);
            overlay.style.left = eRect.x + 'px';
            overlay.style.top = eRect.y + 'px';
            overlay.style.width = eRect.width + 'px';
            overlay.style.height = eRect.height + 'px';
        });

        return overlay;
    }

    function highlightSoldSongs(tokenIds) {
        clearSoldHighlights();
        // Deduplicate
        const unique = Array.from(new Set(tokenIds.map(id => parseInt(id, 10)).filter(n => Number.isFinite(n) && n >= 1 && n <= 5852)));
        unique.forEach(id => {
            const overlay = createSoldOverlay(id);
            soldHighlightOverlays.set(id, overlay);
        });
    }

    function getSongFromPoint(position) {
        if (!position) return null;

        const viewportPoint = viewer.viewport.pointFromPixel(position);
        const imagePoint = viewer.viewport.viewportToImageCoordinates(viewportPoint);

        const x = Math.floor(imagePoint.x / CELL_WIDTH);
        const y = Math.floor(imagePoint.y / CELL_HEIGHT);

        if (x >= 0 && x < GRID_COLS && y >= 0 && y < GRID_ROWS) {
            const songId = y * GRID_COLS + x + 1;
            if (songId <= 5852) {
                return {
                    id: songId,
                    rect: new OpenSeadragon.Rect(
                        x * CELL_WIDTH,
                        y * CELL_HEIGHT,
                        CELL_WIDTH,
                        CELL_HEIGHT
                    )
                };
            }
        }
        return null;
    }

    function getVisibleSongs() {
        const viewportBounds = viewer.viewport.getBounds();
        const imageRect = viewer.viewport.viewportToImageRectangle(viewportBounds);

        const startX = Math.max(0, Math.floor(imageRect.x / CELL_WIDTH));
        const startY = Math.max(0, Math.floor(imageRect.y / CELL_HEIGHT));
        const endX = Math.min(GRID_COLS - 1, Math.ceil((imageRect.x + imageRect.width) / CELL_WIDTH));
        const endY = Math.min(GRID_ROWS - 1, Math.ceil((imageRect.y + imageRect.height) / CELL_HEIGHT));

        const songs = [];
        for (let y = startY; y <= endY; y++) {
            for (let x = startX; x <= endX; x++) {
                const songId = y * GRID_COLS + x + 1;
                if (songId <= 5852) {
                    songs.push({
                        id: songId,
                        rect: new OpenSeadragon.Rect(
                            x * CELL_WIDTH,
                            y * CELL_HEIGHT,
                            CELL_WIDTH,
                            CELL_HEIGHT
                        )
                    });
                }
            }
        }
        return songs;
    }

    function updateGifs() {
        if (!gifEnabled) {
            currentGifOverlays.forEach(overlay => overlay.remove());
            currentGifOverlays.clear();
            return;
        }

        const zoom = viewer.viewport.getZoom();
        const maxZoom = viewer.viewport.getMaxZoom();
        // Show GIFs once the user is sufficiently zoomed-in. We expose the
        // ratio as a constant so it can be tuned easily without hunting for
        // magic numbers.
        const GIF_SHOW_RATIO = 0.2; // 0 = always on, 1 = only at full max zoom
        const showGifs = zoom > maxZoom * GIF_SHOW_RATIO;

        if (showGifs) {
            const visibleSongs = getVisibleSongs();
            const currentIds = new Set();

            visibleSongs.forEach(song => {
                currentIds.add(song.id);
                if (!currentGifOverlays.has(song.id)) {
                    const overlay = document.createElement('div');
                    overlay.className = 'gif-overlay';
                    const img = document.createElement('img');
                    img.src = `https://songadaygallery.blob.core.windows.net/dzi/${song.id}.gif`;
                    overlay.appendChild(img);
                    gifContainer.appendChild(overlay);
                    currentGifOverlays.set(song.id, overlay);
                }

                const overlay = currentGifOverlays.get(song.id);
                const viewportRect = viewer.viewport.imageToViewportRectangle(song.rect);
                const elementRect = viewer.viewport.viewportToViewerElementRectangle(viewportRect);

                overlay.style.left = elementRect.x + 'px';
                overlay.style.top = elementRect.y + 'px';
                overlay.style.width = elementRect.width + 'px';
                overlay.style.height = elementRect.height + 'px';
                overlay.style.display = 'block';
            });

            // Remove GIFs that are no longer visible
            for (const [id, overlay] of currentGifOverlays) {
                if (!currentIds.has(id)) {
                    overlay.remove();
                    currentGifOverlays.delete(id);
                }
            }
        } else {
            // Hide all GIFs when zoomed out
            currentGifOverlays.forEach(overlay => overlay.remove());
            currentGifOverlays.clear();
        }
    }

    function updateHighlight(position) {
        const song = getSongFromPoint(position);
        if (song) {
            currentSongId = song.id;
            const viewportRect = viewer.viewport.imageToViewportRectangle(song.rect);
            const elementRect = viewer.viewport.viewportToViewerElementRectangle(viewportRect);

            highlightBox.style.left = elementRect.x + 'px';
            highlightBox.style.top = elementRect.y + 'px';
            highlightBox.style.width = elementRect.width + 'px';
            highlightBox.style.height = elementRect.height + 'px';
            highlightBox.style.display = 'block';
        } else {
            currentSongId = null;
            highlightBox.style.display = 'none';
        }
    }

    // Update positions during animations
    viewer.addHandler('animation', function () {
        updateGifs();
        if (currentSongId && viewer.lastMousePosition) {
            updateHighlight(viewer.lastMousePosition);
        }
        updateSalesShadeOverlays();
    });

    // Ensure GIFs AND highlight box refresh on every pan/zoom frame (even when no smooth animation event fires)
    viewer.addHandler('update-viewport', () => {
        updateGifs();
        if (currentSongId && viewer.lastMousePosition) {
            updateHighlight(viewer.lastMousePosition);
        }
        updateSalesShadeOverlays();
    });

    // Mouse tracking
    new OpenSeadragon.MouseTracker({
        element: viewer.canvas,
        moveHandler: event => {
            if (!event.buttons) updateHighlight(event.position);
        },
        overHandler: event => {
            if (!event.buttons) updateHighlight(event.position);
        },
        outHandler: () => {
            currentSongId = null;
            highlightBox.style.display = 'none';
        },
        stopHandler: () => {
            if (currentSongId && viewer.lastMousePosition) {
                updateHighlight(viewer.lastMousePosition);
            }
        }
    });

    // Data loading
    fetch('data/coordinate_maps.json')
        .then(r => r.json())
        .then(coords => {
            window.songCoordinates = coords;
        })
        .catch(err => console.error('Error loading coordinates:', err));

    // Modal elements
    const modal = document.getElementById('songModal');
    const closeButton = modal.querySelector('.close-button');

    // Left Sidebar (for OpenSea data)
    const leftSidebar = document.getElementById('left-sidebar');
    const leftSidebarTitle = leftSidebar.querySelector('.left-sidebar-title');
    const leftSidebarContent = leftSidebar.querySelector('.left-sidebar-content');
    const closeLeftSidebarBtn = document.getElementById('close-left-sidebar-btn');

    // Top navigation buttons for OpenSea sections
    const activityBtn = document.getElementById('activity-btn');
    const collectorsBtn = document.getElementById('collectors-btn');
    const forSaleBtn = document.getElementById('for-sale-btn');
    const homeViewBtn = document.getElementById('home-view-btn');
    const searchInput = document.getElementById('search-input');
    const forSaleCountSpan = document.getElementById('for-sale-count');

    closeButton.addEventListener('click', () => (modal.style.display = 'none'));
    modal.addEventListener('click', e => {
        if (e.target === modal) modal.style.display = 'none';
    });

    if (homeViewBtn) {
        homeViewBtn.addEventListener('click', () => viewer.viewport.goHome());
    }

    if (searchInput) {
        initSearchBar(
            searchInput,
            algoliaIndex,
            id => displaySongDetails(id),
            q => openSearchResults(q)
        );
    }

    function getYouTubeVideoId(url) {
        if (!url) return null;
        if (url.includes('youtu.be')) return url.split('youtu.be/')[1];
        const params = new URL(url).searchParams;
        return params.get('v');
    }

    async function displaySongDetails(songId) {
        try {
            const song = await algoliaIndex.getObject(songId.toString());
            if (!song) {
                console.error("Song not found in Algolia:", songId);
                return;
            }

            const modalContent = modal.querySelector('.modal-content');
            modalContent.querySelector('.song-title').textContent = song.name;
            modalContent.querySelector('.song-number').textContent = `Song #${song.token_id}`;

            // Remove any existing OpenSea link to avoid duplicates when opening multiple songs
            modalContent.querySelectorAll('.os-link').forEach(el => el.remove());
            const osAnchor = document.createElement('a');
            osAnchor.href = `https://opensea.io/assets/ethereum/${OPENSEA_CONTRACT_ADDRESS}/${song.token_id}`;
            osAnchor.textContent = 'View on OpenSea';
            osAnchor.target = '_blank';
            osAnchor.style.display = 'inline-block';
            osAnchor.style.margin = '8px 0';
            osAnchor.style.fontWeight = '600';
            osAnchor.className = 'external-link os-link';

            const songNumberEl = modalContent.querySelector('.song-number');
            songNumberEl?.after(osAnchor);

            // video
            const videoContainer = modalContent.querySelector('.video-container');
            videoContainer.innerHTML = '';
            if (song.youtube_url) {
                const vid = getYouTubeVideoId(song.youtube_url);
                if (vid) {
                    const iframe = document.createElement('iframe');
                    iframe.src = `https://www.youtube.com/embed/${vid}`;
                    iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture';
                    iframe.allowFullscreen = true;
                    videoContainer.appendChild(iframe);
                }
            }

            // attributes
            const attributesGrid = modalContent.querySelector('.attributes-grid');
            attributesGrid.innerHTML = '';
            if (song.attributes && Array.isArray(song.attributes)) {
                song.attributes.forEach(attr => {
                    if (attr.trait_type !== 'Song A Day') {
                        const item = document.createElement('div');
                        item.className = 'attribute-item';
                        item.innerHTML = `<div class="attribute-label">${attr.trait_type}</div><div class="attribute-value">${attr.value}</div>`;
                        attributesGrid.appendChild(item);
                    }
                });
            }

            // external links
            const linksContainer = modalContent.querySelector('.external-links');
            linksContainer.innerHTML = '';

            if (song.external_url) {
                const songLink = document.createElement('a');
                songLink.href = song.external_url;
                songLink.className = 'external-link';
                songLink.textContent = 'View on Song A Day';
                songLink.target = '_blank';
                linksContainer.appendChild(songLink);
            }

            modal.style.display = 'block';
        } catch (error) {
            console.error("Error fetching song details from Algolia:", error);
            // Optionally, display an error message to the user in the modal
        }
    }

    async function openSearchResults(query) {
        if (!query) return;
        try {
            const { hits } = await algoliaIndex.search(query, { hitsPerPage: 50 });
            const modalEl = document.getElementById('searchModal');
            const closeBtn = modalEl.querySelector('.close-button');
            const titleEl = modalEl.querySelector('.search-results-title');
            const listEl = modalEl.querySelector('.search-results-list');
            listEl.innerHTML = '';
            titleEl.textContent = `Results for "${query}"`;
            hits.forEach(hit => {
                const li = document.createElement('li');
                const label = hit.name || `Song #${hit.token_id}`;
                li.textContent = label;
                li.addEventListener('click', () => {
                    modalEl.style.display = 'none';
                    displaySongDetails(parseInt(hit.objectID, 10));
                });
                listEl.appendChild(li);
            });
            modalEl.style.display = 'block';
            closeBtn.onclick = () => (modalEl.style.display = 'none');
            modalEl.addEventListener('click', e => {
                if (e.target === modalEl) modalEl.style.display = 'none';
            });
        } catch (err) {
            console.error('Error performing search', err);
        }
    }

    // click handler
    viewer.addHandler('canvas-click', function (event) {
        if (!event.quick) return;
        const song = getSongFromPoint(event.position);
        if (song) displaySongDetails(song.id);
    });

    // Filtering logic (unchanged)
    let filterOverlays = new Map();
    let selectedFilters = new Map(); // trait_type -> Set
    let filterHighlightOverlays = new Map();

    function createOverlayForSong(songId) {
        const col = (songId - 1) % GRID_COLS;
        const row = Math.floor((songId - 1) / GRID_COLS);
        const rect = new OpenSeadragon.Rect(col * CELL_WIDTH, row * CELL_HEIGHT, CELL_WIDTH, CELL_HEIGHT);

        const overlay = document.createElement('div');
        overlay.style.position = 'absolute';
        overlay.style.background = 'rgba(0,0,0,0.5)';
        overlay.style.pointerEvents = 'none';
        overlay.style.zIndex = '1001';

        const viewportRect = viewer.viewport.imageToViewportRectangle(rect);
        const elementRect = viewer.viewport.viewportToViewerElementRectangle(viewportRect);
        overlay.style.left = elementRect.x + 'px';
        overlay.style.top = elementRect.y + 'px';
        overlay.style.width = elementRect.width + 'px';
        overlay.style.height = elementRect.height + 'px';

        viewer.canvas.appendChild(overlay);

        viewer.addHandler('animation', () => {
            if (!overlay.parentNode) return;
            const vRect = viewer.viewport.imageToViewportRectangle(rect);
            const eRect = viewer.viewport.viewportToViewerElementRectangle(vRect);
            overlay.style.left = eRect.x + 'px';
            overlay.style.top = eRect.y + 'px';
            overlay.style.width = eRect.width + 'px';
            overlay.style.height = eRect.height + 'px';
        });

        return overlay;
    }

    // Function to build facetFilters array for Algolia
    function buildFacetFilters() {
        const facetFilters = [];
        selectedFilters.forEach((values, trait) => {
            const orFilters = [];
            values.forEach(value => {
                orFilters.push(`${trait}:${value}`);
            });
            if (orFilters.length > 0) {
                facetFilters.push(orFilters);
            }
        });
        return facetFilters;
    }

    async function updateFilterOverlays() { // Made async
        filterOverlays.forEach(o => o.remove());
        filterOverlays.clear();

        const currentFacetFilters = buildFacetFilters();
        if (currentFacetFilters.length === 0) {
            clearFilterHighlights();
            // No filters → nothing to dim/highlight.
            return;
        }

        try {
            // Get all song IDs that match the current filters from Algolia
            const { hits } = await algoliaIndex.search('', {
                facetFilters: currentFacetFilters,
                attributesToRetrieve: ['objectID'], // We only need the IDs
                hitsPerPage: 5852, // Max number of songs, ensure this is high enough
            });

            const matchingSongIdsArr = hits.map(hit => parseInt(hit.objectID, 10)).filter(n => Number.isFinite(n));
            const matchingSet = new Set(matchingSongIdsArr);

            // Dim non-matching songs currently visible
            const visibleSongs = getVisibleSongs();
            visibleSongs.forEach(visibleSong => {
                if (!matchingSet.has(visibleSong.id)) {
                    const overlay = createOverlayForSong(visibleSong.id);
                    filterOverlays.set(visibleSong.id, overlay);
                }
            });

            // Green outline around matches (all, not just visible)
            highlightFilteredSongs(matchingSongIdsArr);
        } catch (error) {
            console.error("Error applying filters with Algolia:", error);
        }
    }

    async function initializeFilterSections() { // Made async
        const filterContentDiv = document.querySelector('#right-sidebar .filter-content'); // Target the content div directly
        filterContentDiv.innerHTML = ''; // Clear only the dynamic content area

        // Define the order and display names for filters
        const categoryOrder = ['Topic', 'Genre', 'Mood', 'Location', 'Instrument', 'Style', 'Noun', 'Proper Noun'];

        // Insert a Clear button at the top (once)
        const clearBtn = document.createElement('button');
        clearBtn.textContent = 'Clear Filters';
        clearBtn.style.margin = '0 0 12px 16px';
        clearBtn.addEventListener('click', () => {
            // Uncheck all checkboxes
            filterContentDiv.querySelectorAll('.filter-checkbox').forEach(cb => (cb.checked = false));
            selectedFilters.clear();
            viewer.viewport.goHome();
            updateFilterOverlays();
            initializeFilterSections();
        });
        filterContentDiv.appendChild(clearBtn);

        try {
            const { facets } = await algoliaIndex.search('', {
                facets: categoryOrder, // Request facets for these categories
                hitsPerPage: 0, // We only need facet data, not actual hits
                maxValuesPerFacet: 1000,
                facetFilters: buildFacetFilters()
            });

            if (!facets) {
                console.error("No facets received from Algolia.");
                // Potentially display an error message in the UI
                return;
            }

            categoryOrder.forEach(traitType => {
                const facetValues = facets[traitType];
                if (!facetValues || Object.keys(facetValues).length === 0) {
                    return; // Skip if this facet has no values
                }

                const section = document.createElement('div');
                section.className = 'filter-section';

                const headerEl = document.createElement('div');
                headerEl.className = 'filter-section-header';
                // Display count of distinct values for this trait_type
                headerEl.innerHTML = `<span class="filter-section-title">${traitType}</span><span class="filter-count">${Object.keys(facetValues).length}</span>`;

                const options = document.createElement('div');
                options.className = 'filter-options';
                options.style.display = 'none';

                // Sort facet values by count (descending) then name (ascending)
                const sortedValues = Object.entries(facetValues).sort(
                    ([aName, aCount], [bName, bCount]) => {
                        if (bCount === aCount) {
                            return aName.localeCompare(bName);
                        }
                        return bCount - aCount;
                    }
                );

                sortedValues.forEach(([value, count]) => {
                    const option = document.createElement('div');
                    option.className = 'filter-option';
                    const id = `filter-${traitType}-${value}`.replace(/\s+/g, '-').toLowerCase();
                    const checked = selectedFilters.has(traitType) && selectedFilters.get(traitType).has(value);
                    option.innerHTML = `
                        <input type="checkbox" id="${id}" class="filter-checkbox" data-trait="${traitType}" data-value="${value}" ${checked ? 'checked' : ''}>
                        <label for="${id}" class="filter-label"><span class="filter-value">${value}</span><span class="filter-value-count">${count}</span></label>`;

                    option.querySelector('input').addEventListener('change', e => {
                        const trait = e.target.dataset.trait;
                        const val = e.target.dataset.value;
                        if (!selectedFilters.has(trait)) selectedFilters.set(trait, new Set());
                        if (e.target.checked) {
                            selectedFilters.get(trait).add(val);
                        } else {
                            selectedFilters.get(trait).delete(val);
                            if (selectedFilters.get(trait).size === 0) selectedFilters.delete(trait);
                        }
                        viewer.viewport.goHome(); // zoom out so context is visible
                        updateFilterOverlays(); // refresh dimming/highlights
                        initializeFilterSections(); // refresh available options
                        e.stopPropagation();
                    });
                    options.appendChild(option);
                });

                section.appendChild(headerEl);
                section.appendChild(options);
                filterContentDiv.appendChild(section);

                headerEl.addEventListener('click', () => {
                    const hidden = options.style.display === 'none'; // Corrected variable name
                    document.querySelectorAll('.filter-options').forEach(opt => (opt.style.display = 'none'));
                    if (hidden) options.style.display = 'block';
                });
            });
        } catch (error) {
            console.error("Error initializing filter sections from Algolia:", error);
            // Potentially display an error message in the UI
        }
    }

    function toggleRightSidebar() {
        const sidebar = document.getElementById('right-sidebar');
        const isVisible = sidebar.classList.contains('visible');

        if (isVisible) {
            sidebar.classList.remove('visible');
        } else {
            sidebar.classList.add('visible');
            if (!sidebar.hasAttribute('data-initialized')) {
                initializeFilterSections();
                sidebar.setAttribute('data-initialized', 'true');
            }
        }
    }

    // Event listener for the new main Explore button in the top bar
    const exploreBtn = document.getElementById('explore-btn');
    if (exploreBtn) {
        exploreBtn.addEventListener('click', toggleRightSidebar);
    }

    // Event listener for the new close button in the right sidebar header
    const closeFilterBtn = document.getElementById('close-filter-btn');
    if (closeFilterBtn) {
        closeFilterBtn.addEventListener('click', toggleRightSidebar);
    }

    // Style tweaks (unchanged)
    const styleSheet = document.createElement('style');
    styleSheet.textContent = `
        .filter-option{display:flex;align-items:center;justify-content:space-between;padding:8px 16px;}
        .filter-option:hover{background:rgba(0,0,0,0.05);}
        .filter-label{flex:1;display:flex;justify-content:space-between;align-items:center;margin-left:12px;cursor:pointer;}
        .filter-value{color:black;}
        .filter-value-count{color:#666;font-size:14px;}
        .filter-section-header{padding:12px 16px;}
        .filter-options{background:#f5f5f5;margin:0 -20px;}
    `;
    document.head.appendChild(styleSheet);

    viewer.addHandler('open', () => {
        viewer.viewport.goHome(true);
        const imageBounds = viewer.viewport.getHomeBounds();
        if (typeof viewer.viewport.fitBounds === 'function') {
            viewer.viewport.fitBounds(imageBounds, true);
        }
    });

    // END copied logic --------------------------------------------------

    // No bottom control bar – controls moved or removed

    // Ensure updateForSaleCount is defined before initOpenSea uses it.
    // (Hoisting should handle this for function declarations, but being explicit)
    async function updateForSaleCount() {
        if (!collectionSlug || !forSaleCountSpan || !OPENSEA_API_KEY) {
            if (forSaleCountSpan) forSaleCountSpan.textContent = 'N/A';
            return;
        }
        try {
            // Fetch as many listings as possible (up to 10k) via the /best endpoint and count the rows directly.
            const listingsForCount = await getBestListings();
            forSaleCountSpan.textContent = listingsForCount.length.toString();
        } catch (error) {
            console.error("Failed to update for-sale count:", error);
            if (forSaleCountSpan) forSaleCountSpan.textContent = 'N/A';
        }
    }

    async function initOpenSea() {
        console.log('initOpenSea called. API Key:', OPENSEA_API_KEY ? 'Present' : 'Missing', 'Contract:', OPENSEA_CONTRACT_ADDRESS ? 'Present' : 'Missing');
        if (!OPENSEA_API_KEY || !OPENSEA_CONTRACT_ADDRESS) {
            console.warn("OpenSea API Key or Contract Address is not configured. OpenSea features will be disabled.");
            if (forSaleCountSpan) forSaleCountSpan.textContent = 'N/A';
            if(activityBtn) activityBtn.disabled = true;
            if(collectorsBtn) collectorsBtn.disabled = true;
            if(forSaleBtn) forSaleBtn.disabled = true;
            return;
        }
        try {
            const slug = await openSeaApi.getCollectionSlug(OPENSEA_CONTRACT_ADDRESS, OPENSEA_API_KEY);
            if (slug) {
                collectionSlug = slug;
                console.log("Fetched OpenSea collection slug:", collectionSlug);
                // Refresh the for-sale counter in the background so we don't block the sidebar UI
                updateForSaleCount().catch(err => console.error('updateForSaleCount error', err));
            } else {
                console.error("Failed to fetch OpenSea collection slug. Slug was null or empty.");
                if (forSaleCountSpan) forSaleCountSpan.textContent = 'N/A';
                if(activityBtn) activityBtn.disabled = true;
                if(collectorsBtn) collectorsBtn.disabled = true;
                if(forSaleBtn) forSaleBtn.disabled = true;
            }
        } catch (error) {
            console.error("Error initializing OpenSea:", error);
            if (forSaleCountSpan) forSaleCountSpan.textContent = 'N/A';
            if(activityBtn) activityBtn.disabled = true;
            if(collectorsBtn) collectorsBtn.disabled = true;
            if(forSaleBtn) forSaleBtn.disabled = true;
        }
    }

    async function openLeftSidebar(contentType, title) {
        console.log(`openLeftSidebar called with contentType: ${contentType}, title: ${title}`);
        if (!leftSidebar || !leftSidebarTitle || !leftSidebarContent) {
            console.error('Left sidebar elements not found!');
            return;
        }

        if (!OPENSEA_API_KEY || !OPENSEA_CONTRACT_ADDRESS) {
            leftSidebarTitle.textContent = 'Error';
            leftSidebarContent.innerHTML = '<p>OpenSea integration is not configured.</p>';
            console.log('Attempting to show left sidebar for config error');
            leftSidebar.classList.add('visible');
            return;
        }
        
        if (!collectionSlug && (contentType === 'forSale' || contentType === 'activity' || contentType === 'collectors')) {
            leftSidebarTitle.textContent = title;
            leftSidebarContent.innerHTML = '<p>Initializing OpenSea data...</p>';
            console.log('Attempting to show left sidebar for initializing OpenSea');
            leftSidebar.classList.add('visible'); // Show sidebar with initializing message
            await initOpenSea(); // This will try to fetch slug and update count
            if (!collectionSlug) { // Check again if slug fetching failed
                 leftSidebarTitle.textContent = 'Error';
                 leftSidebarContent.innerHTML = '<p>Could not load collection data. Please check console for errors.</p>';
                 console.log('Attempting to show left sidebar for slug fetch error');
                 leftSidebar.classList.add('visible');
                 return;
            }
        }

        leftSidebarTitle.textContent = title;
        leftSidebarContent.innerHTML = '<p>Loading data...</p>';
        if (!leftSidebar.classList.contains('visible')) {
            console.log('Attempting to show left sidebar for content loading');
            leftSidebar.classList.add('visible');
        }

        try {
            let data;
            if (!collectionSlug) throw new Error("Collection slug not available.");

            // Deactivate sales view unless we're about to activate it below
            if (contentType !== 'sales') {
                deactivateSalesView();
            }

            // The switch block correctly handles fetching and rendering data.
            // No erroneous updateOpenSeaData() call should be here.
            switch (contentType) {
                case 'forSale':
                    data = await getBestListings();
                    await renderForSaleData(data, leftSidebarContent);

                    // Zoom out to full view and visually focus on items currently for sale
                    viewer.viewport.goHome();

                    // Extract numeric token IDs from the listings array
                    const saleIds = data
                        .map(l => l?.protocol_data?.parameters?.offer?.[0]?.identifierOrCriteria)
                        .map(id => parseInt(id, 10))
                        .filter(n => Number.isFinite(n));

                    activeSoldSet = new Set(saleIds); // re-use existing overlay logic
                    highlightSoldSongs(saleIds);      // reuse green-border highlight for now
                    updateSalesShadeOverlays();        // dim everything else
                    break;
                case 'activity':
                    // Build tabbed navigation for activity types if not already present
                    if (!leftSidebarContent.querySelector('.activity-tabs')) {
                        const tabsContainer = document.createElement('div');
                        tabsContainer.className = 'activity-tabs';
                        tabsContainer.style.display = 'flex';
                        tabsContainer.style.gap = '12px';
                        tabsContainer.style.marginBottom = '12px';

                        const tabs = [
                            { label: 'Listings', type: 'listing' },
                            { label: 'All', type: null },
                            { label: 'Sales', type: 'sale' },
                            { label: 'Offers', type: 'offer' }
                        ];

                        tabs.forEach(tab => {
                            const btn = document.createElement('button');
                            btn.textContent = tab.label;
                            btn.className = 'activity-tab-btn';
                            btn.dataset.eventType = tab.type ?? '';
                            btn.style.padding = '6px 10px';
                            btn.style.border = 'none';
                            btn.style.borderRadius = '4px';
                            btn.style.cursor = 'pointer';
                            btn.style.background = 'rgba(255,255,255,0.1)';
                            btn.style.color = '#fff';
                            btn.addEventListener('click', async () => {
                                Array.from(tabsContainer.children).forEach(c => c.classList.remove('active'));
                                btn.classList.add('active');
                                leftSidebarContent.querySelector('.activity-list')?.remove();
                                await loadAndRenderActivity(tab.type);
                            });
                            tabsContainer.appendChild(btn);
                        });
                        tabsContainer.firstChild.classList.add('active');
                        leftSidebarContent.innerHTML = ''; // clear loading text
                        leftSidebarContent.appendChild(tabsContainer);
                    }

                    // Helper to fetch + render list.
                    const loadAndRenderActivity = async (evType) => {
                        leftSidebarContent.querySelector('.activity-loading')?.remove();
                        const loadingP = document.createElement('p');
                        loadingP.textContent = 'Loading activity...';
                        loadingP.className = 'activity-loading';
                        leftSidebarContent.appendChild(loadingP);

                        try {
                            if (evType === 'listing') {
                                const activeListings = await getBestListings();

                                // Remove previous list (activity-list or for-sale-list)
                                leftSidebarContent.querySelector('.activity-list')?.remove();
                                leftSidebarContent.querySelector('.for-sale-list')?.remove();

                                const listContainer = document.createElement('div');
                                listContainer.className = 'for-sale-list';
                                leftSidebarContent.appendChild(listContainer);

                                await renderForSaleData(activeListings, listContainer);
                            } else {
                                const events = await openSeaApi.fetchActivity(collectionSlug, OPENSEA_API_KEY, 'ethereum', evType, 50);
                                // Filter out collection offers (order_type === 'collection_offer')
                                const filtered = events.filter(e => e.order_type !== 'collection_offer');
                                renderActivityData(filtered, leftSidebarContent);
                            }
                        } catch (err) {
                            console.error('Activity load error', err);
                            loadingP.textContent = 'Failed to load activity.';
                        } finally {
                            loadingP.remove();
                        }
                    };

                    await loadAndRenderActivity('listing');
                    return; // prevent default switch block execution
                case 'collectors':
                    if (!ETHERSCAN_API_KEY) {
                        leftSidebarContent.innerHTML = '<p>Etherscan API key missing. Please configure VITE_ETHERESCAN_API_KEY.</p>';
                        break;
                    }
                    // Fetch the entire transfer history to derive the current set of holders
                    data = await etherscanApi.fetchCollectors(OPENSEA_CONTRACT_ADDRESS, ETHERSCAN_API_KEY, {
                        pageSize: 1000,
                        sort: 'desc'
                    });
                    etherscanCollectorsCache = data; // cache for back button
                    renderCollectorsData(data, leftSidebarContent);
                    break;
                case 'sales':
                    data = await openSeaApi.fetchActivity(collectionSlug, OPENSEA_API_KEY, 'ethereum', 'sale', 50);
                    renderActivityData(data, leftSidebarContent);

                    // Zoom out to home view and highlight sold tokens
                    viewer.viewport.goHome();
                    // Ensure IDs are numeric so Set membership checks work correctly
                    const soldIds = data
                        .map(extractTokenId)
                        .map(id => parseInt(id, 10))
                        .filter(n => Number.isFinite(n));

                    activeSoldSet = new Set(soldIds);
                    highlightSoldSongs(soldIds);
                    updateSalesShadeOverlays();
                    break;
                default:
                    leftSidebarContent.innerHTML = '<p>Selected section not yet implemented.</p>';
            }
        } catch (error) {
            console.error(`Error fetching OpenSea ${contentType} data:`, error);
            leftSidebarTitle.textContent = 'Error';
            leftSidebarContent.innerHTML = '<p>Failed to load data from OpenSea. Please try again later.</p>';
        }
    }

    // Event Listeners for OpenSea sections
    if (activityBtn) {
        activityBtn.addEventListener('click', () => {
            console.log('Sales button clicked');
            openLeftSidebar('sales', 'Recent Sales');
        });
    }
    if (collectorsBtn) {
        collectorsBtn.addEventListener('click', () => {
            console.log('Collectors button clicked');
            openLeftSidebar('collectors', 'Top Collectors');
        });
    }
    if (forSaleBtn) {
        forSaleBtn.addEventListener('click', () => {
            console.log('For Sale button clicked');
            openLeftSidebar('forSale', 'Items For Sale');
        });
    }
    if (closeLeftSidebarBtn) {
        closeLeftSidebarBtn.addEventListener('click', () => {
            console.log('Close left sidebar button clicked');
            leftSidebar.classList.remove('visible');
            deactivateSalesView();
        });
    }

    // Ensure rendering functions are defined in the correct scope
    function formatEthFromWei(weiStr, decimals = 18, precision = 4) {
        try {
            if (!weiStr) return '0';
            // Ensure string
            const wei = BigInt(weiStr.toString());
            const divisor = BigInt(10) ** BigInt(decimals);
            const whole = wei / divisor;
            const fraction = wei % divisor;
            // Build fractional part padded with leading zeros then trim
            let fractionStr = fraction.toString().padStart(decimals, '0');
            // Keep only needed precision
            fractionStr = fractionStr.slice(0, precision);
            // Remove trailing zeros
            fractionStr = fractionStr.replace(/0+$/, '');
            return fractionStr.length > 0 ? `${whole}.${fractionStr}` : whole.toString();
        } catch (e) {
            return '0';
        }
    }

    async function renderForSaleData(listings, container) {
        container.innerHTML = ''; // Clear previous content
        if (!listings || listings.length === 0) {
            container.innerHTML = '<p>No items currently for sale.</p>';
            return;
        }

        // --- NEW: De-duplicate so we keep at most one listing per token_id ---
        const listingMap = new Map(); // tokenId (string) -> listing
        const miscListings = []; // listings that we cannot confidently assign a tokenId

        listings.forEach(l => {
            const tokenId = l?.protocol_data?.parameters?.offer?.[0]?.identifierOrCriteria;
            if (tokenId === undefined || tokenId === null) {
                miscListings.push(l);
                return;
            }
            const key = tokenId.toString();
            const existing = listingMap.get(key);
            if (!existing) {
                listingMap.set(key, l);
            } else {
                const newPrice = l.price?.current?.value ? BigInt(l.price.current.value) : BigInt(0);
                const exPrice = existing.price?.current?.value ? BigInt(existing.price.current.value) : BigInt(0);
                if (newPrice < exPrice) {
                    listingMap.set(key, l);
                } else if (newPrice === exPrice) {
                    // tie-breaker: prefer the most recently created listing
                    const ts = (obj) => Date.parse(obj.created_date || obj.order_created_date || obj.listing_date || obj.updated_date || 0);
                    if (ts(l) > ts(existing)) listingMap.set(key, l);
                }
            }
        });

        let dedupedListings = [...listingMap.values(), ...miscListings];

        const ul = document.createElement('ul');
        ul.style.listStyleType = 'none';
        ul.style.paddingLeft = '0';

        // Sort listings by price (ascending)
        dedupedListings.sort((a, b) => {
            const aVal = a.price?.current?.value ? BigInt(a.price.current.value) : BigInt(0);
            const bVal = b.price?.current?.value ? BigInt(b.price.current.value) : BigInt(0);
            return aVal > bVal ? 1 : aVal < bVal ? -1 : 0;
        });

        // Build map of tokenId -> song name via Algolia
        const tokenIds = dedupedListings.map(l => {
            const id = l.protocol_data?.parameters?.offer?.[0]?.identifierOrCriteria;
            return id ? id.toString() : null;
        }).filter(Boolean);

        const idToTitle = {};
        if (tokenIds.length) {
            try {
                const { results } = await algoliaIndex.getObjects(tokenIds);
                results.forEach(obj => {
                    if (obj) idToTitle[obj.objectID] = obj.name;
                });
            } catch (e) {
                console.error('Error fetching titles from Algolia:', e);
            }
        }

        dedupedListings.forEach(item => {
            const li = document.createElement('li');
            li.style.padding = '8px 0';
            li.style.borderBottom = '1px solid #444';

            // Extract token ID from protocol data
            let tokenId = null;
            if (item.protocol_data?.parameters?.offer?.length) {
                tokenId = item.protocol_data.parameters.offer[0].identifierOrCriteria;
            }

            const tokenIdStr = tokenId != null ? tokenId.toString() : null;
            // Attempt to get a human-readable title, prioritising Algolia result
            const title = (tokenIdStr && idToTitle[tokenIdStr]) || item.nft?.name || item.asset?.name || (tokenId ? `Song #${tokenId}` : 'Unknown Song');

            // Price formatting
            const priceInWei = item.price?.current?.value;
            const decimals = item.price?.current?.decimals || 18;
            const price = priceInWei ? formatEthFromWei(priceInWei, decimals) : 'N/A';
            const currency = item.price?.current?.currency || 'ETH';

            // Thumbnail image
            const imgUrl = item.nft?.image_url || item.nft?.display_image_url || item.asset?.image_url || item.asset?.display_image_url || '';

            // Image fallback to gallery GIF if OpenSea thumbnail missing
            const finalImg = imgUrl || (tokenId ? `https://songadaygallery.blob.core.windows.net/dzi/${tokenId}.gif` : '');

            li.innerHTML =
                `<div style="display:flex;gap:10px;align-items:center;">
                    <img src="${finalImg}" style="width:48px;height:48px;object-fit:cover;border-radius:4px;background:#222;" />
                    <div style="flex:1;">
                        <div style="font-weight:600;">${title}</div>
                        <div style="font-size:12px;color:#aaa;">Song #${tokenId ?? '—'}</div>
                    </div>
                    <div style="text-align:right;white-space:nowrap;">${price} ${currency}</div>
                 </div>`;
            ul.appendChild(li);

            // Add hover zoom behaviour similar to activity list
            if (tokenId) {
                li.addEventListener('mouseenter', () => {
                    const idNum = parseInt(tokenIdStr, 10);
                    if (!Number.isFinite(idNum) || idNum < 1 || idNum > 5852) return;
                    const col = (idNum - 1) % GRID_COLS;
                    const row = Math.floor((idNum - 1) / GRID_COLS);
                    const imgRect = new OpenSeadragon.Rect(col * CELL_WIDTH, row * CELL_HEIGHT, CELL_WIDTH, CELL_HEIGHT);

                    const PAD = 1.5;
                    const padW = imgRect.width * (PAD - 1) / 2;
                    const padH = imgRect.height * (PAD - 1) / 2;
                    const padded = new OpenSeadragon.Rect(imgRect.x - padW, imgRect.y - padH, imgRect.width * PAD, imgRect.height * PAD);

                    const vpRect = viewer.viewport.imageToViewportRectangle(padded);
                    viewer.viewport.fitBounds(vpRect, false);

                    const elementRect = viewer.viewport.viewportToViewerElementRectangle(viewer.viewport.imageToViewportRectangle(imgRect));
                    highlightBox.style.left = elementRect.x + 'px';
                    highlightBox.style.top = elementRect.y + 'px';
                    highlightBox.style.width = elementRect.width + 'px';
                    highlightBox.style.height = elementRect.height + 'px';
                    highlightBox.style.display = 'block';
                });

                li.addEventListener('mouseleave', () => {
                    highlightBox.style.display = 'none';
                });

                li.addEventListener('click', () => {
                    const idNum = parseInt(tokenIdStr, 10);
                    if (Number.isFinite(idNum)) displaySongDetails(idNum);
                });
            }

            li.addEventListener('mouseenter', () => { li.style.background = 'rgba(255,255,255,0.05)'; });
            li.addEventListener('mouseleave', () => { li.style.background = ''; });
        });
        container.appendChild(ul);
    }

    function renderActivityData(events, container) {
        // Helper to extract token ID from various event shapes (sale, offer, listing)
        const getTokenId = (event) => {
            return (
                event?.nft?.identifier ??
                event?.asset?.token_id ??
                event?.protocol_data?.parameters?.offer?.[0]?.identifierOrCriteria ??
                null
            );
        };
        // Remove previous list if exists
        container.querySelector('.activity-list')?.remove();
        if (!events || events.length === 0) {
            const p = document.createElement('p');
            p.textContent = 'No recent activity.';
            container.appendChild(p);
            return;
        }

        // Build map tokenId -> title via Algolia
        const tokenIdSet = new Set();
        events.forEach(ev => {
            const id = getTokenId(ev);
            if (id !== null && id !== undefined) tokenIdSet.add(id.toString());
        });

        const idToTitle = {};
        const titleToTokenId = {};

        // Collect titles that lack tokenId so we can look them up.
        const unknownTitles = new Set();
        events.forEach(ev => {
            const id = getTokenId(ev);
            if (id === null || id === undefined) {
                const t = (ev?.nft?.name || ev?.asset?.name || '').trim();
                if (t) unknownTitles.add(t.toLowerCase());
            }
        });

        // Task 1: tokenId -> title lookup (existing logic)
        const tasks = [];
        if (tokenIdSet.size) {
            tasks.push(
                algoliaIndex.getObjects(Array.from(tokenIdSet))
                    .then(({ results }) => {
                        results.forEach(obj => {
                            if (obj) idToTitle[obj.objectID] = obj.name;
                        });
                    })
                    .catch(err => console.error('Algolia title fetch error', err))
            );
        }

        // Task 2: title -> tokenId lookup for those without id
        if (unknownTitles.size) {
            const perTitlePromises = Array.from(unknownTitles).map(t =>
                algoliaIndex.search(t, {
                    hitsPerPage: 1,
                    restrictSearchableAttributes: ['name'],
                    attributesToRetrieve: ['objectID']
                }).then(res => {
                    const hit = res.hits && res.hits[0];
                    if (hit) {
                        titleToTokenId[t] = hit.objectID;
                        // Also capture id->title for consistency
                        idToTitle[hit.objectID] = hit.name || t;
                    }
                }).catch(err => console.error('Algolia lookup error', err))
            );
            tasks.push(Promise.all(perTitlePromises));
        }

        Promise.all(tasks).then(() => {
            // Deduplicate listing events so we only keep the most-recent per tokenId
            if (events.length && events[0].event_type === 'listing') {
                const seen = new Set();
                events = events.filter(ev => {
                    const id = getTokenId(ev);
                    if (id === null || id === undefined) return true; // keep when id unknown
                    if (seen.has(id)) return false;
                    seen.add(id);
                    return true;
                });
            }
            buildList();
        }).catch(err => { console.error('Algolia async error', err); buildList(); });

        function buildList() {
            const ul = document.createElement('ul');
            ul.className = 'activity-list';
            ul.style.listStyleType = 'none';
            ul.style.paddingLeft = '0';

            events.forEach(event => {
                const li = document.createElement('li');
                li.className = 'activity-row';
                li.style.display = 'flex';
                li.style.alignItems = 'center';
                li.style.gap = '12px';
                li.style.padding = '10px 0';
                li.style.borderBottom = '1px solid #444';

                // Thumbnail
                const thumb = document.createElement('img');
                thumb.className = 'activity-thumb';
                thumb.style.width = '48px';
                thumb.style.height = '48px';
                thumb.style.objectFit = 'cover';
                thumb.style.borderRadius = '4px';
                const imgUrl = event.nft?.display_image_url || event.nft?.image_url || event.asset?.display_image_url || event.asset?.image_url || '';
                if (imgUrl) thumb.src = imgUrl;
                else thumb.style.background = '#222';
                li.appendChild(thumb);

                // Determine title + token
                let tokenId = getTokenId(event);
                // If still missing, try title→token lookup
                if (tokenId === null || tokenId === undefined) {
                    const tRaw = (event.nft?.name || event.asset?.name || '').trim().toLowerCase();
                    if (tRaw && titleToTokenId[tRaw]) {
                        tokenId = titleToTokenId[tRaw];
                    }
                }

                const tokenIdStr = tokenId != null ? tokenId.toString() : '';
                const title = (tokenIdStr && idToTitle[tokenIdStr]) || (event.nft?.name || event.asset?.name) || `Song #${tokenIdStr}`;

                const eventType = event.event_type.replace(/_/g, ' ');

                // Details div
                const details = document.createElement('div');
                details.style.flex = '1';

                // Badge
                const badge = document.createElement('span');
                badge.textContent = eventType.charAt(0).toUpperCase() + eventType.slice(1);
                badge.className = `activity-badge badge-${event.event_type}`; // e.g., badge-sale
                badge.style.padding = '2px 6px';
                badge.style.borderRadius = '4px';
                badge.style.fontSize = '11px';
                badge.style.fontWeight = '700';
                badge.style.textTransform = 'capitalize';
                badge.style.marginRight = '6px';

                // apply colour
                const colourMap = {
                    sale: '#1f7a3d',
                    listing: '#7a3d1f',
                    offer: '#3d5d7a'
                };
                badge.style.background = colourMap[event.event_type] || '#555';
                badge.style.color = '#fff';

                const titleSpan = document.createElement('span');
                titleSpan.textContent = title;

                const firstRow = document.createElement('div');
                firstRow.appendChild(badge);
                firstRow.appendChild(titleSpan);

                // Address line
                const shortAddr = (addr) => addr ? `${addr.slice(0,4)}…${addr.slice(-4)}` : '';
                let addressLine = '';
                if (event.buyer && event.seller) {
                    addressLine = `${shortAddr(event.seller)} → ${shortAddr(event.buyer)}`;
                } else if (event.maker && event.taker !== undefined) {
                    addressLine = `${shortAddr(event.maker)} → ${shortAddr(event.taker || '')}`;
                }

                const addrDiv = document.createElement('div');
                addrDiv.style.fontSize = '11px';
                addrDiv.style.color = '#aaa';
                addrDiv.textContent = addressLine;

                details.appendChild(firstRow);
                if (addressLine) details.appendChild(addrDiv);
                li.appendChild(details);

                // Meta (price + time)
                const metaDiv = document.createElement('div');
                metaDiv.style.textAlign = 'right';
                metaDiv.style.fontSize = '12px';

                // Price logic
                let priceText = '';
                if (event.payment && event.payment.quantity) {
                    const amount = formatEthFromWei(event.payment.quantity, event.payment.decimals || 18, 3);
                    priceText = `${amount} ${event.payment.symbol || 'ETH'}`;
                } else if (event.total_price && event.payment_token) {
                    const amount = formatEthFromWei(event.total_price, event.payment_token.decimals || 18, 3);
                    priceText = `${amount} ${event.payment_token.symbol}`;
                }

                const priceDiv = document.createElement('div');
                priceDiv.textContent = priceText;

                // Timestamp
                const ts = event.event_timestamp || event.closing_date || null;
                let timeAgo = '';
                if (ts) {
                    const diffSec = Math.floor(Date.now()/1000) - ts;
                    const units = [
                        { l:'y', s:31536000 },
                        { l:'mo', s:2592000 },
                        { l:'d', s:86400 },
                        { l:'h', s:3600 },
                        { l:'m', s:60 }
                    ];
                    for (const u of units) {
                        if (diffSec >= u.s) { timeAgo = `${Math.floor(diffSec/u.s)}${u.l}`; break; }
                    }
                    if (!timeAgo) timeAgo = `${diffSec}s`;
                }

                const timeDiv = document.createElement('div');
                timeDiv.style.color = '#aaa';
                timeDiv.style.fontSize = '10px';
                timeDiv.textContent = timeAgo;

                metaDiv.appendChild(priceDiv);
                metaDiv.appendChild(timeDiv);
                li.appendChild(metaDiv);

                ul.appendChild(li);

                // Hover zoom effect to center on this song in the main viewer
                if (tokenId) {
                    li.addEventListener('mouseenter', () => {
                        const idNum = parseInt(tokenIdStr, 10);
                        if (!Number.isFinite(idNum) || idNum < 1 || idNum > 5852) return;
                        const col = (idNum - 1) % GRID_COLS;
                        const row = Math.floor((idNum - 1) / GRID_COLS);
                        const imgRect = new OpenSeadragon.Rect(col * CELL_WIDTH, row * CELL_HEIGHT, CELL_WIDTH, CELL_HEIGHT);

                        // Pad the rect a bit so the NFT isn't edge-to-edge
                        const PAD = 1.5; // zoom out factor (>1 means wider)
                        const padW = imgRect.width * (PAD - 1) / 2;
                        const padH = imgRect.height * (PAD - 1) / 2;
                        const padded = new OpenSeadragon.Rect(imgRect.x - padW, imgRect.y - padH, imgRect.width * PAD, imgRect.height * PAD);

                        const vpRect = viewer.viewport.imageToViewportRectangle(padded);
                        viewer.viewport.fitBounds(vpRect, false); // animate

                        // Also draw highlight box around the song
                        const elementRect = viewer.viewport.viewportToViewerElementRectangle(viewer.viewport.imageToViewportRectangle(imgRect));
                        highlightBox.style.left = elementRect.x + 'px';
                        highlightBox.style.top = elementRect.y + 'px';
                        highlightBox.style.width = elementRect.width + 'px';
                        highlightBox.style.height = elementRect.height + 'px';
                        highlightBox.style.display = 'block';
                    });

                    li.addEventListener('mouseleave', () => {
                        highlightBox.style.display = 'none';
                    });

                    // Click opens modal with details
                    li.addEventListener('click', () => {
                        const idNum = parseInt(tokenIdStr, 10);
                        if (Number.isFinite(idNum)) {
                            displaySongDetails(idNum);
                        }
                    });
                }

                // Row hover visual effect
                li.addEventListener('mouseenter', () => {
                    li.style.background = 'rgba(255,255,255,0.05)';
                });
                li.addEventListener('mouseleave', () => {
                    li.style.background = '';
                });
            });
            container.appendChild(ul);
        }
    }

    function renderCollectorsData(collectorsData, container) {
        container.innerHTML = ''; // clear

        const { collectors, totalScanned } = collectorsData;
        if (!collectors || collectors.length === 0) {
            container.innerHTML = '<p>No collector data available.</p>';
            return;
        }

        const infoP = document.createElement('p');
        infoP.textContent = `Top collectors (based on ${totalScanned.toLocaleString()} transfers analysed):`;
        infoP.style.fontSize = '12px';
        infoP.style.color = '#aaa';
        infoP.style.marginBottom = '8px';
        container.appendChild(infoP);

        const ul = document.createElement('ul');
        ul.style.listStyleType = 'none';
        ul.style.paddingLeft = '0';

        // helper to resolve ENS name
        const resolveEns = async (addr) => {
            try {
                const res = await fetch(`https://api.ensideas.com/ens/resolve/${addr}`);
                const js = await res.json();
                if (js?.name) return js.name;
            } catch {}
            return null;
        };

        collectors.forEach(col => {
            const li = document.createElement('li');
            li.style.padding = '6px 0';
            li.style.borderBottom = '1px solid #444';
            li.style.cursor = 'pointer';

            // initial display – truncated address; we'll try ENS in background
            const shortAddr = `${col.address.substring(0,6)}…${col.address.substring(col.address.length - 4)}`;
            li.innerHTML = `<span class="collector-name">${shortAddr}</span> (<strong>${col.count}</strong>)`;

            // async ENS resolve
            resolveEns(col.address).then(name => {
                if (name) {
                    li.querySelector('.collector-name').textContent = name;
                }
            });

            li.addEventListener('click', () => {
                renderCollectorTokens(col, container);
            });

            ul.appendChild(li);
        });

        container.appendChild(ul);
    }

    // Show list of tokens for a specific collector
    async function renderCollectorTokens(collector, container) {
        const { address, tokens } = collector;

        // Zoom out and focus overlays
        viewer.viewport.goHome();
        const numericIds = tokens.map(id => parseInt(id, 10)).filter(n => Number.isFinite(n));
        activeSoldSet = new Set(numericIds);
        highlightSoldSongs(numericIds);
        updateSalesShadeOverlays();

        // back button
        container.innerHTML = '';
        const backBtn = document.createElement('button');
        backBtn.textContent = '← Back to collectors';
        backBtn.style.marginBottom = '8px';
        backBtn.addEventListener('click', () => {
            deactivateSalesView();
            renderCollectorsData({ collectors: etherscanCollectorsCache.collectors, totalScanned: etherscanCollectorsCache.totalScanned }, container);
        });
        container.appendChild(backBtn);

        const heading = document.createElement('h3');
        heading.textContent = `Tokens owned by ${address.substring(0,6)}…${address.slice(-4)}`;
        heading.style.fontSize = '14px';
        heading.style.margin = '8px 0';
        container.appendChild(heading);

        if (numericIds.length === 0) {
            container.appendChild(document.createTextNode('No tokens found.'));
            return;
        }

        // Get titles from Algolia
        let idToTitle = {};
        try {
            const { results } = await algoliaIndex.getObjects(numericIds.map(n => n.toString()));
            results.forEach(obj => { if (obj) idToTitle[obj.objectID] = obj.name; });
        } catch {}

        const ul = document.createElement('ul');
        ul.style.listStyleType = 'none';
        ul.style.paddingLeft = '0';

        numericIds.forEach(idNum => {
            const li = document.createElement('li');
            li.style.padding = '6px 0';
            li.style.borderBottom = '1px solid #444';

            const title = idToTitle[idNum] || `Song #${idNum}`;
            const imgUrl = `https://songadaygallery.blob.core.windows.net/dzi/${idNum}.gif`;

            li.innerHTML = `<div style="display:flex;gap:10px;align-items:center;">
                <img src="${imgUrl}" style="width:32px;height:32px;object-fit:cover;border-radius:4px;background:#222;" />
                <span>${title}</span>
            </div>`;

            // hover zoom
            li.addEventListener('mouseenter', () => {
                const col = (idNum - 1) % GRID_COLS;
                const row = Math.floor((idNum - 1) / GRID_COLS);
                const imgRect = new OpenSeadragon.Rect(col * CELL_WIDTH, row * CELL_HEIGHT, CELL_WIDTH, CELL_HEIGHT);
                const PAD = 1.5;
                const padW = imgRect.width * (PAD - 1) / 2;
                const padH = imgRect.height * (PAD - 1) / 2;
                const padded = new OpenSeadragon.Rect(imgRect.x - padW, imgRect.y - padH, imgRect.width * PAD, imgRect.height * PAD);
                const vpRect = viewer.viewport.imageToViewportRectangle(padded);
                viewer.viewport.fitBounds(vpRect, false);

                const elementRect = viewer.viewport.viewportToViewerElementRectangle(viewer.viewport.imageToViewportRectangle(imgRect));
                highlightBox.style.left = `${elementRect.x}px`;
                highlightBox.style.top = `${elementRect.y}px`;
                highlightBox.style.width = `${elementRect.width}px`;
                highlightBox.style.height = `${elementRect.height}px`;
                highlightBox.style.display = 'block';
            });

            li.addEventListener('mouseleave', () => { highlightBox.style.display = 'none'; });

            li.addEventListener('click', () => displaySongDetails(idNum));

            ul.appendChild(li);
        });

        container.appendChild(ul);
    }

    function closeLeftSidebar() {
        console.log('Close left sidebar button clicked');
        leftSidebar.classList.remove('visible');
        deactivateSalesView();
    }

    // Kick off OpenSea slug resolution and listing crawl as soon as page loads (non-blocking)
    if (OPENSEA_API_KEY && OPENSEA_CONTRACT_ADDRESS) {
        initOpenSea().catch(err => console.error('Early initOpenSea error', err));
    }

    // Utility: extract tokenId from an OpenSea event object (sale/listing/etc.)
    function extractTokenId(evt) {
        return (
            evt?.nft?.identifier ??
            evt?.asset?.token_id ??
            evt?.protocol_data?.parameters?.offer?.[0]?.identifierOrCriteria ??
            null
        );
    }

    function clearSalesShadeOverlays() {
        salesShadeOverlays.forEach(o => o.remove());
        salesShadeOverlays.clear();
    }

    function createShadeOverlay(song) {
        // song is {id, rect}
        const viewportRect = viewer.viewport.imageToViewportRectangle(song.rect);
        const elementRect = viewer.viewport.viewportToViewerElementRectangle(viewportRect);
        const overlay = document.createElement('div');
        overlay.style.position = 'absolute';
        overlay.style.background = 'rgba(0,0,0,0.6)';
        overlay.style.pointerEvents = 'none';
        overlay.style.zIndex = '1000';
        overlay.style.left = elementRect.x + 'px';
        overlay.style.top = elementRect.y + 'px';
        overlay.style.width = elementRect.width + 'px';
        overlay.style.height = elementRect.height + 'px';
        viewer.element.appendChild(overlay);
        return overlay;
    }

    function updateSalesShadeOverlays() {
        if (!activeSoldSet) return;

        // First remove overlays that are no longer needed (no longer visible or sold now)
        salesShadeOverlays.forEach((overlay, id) => {
            if (!activeSoldSet.has(id)) {
                overlay.remove();
                salesShadeOverlays.delete(id);
                return;
            }
            // If still in sold set, ensure it's visible (we recreate as needed below)
        });

        // Add overlays for currently visible non-sold songs
        const visibleSongs = getVisibleSongs();
        const visibleIds = new Set(visibleSongs.map(s => s.id));

        // Remove overlays that are no longer in viewport
        salesShadeOverlays.forEach((overlay, id) => {
            if (!visibleIds.has(id) || activeSoldSet.has(id)) {
                overlay.remove();
                salesShadeOverlays.delete(id);
            }
        });

        visibleSongs.forEach(song => {
            if (activeSoldSet.has(song.id)) return; // sold – highlight elsewhere
            const existing = salesShadeOverlays.get(song.id);
            const viewportRect = viewer.viewport.imageToViewportRectangle(song.rect);
            const elementRect = viewer.viewport.viewportToViewerElementRectangle(viewportRect);
            if (existing) {
                existing.style.left = elementRect.x + 'px';
                existing.style.top = elementRect.y + 'px';
                existing.style.width = elementRect.width + 'px';
                existing.style.height = elementRect.height + 'px';
            } else {
                const overlay = createShadeOverlay(song);
                salesShadeOverlays.set(song.id, overlay);
            }
        });
    }

    function deactivateSalesView() {
        activeSoldSet = null;
        clearSoldHighlights();
        clearSalesShadeOverlays();
    }

    function clearFilterHighlights() {
        filterHighlightOverlays.forEach(o => o.remove());
        filterHighlightOverlays.clear();
    }

    function highlightFilteredSongs(tokenIds) {
        clearFilterHighlights();
        const unique = Array.from(new Set(tokenIds.map(id => parseInt(id, 10)).filter(n => Number.isFinite(n) && n >= 1 && n <= 5852)));
        unique.forEach(id => {
            const overlay = createSoldOverlay(id); // reuse existing green-border helper
            filterHighlightOverlays.set(id, overlay);
        });
    }

})(); 