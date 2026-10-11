'use strict';
const $ = id => document.getElementById(id);
const token = document.querySelector('meta[name="reader-token"]').content;
const state = { scope: document.querySelector('meta[name="reader-scope"]').content, work: document.querySelector('meta[name="reader-work"]').content,
  book: null, chapter: null, feedback: [], selection: null, epoch: 0, font: 20, leading: 1.95, notes: new Map() };
const statusLabels = { accepted: '已接纳', stale: '需要重审', draft: '草稿' };
function message(text = '', kind = 'error') { $('message').textContent = text; $('message').dataset.state = kind; $('message').hidden = !text; }
function safely(action) { return async (...args) => { try { await action(...args); } catch (error) { message(error.message); } }; }
async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'X-Reader-Token': token, ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '读取失败，请刷新阅读器。');
  return result;
}
const node = (tag, text, className) => { const element = document.createElement(tag); if (text !== undefined) element.textContent = text; if (className) element.className = className; return element; };
function localGet(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } }
function localSet(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* reading works even with disabled browser storage */ } }
function settingKey() { return `specwriter:${state.book?.bookId ?? 'reader'}:settings`; }
function positionKey() { return `specwriter:${state.book.bookId}:${state.scope}:${state.work}:position`; }
function applySettings() {
  document.documentElement.style.setProperty('--prose-size', `${state.font}px`);
  document.documentElement.style.setProperty('--prose-leading', state.leading);
  $('font-down').disabled = state.font <= 16; $('font-up').disabled = state.font >= 28;
  localSet(settingKey(), { font: state.font, leading: state.leading, theme: document.documentElement.dataset.theme || 'light' });
}
function clearQuote() { state.selection = null; $('quote').textContent = '整章意见'; $('clear-quote').hidden = true; }
function renderProse(target, body, selectable = false) {
  target.replaceChildren();
  for (const match of body.matchAll(/[^\r\n]+(?:\r?\n(?![ \t]*\r?\n)[^\r\n]+)*/g)) {
    if (!match[0].trim()) continue;
    let text = match[0]; let start = match.index;
    const heading = /^(#{1,6})\s+/.exec(text);
    if (selectable && heading?.[1] === '#' && !body.slice(0, match.index).trim()) continue;
    if (heading) { text = text.slice(heading[0].length); start += heading[0].length; }
    const element = node(heading ? 'h3' : 'p', text);
    if (selectable) element.dataset.start = start;
    target.append(element);
  }
}
function captureSelection() {
  if (!state.chapter) return;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return;
  const range = selection.getRangeAt(0);
  const prose = $('prose');
  if (!prose.contains(range.startContainer) || !prose.contains(range.endContainer)) return;
  const offset = (container, position) => {
    const element = (container.nodeType === Node.ELEMENT_NODE ? container : container.parentElement).closest('[data-start]');
    if (!element || !prose.contains(element)) return null;
    const prefix = document.createRange(); prefix.selectNodeContents(element); prefix.setEnd(container, position);
    return Number(element.dataset.start) + prefix.toString().length;
  };
  const start = offset(range.startContainer, range.startOffset), end = offset(range.endContainer, range.endOffset);
  if (start === null || end === null || end <= start) return;
  const quote = state.chapter.body.slice(start, end);
  state.selection = { start, end, quote, chapterKey: state.chapter.key, bodyHash: state.chapter.bodyHash };
  $('quote').textContent = quote; $('clear-quote').hidden = false;
}
function savePosition() {
  if (!state.book || !state.chapter) return;
  const rect = $('reading').getBoundingClientRect();
  const start = window.scrollY + rect.top;
  const travel = Math.max(1, $('reading').offsetHeight - window.innerHeight);
  const ratio = Math.min(1, Math.max(0, (window.scrollY - start) / travel));
  localSet(positionKey(), { key: state.chapter.key, ratio });
  $('progress').textContent = `${Math.round(ratio * 100)}%`;
}
function renderCatalog() {
  const chapters = state.book.chapters;
  $('chapter-list').replaceChildren(); $('chapter-picker').replaceChildren();
  for (const chapter of chapters) {
    const label = `第 ${chapter.chapter} 章　${chapter.title}`;
    const button = node('button', label, 'chapter-link'); button.type = 'button'; button.title = `${label} · ${statusLabels[chapter.status]}`;
    button.dataset.key = chapter.key; button.addEventListener('click', safely(() => openChapter(chapter.key)));
    if (chapter.status === 'stale') button.textContent += ' · 待重审';
    if (state.chapter?.key === chapter.key) button.setAttribute('aria-current', 'page');
    $('chapter-list').append(button);
    const option = node('option', `${label}${chapter.status === 'stale' ? ' · 待重审' : ''}`); option.value = chapter.key; $('chapter-picker').append(option);
  }
  if (state.chapter) $('chapter-picker').value = state.chapter.key;
}
async function loadBook(preferred, restore = false) {
  const epoch = ++state.epoch;
  const query = new URLSearchParams({ scope: state.scope, work: state.work });
  const book = await api(`/api/book?${query}`);
  if (epoch !== state.epoch) return;
  state.book = book;
  const settings = localGet(settingKey(), {});
  state.font = Math.max(16, Math.min(28, Number(settings.font) || 20));
  state.leading = settings.leading === 2.35 ? 2.35 : 1.95;
  document.documentElement.dataset.theme = settings.theme === 'dark' ? 'dark' : 'light';
  $('theme').textContent = settings.theme === 'dark' ? '日间' : '夜间'; $('theme').setAttribute('aria-pressed', String(settings.theme === 'dark'));
  applySettings(); document.title = `${book.name} · SpecWriter`;
  $('book-name').textContent = book.name;
  $('book-meta').textContent = `${book.chapters.length} 章 · ${book.characters.toLocaleString()} 字${state.scope === 'draft' ? ' · 草稿' : ''}`;
  $('accepted-mode').setAttribute('aria-pressed', String(state.scope === 'accepted'));
  $('draft-mode').setAttribute('aria-pressed', String(state.scope === 'draft'));
  $('draft-mode').disabled = !book.works.length; $('draft-mode').title = book.works.length ? '预览工作包草稿' : '先在 Codex 中创建工作包并写作';
  $('work-field').hidden = state.scope !== 'draft'; $('work').replaceChildren();
  for (const work of book.works) { const option = node('option', `${work.title}${work.status === 'archived' ? '（已归档）' : ''}`); option.value = work.id; $('work').append(option); }
  $('work').value = state.work || book.works[0]?.id || '';
  renderCatalog();
  const position = localGet(positionKey(), {});
  const key = preferred && book.chapters.some(item => item.key === preferred) ? preferred : restore && book.chapters.some(item => item.key === position.key) ? position.key : book.chapters.find(item => item.status !== 'stale')?.key ?? book.chapters[0]?.key;
  if (key) await openChapter(key, restore && key === position.key ? position.ratio : 0, epoch);
  else {
    state.chapter = null; clearQuote(); $('chapter-title').textContent = state.scope === 'draft' ? '还没有草稿' : '故事，从这里开始';
    $('chapter-meta').textContent = ''; $('chapter-state').textContent = ''; $('chapter-warning').hidden = true;
    $('prose').replaceChildren(node('p', state.scope === 'draft' ? '在 Codex 中使用 $specwriter-write 完成章节草稿，再刷新阅读器。' : '在 Codex 中写好并接纳第一章，它会出现在这里。可以切换“草稿预览”阅读尚未接纳的正文。', 'quiet'));
    $('prose').setAttribute('aria-busy', 'false'); $('feedback-list').replaceChildren();
    for (const id of ['save-note', 'copy-request', 'compare-open', 'previous', 'next', 'chapter-picker']) $(id).disabled = true;
  }
  $('export-open').disabled = !book.trustedThrough; $('export-open').title = book.trustedThrough ? '导出正式正文' : '先接纳至少一章正文';
}
async function openChapter(key, ratio = 0, existingEpoch) {
  if (state.chapter) state.notes.set(state.chapter.key, $('note').value);
  const epoch = existingEpoch ?? ++state.epoch;
  $('prose').setAttribute('aria-busy', 'true');
  const chapter = await api(`/api/chapter?key=${encodeURIComponent(key)}`);
  if (epoch !== state.epoch) return;
  state.chapter = chapter; clearQuote(); $('note').value = state.notes.get(key) || '';
  $('chapter-title').textContent = chapter.title;
  $('chapter-state').textContent = `第 ${chapter.chapter} 章 · ${statusLabels[chapter.status]}`;
  $('chapter-meta').textContent = `${chapter.characters.toLocaleString()} 字${chapter.revision ? ` · 版本 ${chapter.revision}` : ''}`;
  $('chapter-warning').hidden = chapter.status === 'accepted';
  $('chapter-warning').textContent = chapter.status === 'stale' ? '前文已有修订，本章需要重新核对。正式导出暂不包含本章。' : '这是尚未接纳的草稿。阅读和批注不会提交正文或记忆。';
  renderProse($('prose'), chapter.body, true); $('prose').setAttribute('aria-busy', 'false');
  for (const id of ['save-note', 'copy-request', 'compare-open', 'chapter-picker']) $(id).disabled = false;
  $('note').setAttribute('aria-invalid', 'false'); $('feedback-status').textContent = '批注会绑定当前正文版本。';
  const index = state.book.chapters.findIndex(item => item.key === key);
  $('previous').disabled = index <= 0; $('next').disabled = index < 0 || index >= state.book.chapters.length - 1;
  renderCatalog();
  const top = Math.max(0, window.scrollY + $('reading').getBoundingClientRect().top - document.querySelector('.topbar').offsetHeight);
  const travel = Math.max(0, $('reading').offsetHeight - window.innerHeight);
  window.scrollTo({ top: epoch === 1 && !ratio ? 0 : top + travel * Math.min(1, Math.max(0, Number(ratio) || 0)), behavior: 'instant' });
  savePosition(); await loadFeedback(key);
}
async function loadFeedback(key) {
  const items = await api(`/api/feedback?key=${encodeURIComponent(key)}`);
  if (state.chapter?.key !== key) return;
  state.feedback = items; $('feedback-list').replaceChildren();
  if (!items.length) $('feedback-list').append(node('p', '还没有批注。可以先记下读到这里的感受。', 'quiet'));
  for (const item of items) {
    const entry = node('section', undefined, `note${item.status === 'resolved' ? ' resolved' : ''}`);
    entry.append(node('p', `${item.status === 'resolved' ? '已处理' : '待处理'}${item.outdated ? ' · 旧版本，需重新定位' : ''}`, 'quiet'));
    if (item.quote) entry.append(node('blockquote', item.quote));
    entry.append(node('p', item.note));
    const button = node('button', item.status === 'resolved' ? '重新打开' : '标记已处理'); button.type = 'button';
    button.addEventListener('click', safely(async () => {
      button.disabled = true;
      try { await api('/api/feedback/resolve', { method: 'POST', body: JSON.stringify({ id: item.id, resolved: item.status !== 'resolved' }) }); await loadFeedback(key); }
      finally { button.disabled = false; }
    })); entry.append(button); $('feedback-list').append(entry);
  }
}
$('feedback-form').addEventListener('submit', safely(async event => {
  event.preventDefault(); if (!state.chapter) return;
  const chapter = state.chapter, note = $('note').value;
  const quote = state.selection || { start: 0, end: 0, quote: '', chapterKey: chapter.key, bodyHash: chapter.bodyHash };
  const save = $('save-note'); save.disabled = true; save.textContent = '正在保存…'; save.setAttribute('aria-busy', 'true');
  try {
    await api('/api/feedback', { method: 'POST', body: JSON.stringify({ ...quote, note }) });
    state.notes.delete(chapter.key);
    if (state.chapter?.key === chapter.key) { $('note').value = ''; clearQuote(); $('feedback-status').textContent = '已保存，Codex 可以读取这条批注。'; await loadFeedback(chapter.key); }
  } catch (error) { $('note').setAttribute('aria-invalid', 'true'); $('feedback-status').textContent = error.message; }
  finally { save.disabled = !state.chapter; save.textContent = '保存批注'; save.setAttribute('aria-busy', 'false'); }
}));
document.addEventListener('selectionchange', captureSelection);
$('clear-quote').addEventListener('click', clearQuote);
$('note').addEventListener('input', () => $('note').setAttribute('aria-invalid', 'false'));
$('refresh').addEventListener('click', safely(async () => { message(); savePosition(); await loadBook(state.chapter?.key, true); }));
$('chapter-picker').addEventListener('change', safely(() => openChapter($('chapter-picker').value)));
$('accepted-mode').addEventListener('click', safely(async () => { state.scope = 'accepted'; await loadBook(); }));
$('draft-mode').addEventListener('click', safely(async () => { state.scope = 'draft'; state.work = $('work').value; await loadBook(); }));
$('work').addEventListener('change', safely(async () => { state.work = $('work').value; await loadBook(); }));
for (const [id, step] of [['previous', -1], ['next', 1]]) $(id).addEventListener('click', safely(() => {
  const index = state.book.chapters.findIndex(item => item.key === state.chapter?.key);
  const chapter = state.book.chapters[index + step]; if (chapter) return openChapter(chapter.key);
}));
$('font-down').addEventListener('click', () => { state.font = Math.max(16, state.font - 2); applySettings(); });
$('font-up').addEventListener('click', () => { state.font = Math.min(28, state.font + 2); applySettings(); });
$('line-height').addEventListener('click', () => { state.leading = state.leading === 1.95 ? 2.35 : 1.95; applySettings(); });
$('theme').addEventListener('click', () => {
  const dark = document.documentElement.dataset.theme !== 'dark'; document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $('theme').textContent = dark ? '日间' : '夜间'; $('theme').setAttribute('aria-pressed', String(dark)); applySettings();
});
$('export-open').addEventListener('click', () => $('export-dialog').showModal());
$('annotation-open').addEventListener('click', () => { $('annotation-panel').scrollIntoView({ behavior: 'instant', block: 'start' }); $('note').focus({ preventScroll: true }); });
for (const element of document.querySelectorAll('[data-close]')) element.addEventListener('click', () => $(element.dataset.close).close());
for (const dialog of document.querySelectorAll('dialog')) dialog.addEventListener('click', event => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close(); } });
for (const button of document.querySelectorAll('[data-export]')) button.addEventListener('click', safely(async () => {
  button.disabled = true;
  try {
    await api('/api/export', { method: 'POST', body: JSON.stringify({ format: button.dataset.export }) });
    $('export-dialog').close(); message(`已保存到小说目录的 exports/novel.${button.dataset.export}。`, 'success');
    const response = await fetch(`/api/export?format=${button.dataset.export}`, { headers: { 'X-Reader-Token': token } });
    if (!response.ok) throw new Error((await response.json()).error);
    const url = URL.createObjectURL(await response.blob()), link = node('a'); link.href = url; link.download = `novel.${button.dataset.export}`;
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000); $('export-dialog').close();
  } finally { button.disabled = false; }
}));
$('copy-request').addEventListener('click', safely(async () => {
  if (!state.chapter) return;
  const result = await api(`/api/request?key=${encodeURIComponent(state.chapter.key)}`);
  try { await navigator.clipboard.writeText(result.text); $('feedback-status').textContent = '已复制，粘贴到 Codex 即可安排修订。'; }
  catch { $('request-text').value = result.text; $('request-dialog').showModal(); $('request-text').select(); }
}));
async function compareVersion() {
  const chapter = state.chapter;
  if (!chapter || !$('version-picker').value) return;
  const previous = await api(`/api/version?chapter=${chapter.chapter}&revision=${$('version-picker').value}`);
  if (chapter.key !== state.chapter?.key) return;
  renderProse($('old-prose'), previous.body); renderProse($('new-prose'), chapter.body);
  $('compare-summary').textContent = previous.bodyHash === chapter.bodyHash ? '两个版本的正文相同。' : '左右分别显示完整正文，可对照阅读修改内容。';
}
$('compare-open').addEventListener('click', safely(async () => {
  const chapter = state.chapter; if (!chapter) return;
  const versions = await api(`/api/versions?chapter=${chapter.chapter}`);
  if (chapter.key !== state.chapter?.key) return;
  $('version-picker').replaceChildren(); $('old-prose').replaceChildren(); $('new-prose').replaceChildren();
  renderProse($('new-prose'), chapter.body);
  for (const version of versions.toReversed()) { const option = node('option', `版本 ${version.id} · ${new Date(version.acceptedAt).toLocaleString()}`); option.value = version.id; $('version-picker').append(option); }
  $('version-picker').disabled = !versions.length;
  if (!versions.length) $('compare-summary').textContent = '这一章还没有已接纳版本。';
  else { if (chapter.status === 'accepted' && versions.length > 1) $('version-picker').value = versions.at(-2).id; await compareVersion(); }
  $('compare-dialog').showModal();
}));
$('version-picker').addEventListener('change', safely(compareVersion));
let scrolling;
window.addEventListener('scroll', () => { clearTimeout(scrolling); scrolling = setTimeout(savePosition, 150); }, { passive: true });
window.addEventListener('pagehide', savePosition);
safely(() => loadBook(undefined, true))();
