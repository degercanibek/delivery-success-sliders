// Preview checks are convenience only; the RPC validates and commits atomically.
export function parseArchive(text) {
  try {
    if (new TextEncoder().encode(text).length > 5 * 1024 * 1024) throw Error();
    const archive = JSON.parse(text);
    if (archive?.schema_version !== 1 || !archive.session || typeof archive.session !== 'object' ||
        !Array.isArray(archive.groups) || !Array.isArray(archive.dimensions) || !Array.isArray(archive.responses) ||
        archive.groups.length > 100 || archive.dimensions.length > 100 || archive.responses.length > 10000) throw Error();
    return archive;
  } catch { throw Error('DSS_ARCHIVE'); }
}
