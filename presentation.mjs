export function letter(index) {
  let result = '';
  do { result = String.fromCharCode(65 + index % 26) + result; index = Math.floor(index / 26) - 1; } while (index >= 0);
  return result;
}
// Randomized per presentation, never based on the public configuration order.
// Existing aliases survive live refreshes, removals, additions and reveal toggles.
export function identityMap(random = Math.random) {
  const aliases = new Map();
  return {
    sync(items) {
      const unseen = items.filter(item => !aliases.has(item.id));
      for (let i = unseen.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [unseen[i], unseen[j]] = [unseen[j], unseen[i]];
      }
      for (const item of unseen) aliases.set(item.id, aliases.size);
      return [...items].sort((a, b) => aliases.get(a.id) - aliases.get(b.id));
    },
    index: id => aliases.get(id)
  };
}
const palette = ['#9b8aff', '#4bdcc4', '#f3bb70', '#70baff', '#f58fbc', '#b6d977'];
export function chartOption({ groups, dimensions, results }, visible, identities, dimensionAliases, lang, reducedMotion = false, viewport = {}) {
  const width = viewport.width || 1200, height = viewport.height || 560;
  const scale = Math.max(0.8, Math.min(2.8, width / 1200, height / 560));
  const px = value => Math.round(value * scale);
  const localized = item => item[`name_${lang}`] || item.name_tr || item.name_en;
  const ordered = identities.sync(groups);
  // Dimension order stays on the configured x axis; aliases never shift after removals.
  for (const d of dimensions) if (!dimensionAliases.has(d.id)) dimensionAliases.set(d.id, dimensionAliases.size);
  const dimensionNames = dimensions.map(d => visible.categories ? localized(d) : `${lang === 'tr' ? 'Boyut' : 'Dimension'} ${letter(dimensionAliases.get(d.id))}`);
  const values = new Map(results.averages.map(a => [`${a.group_id}/${a.dimension_id}`, a.average]));
  const counts = new Map((results.groups || []).map(g => [g.group_id, g.response_count]));
  const legendCounts = new Map(ordered.map(g => [visible.groups ? localized(g) : `${lang === 'tr' ? 'Grup' : 'Group'} ${letter(identities.index(g.id))}`, counts.get(g.id) || 0]));
  return {
    backgroundColor: 'transparent', animation: !reducedMotion, animationDuration: 650, animationDurationUpdate: 550, animationEasingUpdate: 'cubicOut',
    aria: { enabled: false }, // Avoid automatic descriptions leaking hidden values or names.
    tooltip: { show: visible.values, trigger: 'axis', renderMode: 'richText', confine: true, backgroundColor: '#151d32', borderColor: '#354161', textStyle: { color: '#eef2ff', fontSize: px(14) } },
    legend: { formatter: label => `${label} · ${legendCounts.get(label) || 0} ${lang === 'tr' ? 'oy' : 'votes'}`, show: true, type: 'scroll', top: px(8), icon: 'roundRect', selectedMode: false, itemWidth: px(14), itemHeight: px(8), itemGap: px(24), pageTextStyle: { color: '#c4cde6', fontSize: px(12) }, pageIconSize: px(12), textStyle: { color: '#c4cde6', fontSize: px(13) } },
    grid: { containLabel: true, left: px(24), right: px(24), bottom: px(28), top: px(80) },
    xAxis: { type: 'category', data: dimensionNames, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: '#dce4fb', fontSize: px(15), margin: px(22), interval: 0, width: Math.max(60, Math.floor((width - px(100)) / Math.max(1, dimensions.length) - px(18))), overflow: 'truncate' } },
    yAxis: { type: 'value', min: 0, max: 100, show: visible.axis, axisLabel: { color: '#8c9bbd', fontSize: px(12) }, splitLine: { lineStyle: { color: 'rgba(174,192,231,0.08)', type: 'dashed' } }, axisLine: { show: false }, axisTick: { show: false } },
    series: ordered.map(g => {
      const index = identities.index(g.id);
      const color = visible.groups ? palette[index % palette.length] : '#a0aec6';
      return {
        id: `series-${letter(index)}`,
        name: visible.groups ? localized(g) : `${lang === 'tr' ? 'Grup' : 'Group'} ${letter(index)}`,
        type: 'bar', barMaxWidth: px(58), barGap: '24%', barCategoryGap: '35%',
        itemStyle: { borderRadius: [px(9), px(9), px(3), px(3)], color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color }, { offset: 1, color: `${color}70` }] }, shadowBlur: visible.groups ? px(14) : 0, shadowColor: `${color}25` },
        emphasis: { disabled: true },
        label: { show: visible.values, position: 'top', distance: px(12), color: '#f3f6ff', fontSize: px(16), fontWeight: 650, formatter: p => Number(p.value).toFixed(1) },
        data: dimensions.map(d => values.get(`${g.id}/${d.id}`) ?? null)
      };
    })
  };
}
// Serial polling: no overlapping requests, stale in-flight snapshots cannot bypass freeze.
export function liveFeed({ load, apply, status = () => {}, delay = 3000, schedule = setTimeout, cancel = clearTimeout }) {
  let frozen = false, stopped = false, busy = false, queued = false, epoch = 0, timer;
  async function refresh() {
    cancel(timer);
    if (stopped || frozen) return;
    if (busy) { queued = true; return; }
    busy = true;
    const requestEpoch = epoch;
    try {
      const data = await load();
      if (!stopped && !frozen && epoch === requestEpoch) { apply(data); status('live'); }
    } catch (error) {
      if (!stopped && !frozen && epoch === requestEpoch) status('error', error);
    } finally {
      busy = false;
      if (!stopped && !frozen) {
        if (queued) { queued = false; void refresh(); }
        else timer = schedule(refresh, delay);
      }
    }
  }
  timer = schedule(refresh, delay);
  return {
    refresh,
    freeze(value) {
      frozen = value; epoch++; cancel(timer); queued = false;
      status(frozen ? 'frozen' : 'syncing');
      if (!frozen) void refresh();
    },
    stop() { stopped = true; epoch++; cancel(timer); }
  };
}
