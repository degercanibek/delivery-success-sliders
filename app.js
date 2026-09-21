import { initialAllocation, setAllocation, remainingFor, useRemaining, validAllocation } from './allocation.mjs';
import { identityMap, chartOption, liveFeed, groupParticipation } from './presentation.mjs';
import { responsesCsv, downloadFile } from './exports.mjs';

const SUPABASE_URL = 'https://jfywumazazihkooktkwr.supabase.co';
const SUPABASE_KEY = 'sb_publishable_pQU9cnTPC1dNT2CkAVGLsQ_1Sh4Gipg';
const app = document.querySelector('#app');
let lang = 'tr';
try { lang = localStorage.getItem('dss-lang') === 'en' ? 'en' : 'tr'; } catch { /* Language can remain in memory. */ }
let sb, chart, revision = 0, routeCleanup = () => {};
const submittedSessions = new Set();
const tr = (a, b) => lang === 'tr' ? a : b;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[c]);
const name = item => item[`name_${lang}`] || item.name_tr || item.name_en;
const title = item => item[`title_${lang}`] || item.title_tr || item.title_en;
const description = item => item[`description_${lang}`] || '';
const link = (page, slug) => `#${page}${slug ? `?s=${encodeURIComponent(slug)}` : ''}`;
const errors = {
  PGRST202: ['Bu özellik henüz hazır değil. Lütfen oturum yöneticisine haber verin.', 'This feature is not ready yet. Please contact the session organizer.'],
  DSS_FORBIDDEN: ['Bu alan yalnızca yetkili yönetici içindir.', 'This area requires an allowlisted administrator.'],
  DSS_NOT_FOUND: ['Oturum veya kayıt bulunamadı; silinmiş olabilir.', 'The session or record was not found; it may have been deleted.'],
  DSS_CLOSED: ['Oylama kapalı. Yanıtınız kaydedilmedi.', 'Voting is closed. Your response was not saved.'],
  DSS_CONFIG: ['Oylama için en az bir grup ve iki başarı boyutu gerekir.', 'Voting requires at least one group and two dimensions.'],
  DSS_GROUP: ['Bu oturuma ait bir grup seçin.', 'Choose a group belonging to this session.'],
  DSS_ANSWERS: ['Her boyut için 0–100 arasında geçerli bir sayı girin.', 'Enter a valid number from 0 to 100 for every dimension.'],
  DSS_TOTAL: ['Puanların toplamı tam olarak 100 olmalıdır.', 'The allocation must total exactly 100.'],
  DSS_DUPLICATE: ['Bu tarayıcı bu oturumda zaten oy kullandı.', 'This browser has already voted in this session.'],
  DSS_VOTE_NOT_FOUND: ['Önceki yanıt bulunamadı. Sayfayı yenileyip tekrar oy verin.', 'Your previous response was not found. Reload to submit a new vote.'],
  DSS_DEVICE: ['Oy vermek için tarayıcı depolamasını etkinleştirin.', 'Enable browser storage to vote.'],
  DSS_LOCKED: ['Yapılandırmayı değiştirmeden önce tüm yanıtları silin.', 'Delete all responses before changing the configuration.'],
  DSS_CLOSE_FIRST: ['Yapılandırmayı değiştirmeden önce oylamayı kapatın.', 'Close voting before changing the configuration.'],
  DSS_SLUG: ['Kısa ad yalnızca küçük harf, rakam ve aralarda tire içermelidir.', 'Use lowercase letters, numbers, and separating hyphens for the slug.'],
  DSS_NAME: ['Her iki dilde başlık/ad gereklidir.', 'A title/name in both languages is required.'],
  DSS_DEPENDENCY: ['Gerekli kütüphane yüklenemedi. Bağlantınızı kontrol edip sayfayı yenileyin.', 'A required library failed to load. Check your connection and reload.'],
  invalid_credentials: ['E-posta veya şifre yanlış.', 'Incorrect email or password.'],
  email_not_confirmed: ['Önce e-posta adresinizi doğrulayın.', 'Confirm your email address first.'],
  '23505': ['Bu kısa ad zaten kullanılıyor.', 'This slug is already in use.']
};
function errorMessage(error) {
  const key = Object.keys(errors).find(code => error?.code === code || error?.message?.includes(code));
  return key ? tr(...errors[key]) : tr('İşlem tamamlanamadı. Bağlantınızı ve Supabase kurulumunu kontrol edip tekrar deneyin.', 'The request failed. Check your connection and Supabase setup, then retry.');
}
function showError(root, error) {
  const box = root.querySelector('[data-error]');
  if (box) { box.textContent = errorMessage(error); box.hidden = false; }
  console.error('Delivery Success Sliders:', error?.code || error?.message || 'Request failed');
}
async function checked(request) {
  const { data, error } = await request;
  if (error) throw error;
  return data;
}
function routeInfo() {
  const hash = location.hash.slice(1).replace(/^\//, '');
  const [page, query] = hash.split('?');
  return { page: page || 'home', slug: new URLSearchParams(query ?? location.search).get('s') };
}
function layout(content) {
  document.documentElement.lang = lang;
  const participant = !['admin', 'manage', 'results'].includes(routeInfo().page);
  const languageButton = `<button class="btn" id="lang" aria-label="${tr('Switch to English', 'Türkçeye geç')}">${lang === 'tr' ? 'EN' : 'TR'}</button>`;
  const participantHeader = `<header class="participant-header">${languageButton}</header>`;
  const adminHeader = `<header class="top"><div class="brand">Delivery Success Sliders</div><nav class="nav"><a class="btn" href="#home">${tr('Ana Sayfa', 'Home')}</a><a class="btn" href="#admin">${tr('Yönetim', 'Admin')}</a><button class="btn" id="lang">${lang === 'tr' ? 'EN' : 'TR'}</button></nav></header>`;
  app.innerHTML = `<div class="shell ${participant ? 'participant-shell' : ''}">${participant ? participantHeader : adminHeader}<main><div class="error" role="alert" data-error hidden></div>${content}</main></div>`;
  document.querySelector('#lang').onclick = () => {
    lang = lang === 'tr' ? 'en' : 'tr';
    try { localStorage.setItem('dss-lang', lang); } catch { /* Optional preference. */ }
    route();
  };
  return app.querySelector('main');
}
function action(root, element, callback, event = 'click') {
  let pending = false;
  element.addEventListener(event, async e => {
    e.preventDefault();
    if (pending) return;
    pending = true;
    const button = element.matches('form') ? element.querySelector('[type=submit]') : element;
    button.disabled = true;
    button.dataset.pending = 'true';
    root.querySelector('[data-error]').hidden = true;
    try { await callback(); } catch (error) { if (root.isConnected) showError(root, error); }
    finally { pending = false; delete button.dataset.pending; if (button.isConnected) { button.disabled = false; button.dispatchEvent(new Event('actionend')); } }
  });
}
async function sessionData(slug, withResults = false) {
  if (!slug) throw Error('DSS_NOT_FOUND');
  const session = await checked(sb.from('sessions').select('*').eq('slug', slug).maybeSingle());
  if (!session) throw Error('DSS_NOT_FOUND');
  const [groups, dimensions, results] = await Promise.all([
    checked(sb.from('groups').select('*').eq('session_id', session.id).order('sort_order').order('id')),
    checked(sb.from('dimensions').select('*').eq('session_id', session.id).order('sort_order').order('id')),
    withResults ? checked(sb.rpc('session_results', { p_session_id: session.id })) : null
  ]);
  return { session, groups, dimensions, results };
}
async function requireAdmin() {
  const { data, error } = await sb.auth.getSession();
  if (error) throw error;
  if (!data.session) return false;
  if (!await checked(sb.rpc('is_admin'))) throw Error('DSS_FORBIDDEN');
  return true;
}
const adminAction = (actionName, sessionId = null, payload = {}) => checked(sb.rpc('admin_action', {
  p_action: actionName, p_session_id: sessionId, p_payload: payload
}));
const fields = (prefix, names = false) => `<div class="grid2">
  <label>${names ? 'Ad TR' : 'Başlık TR'}<input name="${prefix}_tr" required maxlength="200"></label>
  <label>${names ? 'Name EN' : 'Title EN'}<input name="${prefix}_en" required maxlength="200"></label>
  <label>Açıklama TR<textarea name="description_tr"></textarea></label>
  <label>Description EN<textarea name="description_en"></textarea></label></div>`;
const formData = form => Object.fromEntries(new FormData(form));

async function home() {
  layout(`<section class="card participant-message"><h1>${tr('Oturuma katılın', 'Join your session')}</h1><p>${tr('Oy vermek için sunucunun paylaştığı QR kodunu tarayın veya katılımcı bağlantısını açın.', 'Scan the presenter’s QR code or open your participant link to vote.')}</p></section>`);
}
function submitted(slug) {
  layout(`<section class="card participant-message"><div class="submitted-mark" aria-hidden="true">✓</div><h2>${tr('Teşekkürler', 'Thank you')}</h2><p>${tr('Cevabınız kaydedildi. Oylama açıkken aynı tarayıcıdan oyunuza geri dönebilirsiniz.', 'Your response has been recorded. You can edit it in this browser while voting is open.')}</p><button class="btn" id="edit-vote">${tr('Oyumu Düzenle', 'Edit my vote')}</button></section>`);
  document.querySelector('#edit-vote').onclick = () => { submittedSessions.delete(slug); void route(); };
}
function deviceToken() {
  try {
    let token = localStorage.getItem('dss-device');
    if (!token || token.length < 16 || token.length > 128) {
      token = crypto.randomUUID(); localStorage.setItem('dss-device', token);
    }
    // Check write access even when an existing token is present.
    localStorage.setItem('dss-device', token);
    return token;
  } catch { throw Error('DSS_DEVICE'); }
}
async function vote(slug, current) {
  if (submittedSessions.has(slug)) { if (current()) submitted(slug); return; }
  if (!slug) throw Error('DSS_NOT_FOUND');
  const { session, groups, dimensions } = await checked(sb.rpc('voting_session', { p_slug: slug }));
  if (!current()) return;
  if (!session.is_open) throw Error('DSS_CLOSED');
  if (groups.length < 1 || dimensions.length < 2) throw Error('DSS_CONFIG');
  const ids = dimensions.map(d => d.id);
  const token = deviceToken();
  const previous = await checked(sb.rpc('my_vote', { p_session_id: session.id, p_device_token: token }));
  if (!current()) return;
  const values = previous ? { ...previous.answers } : initialAllocation(ids);
  const root = layout(`<div class="stack voting-page"><section class="card vote-intro"><h1>${esc(title(session))}</h1><p class="muted">${esc(description(session))}</p><fieldset><legend><span class="step-number">1</span> ${tr('Grubunuzu seçin', 'Choose your group')}</legend><div class="group-choices">${groups.map(g => `<label class="choice"><input type="radio" name="group" value="${g.id}"><span><b>${esc(name(g))}</b><span class="muted block">${esc(description(g))}</span></span></label>`).join('')}</div></fieldset></section><section class="card allocation-card"><h2><span class="step-number">2</span> ${tr('100 puanı dağıtın', 'Allocate 100 points')}</h2><p class="muted">${tr('Her boyutu bağımsız ayarlayın. Bir boyutu kalan puanlarla tamamlamak için düğmesini kullanın.', 'Adjust each dimension independently. Use its button to fill the remaining points.')}</p><div class="stack">${dimensions.map(d => `<div class="slider"><div><label for="r-${d.id}"><b>${esc(name(d))}</b></label><div class="muted">${esc(description(d))}</div></div><input id="r-${d.id}" type="range" min="0" max="100" step="1" value="${values[d.id]}" data-range="${d.id}" aria-label="${esc(name(d))}"><input type="number" inputmode="numeric" min="0" max="100" step="1" value="${values[d.id]}" data-number="${d.id}" aria-label="${esc(name(d))} ${tr('puan', 'points')}"><div class="balance-control"><button class="btn" data-balance="${d.id}" aria-describedby="hint-${d.id}">${tr('Kalan Puanı Kullan', 'Use remaining points')}</button><small class="muted block" id="hint-${d.id}" data-balance-hint="${d.id}"></small></div></div>`).join('')}</div></section><div class="vote-dock"><div><div class="total">${tr('Toplam', 'Total')}: <output id="total">100</output><span class="muted">/100</span></div><p id="budget-status" role="status" aria-live="polite"></p></div><button class="btn primary" id="send">${previous ? tr('Oyumu Güncelle', 'Update my vote') : tr('Oyumu Gönder', 'Submit Vote')} →</button></div></div>`);
  if (previous) {
    const selected = [...root.querySelectorAll('[name=group]')].find(input => input.value === previous.group_id);
    if (selected) selected.checked = true;
  }
  const sync = () => {
    root.querySelectorAll('[data-range]').forEach(input => { input.value = values[input.dataset.range]; });
    root.querySelectorAll('[data-number]').forEach(input => { input.value = values[input.dataset.number]; });
    const total = Object.values(values).reduce((a, b) => a + b, 0);
    root.querySelector('#total').textContent = total;
    root.querySelector('.total').classList.toggle('over-budget', total > 100);
    root.querySelector('.vote-dock').classList.toggle('budget-complete', total === 100);
    root.querySelector('#budget-status').textContent = total === 100 ? (root.querySelector('[name=group]:checked') ? tr('Göndermeye hazır.', 'Ready to submit.') : tr('Göndermek için bir grup seçin.', 'Choose a group to submit.')) : total < 100 ? tr(`${100 - total} puan kaldı.`, `${100 - total} points remaining.`) : tr(`${total - 100} puan azaltın.`, `Remove ${total - 100} points.`);
    root.querySelector('#send').disabled = !validAllocation(values, ids) || root.querySelector('#send').dataset.pending === 'true';
    root.querySelectorAll('[data-balance]').forEach(button => {
      const remaining = remainingFor(values, button.dataset.balance);
      button.disabled = remaining < 0;
      root.querySelector(`[data-balance-hint="${button.dataset.balance}"]`).textContent = remaining < 0 ? tr('Diğer boyutlar 100 puanı aşıyor; önce onları azaltın.', 'The other dimensions exceed 100; reduce them first.') : tr(`Bu boyutu ${remaining} puana ayarla.`, `Set this dimension to ${remaining} points.`);
    });
  };
  root.querySelectorAll('[data-range]').forEach(input => input.addEventListener('input', () => { setAllocation(values, input.dataset.range, input.valueAsNumber); sync(); }));
  root.querySelectorAll('[data-number]').forEach(input => {
    input.addEventListener('input', () => {
      if (Number.isFinite(input.valueAsNumber)) { setAllocation(values, input.dataset.number, input.valueAsNumber); sync(); }
    });
    input.addEventListener('change', sync);
    input.addEventListener('blur', sync);
  });
  root.querySelectorAll('[name=group]').forEach(input => input.addEventListener('change', sync));
  root.querySelectorAll('[data-balance]').forEach(button => button.onclick = () => { useRemaining(values, button.dataset.balance); sync(); });
  root.querySelector('#send').addEventListener('actionend', sync);
  sync();
  action(root, root.querySelector('#send'), async () => {
    const group = root.querySelector('[name=group]:checked')?.value;
    if (!group) throw Error('DSS_GROUP');
    sync();
    if (!validAllocation(values, ids)) throw Error('DSS_TOTAL');
    await checked(sb.rpc(previous ? 'update_vote' : 'submit_vote', { p_session_id: session.id, p_group_id: group, p_answers: { ...values }, p_device_token: token }));
    submittedSessions.add(slug);
    if (root.isConnected) submitted(slug);
  });
}
function login(current) {
  const root = layout(`<form class="card stack login"><h1>${tr('Yönetici Girişi', 'Admin Login')}</h1><label>Email<input name="email" type="email" autocomplete="username" required></label><label>${tr('Şifre', 'Password')}<input name="password" type="password" autocomplete="current-password" required></label><button type="submit" class="btn primary">${tr('Giriş', 'Sign in')}</button></form>`);
  action(root, root.querySelector('form'), async () => {
    await checked(sb.auth.signInWithPassword(formData(root.querySelector('form'))));
    if (current()) await route();
  }, 'submit');
}
async function admin(current) {
  if (!await requireAdmin()) { if (current()) login(current); return; }
  const sessions = await checked(sb.from('sessions').select('*').order('created_at', { ascending: false }));
  if (!current()) return;
  const root = layout(`<div class="stack"><section class="card"><div class="top"><h1>${tr('Oturumlar', 'Sessions')}</h1><button class="btn" id="logout">${tr('Çıkış', 'Sign out')}</button></div><div class="admin-list">${sessions.map(s => `<div class="item"><div><b>${esc(title(s))}</b><div class="muted">${esc(s.slug)} · ${s.is_open ? tr('Açık', 'Open') : tr('Kapalı', 'Closed')}</div></div><a class="btn" href="${link('manage', s.slug)}">${tr('Yönet', 'Manage')}</a></div>`).join('')}</div></section><form class="card stack"><h2>${tr('Yeni Oturum', 'New Session')}</h2><label>${tr('Kısa ad', 'Slug')}<input name="slug" pattern="[a-z0-9]+(-[a-z0-9]+)*" placeholder="mvp-test-01" aria-describedby="slug-help" title="${tr('Küçük İngilizce harfler, rakamlar ve kelimeler arasında tek tire. Örnek: mvp-test-01', 'Lowercase English letters, numbers, and single hyphens between words. Example: mvp-test-01')}" required></label><p id="slug-help" class="muted">${tr('Kısa ad oturum bağlantısında kullanılır ve benzersiz olmalıdır. a–z, 0–9 ve kelimeler arasında tek tire kullanın; boşluk veya Türkçe karakter kullanmayın. Örnek: mvp-test-01', 'The slug is the unique name in your session link. Use a–z, 0–9, and single hyphens between words; no spaces or Turkish characters. Example: mvp-test-01')}</p>${fields('title')}<p class="muted">${tr('Yeni oturum kapalı başlar. Grupları ve boyutları ekledikten sonra açın.', 'New sessions start closed. Add groups and dimensions before opening voting.')}</p><button class="btn primary" type="submit">${tr('Oluştur', 'Create')}</button></form></div>`);
  action(root, root.querySelector('#logout'), async () => { await checked(sb.auth.signOut()); if (current()) await route(); });
  action(root, root.querySelector('form'), async () => {
    const data = formData(root.querySelector('form'));
    await adminAction('create_session', null, data);
    if (current()) location.hash = link('manage', data.slug);
  }, 'submit');
}
function sharingPanel(slug, opened) {
  const url = new URL(location.href);
  url.search = ''; url.hash = link('vote', slug);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  return `<section class="card stack participant-sharing"><h2>${tr('Katılımcı QR Kodu', 'Participant QR Code')}</h2><p>${tr('Katılımcılar giriş yapmadan oy verebilir.', 'Participants can vote without signing in.')}</p>${!opened ? `<p>${tr('Oylama kapalı. Katılımcılar oy verebilmek için açılmasını beklemelidir.', 'Voting is closed. Open it before participants can submit.')}</p>` : ''}<div id="participant-qr" class="qr" role="img" aria-label="${tr('Oylama bağlantısı QR kodu', 'Voting link QR code')}"></div><label>${tr('Katılımcı bağlantısı', 'Participant link')}<input id="participant-link" readonly value="${esc(url.href)}"></label><div class="nav"><button class="btn" id="copy-link">${tr('Bağlantıyı Kopyala', 'Copy link')}</button><a class="btn" href="${esc(url.href)}" target="_blank" rel="noopener">${tr('Oylamayı Aç', 'Open voting page')}</a></div><p id="copy-status" role="status"></p>${local ? `<p class="share-warning">${tr('Bu bağlantı yalnızca bu bilgisayarda çalışır. Telefondan QR ile katılım için erişilebilir bir HTTPS site adresi gerekir.', 'This link works only on this computer. Joining by phone requires a reachable HTTPS site address.')}</p>` : ''}</section>`;
}
function setupSharing(root) {
  const input = root.querySelector('#participant-link');
  root.querySelector('#copy-link').onclick = async () => {
    try {
      await navigator.clipboard.writeText(input.value);
      if (root.isConnected) root.querySelector('#copy-status').textContent = tr('Bağlantı kopyalandı.', 'Link copied.');
    } catch {
      if (!root.isConnected) return;
      input.focus(); input.select();
      root.querySelector('#copy-status').textContent = tr('Bağlantı seçildi. Kopyalamak için Ctrl+C veya ⌘C kullanın.', 'Link selected. Press Ctrl+C or ⌘C to copy.');
    }
  };
  try {
    const qr = window.qrcode(0, 'M');
    qr.addData(input.value); qr.make();
    root.querySelector('#participant-qr').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 16, scalable: true });
  } catch {
    const box = root.querySelector('#participant-qr');
    box.removeAttribute('role'); box.removeAttribute('aria-label');
    box.textContent = tr('QR yüklenemedi. Yukarıdaki bağlantıyı kullanın.', 'QR could not load. Use the link above.');
  }
}
async function manage(slug, current) {
  if (!await requireAdmin()) { if (current()) login(current); return; }
  const { session, groups, dimensions, results } = await sessionData(slug, true);
  if (!current()) return;
  const locked = results.response_count > 0 || session.is_open;
  const config = (type, items, label) => `<section class="card stack"><h2>${label}</h2><div class="admin-list">${items.map(item => `<div class="item"><div><b>${esc(name(item))}</b><div class="muted">${esc(description(item))}</div></div><button class="btn danger" data-delete="${type}" data-id="${item.id}" ${locked ? 'disabled' : ''} aria-label="${esc(tr('Sil: ', 'Delete: ') + name(item))}">×</button></div>`).join('')}</div><form data-add="${type}"><fieldset ${locked ? 'disabled' : ''}>${fields('name', true)}<button class="btn primary" type="submit">${tr('Ekle', 'Add')}</button></fieldset></form></section>`;
  const root = layout(`<div class="stack"><section class="card stack"><h1>${esc(title(session))}</h1><p>${esc(description(session))}</p><div>${results.response_count} ${tr('yanıt', 'responses')} · ${session.is_open ? tr('Oylama açık', 'Voting open') : tr('Oylama kapalı', 'Voting closed')}</div><nav class="nav"><a class="btn" href="${link('vote', slug)}">${tr('Oylama', 'Vote')}</a><a class="btn" href="${link('results', slug)}">${tr('Sonuçlar', 'Results')}</a><button class="btn primary" id="toggle">${session.is_open ? tr('Oylamayı Kapat', 'Close Voting') : tr('Oylamayı Aç', 'Open Voting')}</button><button class="btn danger" id="wipe">${tr('Tüm Yanıtları Sil', 'Delete All Responses')}</button><button class="btn danger" id="delete-session">${tr('Oturumu Sil', 'Delete Session')}</button></nav>${locked ? `<p class="muted">${results.response_count ? tr('Yapılandırma kilitli. Değiştirmek için önce tüm yanıtları silin.', 'Configuration is locked. Delete all responses before making changes.') : tr('Yapılandırmayı değiştirmek için oylamayı kapatın.', 'Close voting to change the configuration.')}</p>` : ''}</section><section class="card stack"><div class="nav"><button class="btn" id="export-csv">${tr('CSV İndir', 'Export CSV')}</button><button class="btn" id="export-json">${tr('JSON Arşivi İndir', 'Export JSON')}</button></div><p class="muted">${tr('Dışa aktarımlar yalnızca yönetici içindir; bireysel yanıtları içerir.', 'Admin-only exports include individual responses.')}</p><details><summary>${tr('Oturumu Çoğalt', 'Duplicate Session')}</summary><form id="duplicate-form" class="stack"><p class="muted">${tr('İçerik, gruplar ve boyutlar kopyalanır. Yanıtlar kopyalanmaz; yeni oturum kapalı başlar.', 'Copies content, groups and dimensions, never responses. The new session starts closed.')}</p><label>${tr('Yeni kısa ad', 'New slug')}<input name="slug" required pattern="[a-z0-9]+(-[a-z0-9]+)*" placeholder="${esc(slug)}-copy" aria-describedby="duplicate-help"></label><small id="duplicate-help" class="muted">${tr('a–z, 0–9 ve kelimeler arasında tek tire. Boşluk kullanmayın.', 'Use a–z, 0–9 and single hyphens between words. No spaces.')}</small><button class="btn primary" type="submit">${tr('Kopyayı Oluştur', 'Create Copy')}</button></form></details></section>${sharingPanel(slug, session.is_open)}<div class="grid2">${config('group', groups, tr('Gruplar', 'Groups'))}${config('dimension', dimensions, tr('Başarı Boyutları', 'Success Dimensions'))}</div></div>`);
  setupSharing(root);
  action(root, root.querySelector('#duplicate-form'), async () => {
    const data = formData(root.querySelector('#duplicate-form'));
    await checked(sb.rpc('duplicate_session', { p_session_id: session.id, p_slug: data.slug }));
    if (current()) location.hash = link('manage', data.slug);
  }, 'submit');
  for (const format of ['csv', 'json']) action(root, root.querySelector(`#export-${format}`), async () => {
    const archive = await checked(sb.rpc('export_session', { p_session_id: session.id }));
    if (!current()) return;
    const safeSlug = session.slug.replace(/[^a-zA-Z0-9-]/g, '_');
    downloadFile(format === 'csv' ? responsesCsv(archive) : JSON.stringify(archive, null, 2), `${safeSlug}.${format}`, format === 'csv' ? 'text/csv;charset=utf-8' : 'application/json');
  });
  const mutate = async (op, payload) => { await adminAction(op, session.id, payload); if (current()) await route(); };
  action(root, root.querySelector('#toggle'), () => mutate(session.is_open ? 'close' : 'open'));
  action(root, root.querySelector('#wipe'), async () => {
    if (confirm(tr('Tüm yanıtlar kalıcı olarak silinecek ve oylama kapanacak. Devam edilsin mi?', 'Permanently delete all responses and close voting?'))) await mutate('delete_responses');
  });
  action(root, root.querySelector('#delete-session'), async () => {
    if (!confirm(tr('Oturum, tüm gruplar, boyutlar ve yanıtlar kalıcı olarak silinsin mi?', 'Permanently delete this session, all groups, dimensions, and responses?'))) return;
    await adminAction('delete_session', session.id);
    if (current()) location.hash = '#admin';
  });
  root.querySelectorAll('[data-add]').forEach(form => action(root, form, () => mutate(`add_${form.dataset.add}`, formData(form)), 'submit'));
  root.querySelectorAll('[data-delete]').forEach(button => action(root, button, async () => {
    if (confirm(tr('Bu öğe silinsin mi?', 'Delete this item?'))) await mutate(`delete_${button.dataset.delete}`, { id: button.dataset.id });
  }));
}
async function results(slug, current) {
  if (!await requireAdmin()) { if (current()) login(current); return; }
  let snapshot = await sessionData(slug, true);
  if (!current()) return;
  if (!window.echarts) throw Error('DSS_DEPENDENCY');
  const visible = { categories: false, groups: false, values: false, axis: false };
  const identities = identityMap(), dimensionAliases = new Map();
  let blur = 100, frozen = false, presenting = false;
  const root = layout(`<section class="results-dashboard"><header class="results-header"><div><span class="eyebrow">${tr('FARKLI BAKIŞLAR · ORTAK BAŞARI', 'DIFFERENT PERSPECTIVES · SHARED SUCCESS')}</span><h1 id="results-title">${esc(title(snapshot.session))}</h1><p class="muted">${tr('Her başarı boyutunda disiplinlerin önceliklerini karşılaştırın.', 'Compare disciplines within each success dimension.')}</p></div><div class="response-stat"><strong id="count">${snapshot.results.response_count}</strong><span>${tr('yanıt', 'responses')}</span><span id="live-status" class="live-status" role="status">${tr('Canlı', 'Live')}</span></div></header><div class="presenter-bar"><span class="muted" id="session-state"></span><div class="nav"><button class="btn" id="freeze" aria-pressed="false">${tr('Sonuçları Dondur', 'Freeze Results')}</button><button class="btn" id="presenter" aria-pressed="false">${tr('Sunucu Modu', 'Presenter Mode')}</button></div></div><div class="chart-stage"><div id="group-participation" class="group-participation" role="list" aria-label="${tr('Gruplara göre katılım', 'Participation by group')}"></div><div class="chart-scroll"><div id="chart" class="chart presentation-chart" role="img" aria-label="${tr('Başarı boyutlarına göre grup ortalamaları', 'Group averages by success dimension')}"></div></div><div id="veil-label" class="veil-label">${tr('Her bakış açısı bir hikâye anlatır.', 'Every perspective tells a story.')}<small>${tr('Hazır olduğunuzda sonuçları açın.', 'Reveal the results when you are ready.')}</small></div><p id="empty-results" class="empty-results" hidden>${tr('Henüz yanıt yok. İlk oy geldiğinde grafik otomatik güncellenecek.', 'No responses yet. The chart will update when the first vote arrives.')}</p><div class="chart-vote-count" id="chart-vote-count" role="status" aria-live="polite" aria-atomic="true"></div></div><details class="presenter-controls" open><summary>${tr('Sunum kontrolleri', 'Presentation controls')}</summary><div class="control-body"><label class="blur-control">${tr('Bulanıklık', 'Blur')} <output id="blur-value">100</output>%<input id="blur" type="range" min="0" max="100" value="100"></label><div class="reveal">${[['categories', 'Boyut Adları', 'Dimension Names'], ['groups', 'Grup Kimlikleri', 'Group Identities'], ['values', 'Kesin Değerler', 'Exact Values'], ['axis', 'Y Ekseni', 'Y Axis']].map(([key, a, b]) => `<button class="btn" data-reveal="${key}" aria-pressed="false">${tr(a, b)}</button>`).join('')}</div><div class="nav preset-controls"><button class="btn" id="fully-blur">${tr('Tam Bulanıklaştır', 'Fully Blur')}</button><button class="btn primary" id="fully-reveal">${tr('Tümünü Göster', 'Fully Reveal')}</button><button class="btn" id="reset-reveal">${tr('Gösterimi Sıfırla', 'Reset Reveal')}</button></div></div></details><p id="presentation-note" class="presentation-note">${tr('Otomatik güncelleme · 3 saniye', 'Automatic updates · every 3 seconds')}</p></section>`);
  root.classList.add('results-root');
  document.body.classList.add('results-view');
  const chartElement = root.querySelector('#chart');
  chart = window.echarts.init(chartElement);
  const ownChart = chart;
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  const applyBlur = () => {
    chartElement.style.filter = `blur(${blur * 0.32}px)`;
    chartElement.style.opacity = String(1 - blur / 100);
    chartElement.style.pointerEvents = blur > 0 ? 'none' : '';
    chartElement.setAttribute('aria-hidden', String(blur > 0));
    root.querySelector('#veil-label').hidden = blur < 100;
    root.querySelector('#blur-value').textContent = blur;
    root.querySelector('#blur').value = blur;
    if (blur > 0) ownChart.dispatchAction?.({ type: 'hideTip' });
  };
  const draw = (concealing = false) => {
    root.querySelector('#group-participation').innerHTML = groupParticipation(snapshot, identities, visible.groups, lang)
      .map(group => `<div class="group-participation-card" role="listitem"><span>${esc(group.label)}</span><div><strong>${group.count}</strong> <small>${tr('oy', 'votes')}</small></div></div>`).join('');
    const option = chartOption(snapshot, visible, identities, dimensionAliases, lang, reducedMotion, { width: chartElement.clientWidth, height: chartElement.clientHeight });
    // Remove old labels/tooltips immediately when concealing; animate reveals and live data.
    ownChart.dispatchAction?.({ type: 'hideTip' });
    if (concealing) ownChart.clear?.();
    chartElement.style.minWidth = `${Math.max(480, snapshot.dimensions.length * Math.max(160, snapshot.groups.length * 38))}px`;
    ownChart.resize();
    ownChart.setOption(option, { replaceMerge: ['series'] });
    root.querySelector('#count').textContent = snapshot.results.response_count;
    root.querySelector('#chart-vote-count').textContent = tr(`${snapshot.results.response_count} kişi oy kullandı`, `${snapshot.results.response_count} ${snapshot.results.response_count === 1 ? 'participant has' : 'participants have'} voted`);
    root.querySelector('#results-title').textContent = title(snapshot.session);
    root.querySelector('#session-state').textContent = snapshot.session.is_open ? tr('Oylama açık', 'Voting open') : tr('Oylama kapalı', 'Voting closed');
    root.querySelector('#empty-results').hidden = snapshot.results.response_count !== 0;
    root.querySelectorAll('[data-reveal]').forEach(button => {
      button.classList.toggle('primary', visible[button.dataset.reveal]);
      button.setAttribute('aria-pressed', String(visible[button.dataset.reveal]));
    });
    applyBlur();
  };
  draw();
  const feed = liveFeed({
    load: () => sessionData(slug, true),
    apply: fresh => { if (current()) { snapshot = fresh; draw(); } },
    status: (state, error) => {
      if (!current()) return;
      if (error && (['42501', 'PGRST301', 'PGRST302'].includes(error.code) || /DSS_FORBIDDEN|DSS_NOT_FOUND/.test(error.message || ''))) { void route(); return; }
      const messages = { live: tr('Canlı', 'Live'), frozen: tr('Donduruldu', 'Frozen'), syncing: tr('Güncelleniyor…', 'Updating…'), error: tr('Bağlantı kesildi · tekrar deneniyor', 'Disconnected · retrying') };
      root.querySelector('#live-status').textContent = error?.message?.includes('DSS_NOT_FOUND') ? tr('Oturum silindi', 'Session deleted') : messages[state];
      root.querySelector('#live-status').dataset.state = state;
    }
  });
  root.querySelector('#freeze').onclick = () => {
    frozen = !frozen; feed.freeze(frozen);
    root.querySelector('#freeze').textContent = frozen ? tr('Dondurmayı Kaldır', 'Unfreeze Results') : tr('Sonuçları Dondur', 'Freeze Results');
    root.querySelector('#freeze').setAttribute('aria-pressed', String(frozen));
    root.querySelector('#freeze').classList.toggle('primary', frozen);
  };
  root.querySelector('#blur').oninput = e => { blur = Number(e.target.value); applyBlur(); };
  root.querySelectorAll('[data-reveal]').forEach(button => button.onclick = () => {
    const key = button.dataset.reveal; visible[key] = !visible[key]; draw(!visible[key]);
  });
  root.querySelector('#fully-blur').onclick = () => { blur = 100; applyBlur(); };
  root.querySelector('#fully-reveal').onclick = () => { Object.keys(visible).forEach(key => visible[key] = true); blur = 0; draw(); };
  root.querySelector('#reset-reveal').onclick = () => { Object.keys(visible).forEach(key => visible[key] = false); blur = 100; draw(true); };
  const setPresenter = value => {
    presenting = value;
    document.body.classList.toggle('presenting', presenting);
    root.classList.toggle('presenting-root', presenting);
    root.querySelector('#presenter').textContent = presenting ? tr('Sunumdan Çık · Esc', 'Exit Presenter · Esc') : tr('Sunucu Modu', 'Presenter Mode');
    root.querySelector('#presenter').setAttribute('aria-pressed', String(presenting));
    root.querySelector('.presenter-controls').open = !presenting;
    ownChart.resize();
  };
  const exitPresenter = async () => {
    setPresenter(false);
    if (document.fullscreenElement === root) { try { await document.exitFullscreen(); } catch { /* The visible exit remains available. */ } }
  };
  root.querySelector('#presenter').onclick = async () => {
    if (presenting) return exitPresenter();
    setPresenter(true);
    try { await root.requestFullscreen?.(); } catch { /* Keep projection layout when fullscreen is unsupported or denied. */ }
    if (!current()) { if (document.fullscreenElement === root) await document.exitFullscreen().catch(() => {}); return; }
    ownChart.resize();
  };
  const onFullscreen = () => { if (presenting && !document.fullscreenElement) setPresenter(false); ownChart.resize(); };
  const onKey = e => { if (e.key === 'Escape' && presenting) void exitPresenter(); };
  const onVisibility = () => { if (!document.hidden && !frozen) void feed.refresh(); };
  document.addEventListener('fullscreenchange', onFullscreen);
  document.addEventListener('keydown', onKey);
  document.addEventListener('visibilitychange', onVisibility);
  const onResize = () => { if (current()) draw(); };
  const observer = window.ResizeObserver ? new ResizeObserver(onResize) : null;
  window.addEventListener('resize', onResize);
  observer?.observe(chartElement);
  routeCleanup = () => {
    feed.stop(); observer?.disconnect();
    window.removeEventListener('resize', onResize);
    document.removeEventListener('fullscreenchange', onFullscreen);
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('visibilitychange', onVisibility);
    document.body.classList.remove('presenting', 'results-view');
    if (document.fullscreenElement === root) document.exitFullscreen().catch(() => {});
  };
}
async function route() {
  const version = ++revision, current = () => version === revision;
  routeCleanup(); routeCleanup = () => {};
  chart?.dispose(); chart = null;
  layout(`<p role="status">${tr('Yükleniyor…', 'Loading…')}</p>`);
  try {
    if (!sb) throw Error('DSS_DEPENDENCY');
    const { page, slug } = routeInfo();
    if (page === 'home') await home(current);
    else if (page === 'admin') await admin(current);
    else if (page === 'manage') await manage(slug, current);
    else if (page === 'vote') await vote(slug, current);
    else if (page === 'results') await results(slug, current);
    else throw Error('DSS_NOT_FOUND');
  } catch (error) {
    if (!current()) return;
    const root = layout(`<section class="card"><button class="btn" id="retry">${tr('Tekrar Dene', 'Retry')}</button>${['admin', 'manage', 'results'].includes(routeInfo().page) && error.message?.includes('DSS_FORBIDDEN') ? `<button class="btn" id="signout">${tr('Çıkış', 'Sign out')}</button>` : ''}</section>`);
    showError(root, error);
    root.querySelector('#retry').onclick = route;
    if (root.querySelector('#signout')) action(root, root.querySelector('#signout'), async () => { await checked(sb.auth.signOut()); if (current()) await route(); });
  }
}
try { sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY); } catch { /* Render a useful dependency error below. */ }
window.addEventListener('hashchange', route);
window.addEventListener('resize', () => chart?.resize());
sb?.auth.onAuthStateChange(event => {
  if (event === 'SIGNED_OUT' && ['admin', 'manage', 'results'].includes(routeInfo().page)) {
    ++revision; routeCleanup(); routeCleanup = () => {}; chart?.dispose(); chart = null;
    layout(`<p role="status">${tr('Oturum kapatıldı.', 'Signed out.')}</p>`);
    setTimeout(route, 0);
  }
});
route();
