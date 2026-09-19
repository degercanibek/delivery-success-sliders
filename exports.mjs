// Quote every CSV field, including newlines. Neutralize spreadsheet formula prefixes.
export function csvCell(value) {
  let text = String(value ?? '');
  if (/^[\s\uFEFF]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
export function responsesCsv(archive) {
  const headers = ['response_id', 'created_at', 'session_slug', 'group_id', 'group_name_tr', 'group_name_en',
    ...archive.dimensions.map(d => `${d.name_tr} / ${d.name_en} [${d.id}]`)];
  const groups = new Map(archive.groups.map(g => [g.id, g]));
  const rows = archive.responses.map(r => {
    const group = groups.get(r.group_id);
    return [r.id, r.created_at, archive.session.slug, r.group_id, group?.name_tr, group?.name_en,
      ...archive.dimensions.map(d => r.answers[d.id])];
  });
  return '\uFEFF' + [headers, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
export function downloadFile(content, filename, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = filename;
  document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
