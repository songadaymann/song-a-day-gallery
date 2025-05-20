export function initSearchBar(inputEl, algoliaIndex, onSelect, onSearch) {
  const container = document.createElement('div');
  container.className = 'search-results';
  inputEl.parentNode.style.position = 'relative';
  inputEl.parentNode.appendChild(container);

  async function renderResults(q) {
    container.innerHTML = '';
    if (!q) return;
    try {
      const { hits } = await algoliaIndex.search(q, { hitsPerPage: 5 });
      hits.forEach(hit => {
        const item = document.createElement('div');
        item.className = 'search-result';
        const title = hit.name || `Song #${hit.token_id}`;
        item.textContent = title;
        item.addEventListener('click', () => {
          container.innerHTML = '';
          inputEl.value = '';
          if (onSelect) onSelect(parseInt(hit.objectID, 10));
        });
        container.appendChild(item);
      });
    } catch (err) {
      console.error('Search error', err);
    }
  }

  inputEl.addEventListener('input', e => {
    renderResults(e.target.value.trim());
  });

  inputEl.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const q = inputEl.value.trim();
      container.innerHTML = '';
      if (onSearch) {
        onSearch(q);
      } else {
        const first = container.querySelector('.search-result');
        if (first) first.click();
      }
    }
  });
}
