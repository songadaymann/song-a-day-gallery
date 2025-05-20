import algoliasearch from 'algoliasearch';

export function initAlgoliaIndex(appId, searchKey, indexName) {
  const client = algoliasearch(appId, searchKey);
  return client.initIndex(indexName);
}
