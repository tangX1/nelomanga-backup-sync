// ==UserScript==
// @name         Nelomanga Backup Sync
// @namespace    nelomanga-backup-sync
// @version      1.0
// @description  Upload Futon/Tachiyomi backup → sync bookmarks + reading progress to nelomanga.net
// @match        https://nelomanga.net/*
// @match        https://www.nelomanga.net/*
// @require      https://cdnjs.cloudflare.com/ajax/libs/pako/2.1.0/pako.min.js
// @require      https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ═══════════════════════════════════════════
  //  PROTOBUF DECODER (minimal, for .tachibk)
  // ═══════════════════════════════════════════

  function readVarint(buf, pos) {
    let val = 0, shift = 0;
    for (let i = 0; i < 10; i++) {
      if (pos >= buf.length) return null;
      const b = buf[pos++];
      val += (b & 0x7f) * (2 ** shift);
      if (!(b & 0x80)) return { v: val, p: pos };
      shift += 7;
    }
    return null;
  }

  function decodeProto(buf) {
    const fields = {};
    let pos = 0;
    while (pos < buf.length) {
      const tag = readVarint(buf, pos);
      if (!tag) break;
      pos = tag.p;
      const num = tag.v >>> 3;
      const wire = tag.v & 7;
      let val;
      if (wire === 0) {
        const v = readVarint(buf, pos);
        if (!v) break;
        val = v.v; pos = v.p;
      } else if (wire === 2) {
        const len = readVarint(buf, pos);
        if (!len) break;
        pos = len.p;
        val = buf.slice(pos, pos + len.v);
        pos += len.v;
      } else if (wire === 1) {
        pos += 8; continue;
      } else if (wire === 5) {
        pos += 4; continue;
      } else break;
      if (!fields[num]) fields[num] = [];
      fields[num].push({ w: wire, v: val });
    }
    return fields;
  }

  function pStr(fields, n) {
    const f = fields[n];
    if (!f || f[0].w !== 2) return '';
    try { return new TextDecoder().decode(f[0].v); } catch { return ''; }
  }

  // ═══════════════════════════════════════════
  //  FILE PARSERS
  // ═══════════════════════════════════════════

  function slugFromUrl(url) {
    const m = url.match(/\/manga\/([^/?#]+)/);
    return m ? m[1].replace(/\/$/, '') : null;
  }

  function parseTachibk(arrayBuf) {
    const data = pako.inflate(new Uint8Array(arrayBuf));
    const root = decodeProto(data);
    const list = [];
    const seen = new Set();

    for (const entry of (root[2] || [])) {
      if (entry.w !== 2) continue;
      const m = decodeProto(entry.v);
      const title = pStr(m, 3) || 'Unknown';
      const url = pStr(m, 2);
      const slug = slugFromUrl(url);
      if (!slug || seen.has(slug)) continue;
      seen.add(slug);

      let lastCh = 0;
      for (const ch of (m[100] || [])) {
        if (ch.w !== 2) continue;
        const cf = decodeProto(ch.v);
        const read = cf[11] && cf[11][0].v;
        if (read) {
          const cUrl = pStr(cf, 1);
          const cm = cUrl.match(/chapter[_-](\d+)/i);
          if (cm) lastCh = Math.max(lastCh, parseInt(cm[1]));
        }
      }

      list.push({ title, slug, chapter: lastCh, source: '.tachibk' });
    }
    return list;
  }

  async function parseBkZip(arrayBuf) {
    const zip = await JSZip.loadAsync(arrayBuf);
    const list = [];
    const seen = new Map();

    const histFile = zip.file('history');
    if (histFile) {
      const hist = JSON.parse(await histFile.async('string'));
      for (const e of hist) {
        if (!e.manga || !e.manga.url) continue;
        const slug = slugFromUrl(e.manga.url);
        if (!slug) continue;
        const estCh = Math.max(0, Math.round((e.percent || 0) * (e.chapters || 0)));

        if (seen.has(slug)) {
          const prev = seen.get(slug);
          if (estCh > prev.chapter) prev.chapter = estCh;
          continue;
        }
        const item = { title: e.manga.title || 'Unknown', slug, chapter: estCh, source: '.bk' };
        seen.set(slug, item);
        list.push(item);
      }
    }

    const favFile = zip.file('favourites');
    if (favFile) {
      const favs = JSON.parse(await favFile.async('string'));
      for (const f of favs) {
        const url = f.manga ? f.manga.url : f.url;
        const title = f.manga ? f.manga.title : f.title;
        if (!url) continue;
        const slug = slugFromUrl(url);
        if (!slug || seen.has(slug)) continue;
        seen.set(slug, true);
        list.push({ title: title || 'Unknown', slug, chapter: 0, source: '.bk' });
      }
    }

    return list;
  }

  async function parseFile(file) {
    const buf = await file.arrayBuffer();
    const name = file.name.toLowerCase();
    if (name.endsWith('.tachibk')) return parseTachibk(buf);
    if (name.endsWith('.zip') || name.endsWith('.bk')) return parseBkZip(buf);

    // Try both formats
    try { return parseTachibk(buf); } catch {}
    try { return await parseBkZip(buf); } catch {}
    throw new Error('Unrecognized file format. Expected .tachibk or .bk/.zip');
  }

  // ═══════════════════════════════════════════
  //  NELOMANGA API
  // ═══════════════════════════════════════════

  function getCookie(n) {
    const p = ('; ' + document.cookie).split('; ' + n + '=');
    return p.length === 2 ? p.pop().split(';').shift() : null;
  }

  const wait = ms => new Promise(r => setTimeout(r, ms));

  async function fetchPage(path) {
    const r = await fetch(path, { credentials: 'same-origin' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const t = await r.text();
    if (t.includes('Just a moment') && t.includes('cf_chl_opt'))
      throw new Error('Cloudflare challenge — try refreshing the page first');
    return t;
  }

  function findComicId(html) {
    const m = html.match(/\/action\/bookmark\/(\d+)/) ||
              html.match(/\/api\/manga\/count\/(\d+)/) ||
              html.match(/comic_id\s*[:=]\s*['"]?(\d{3,})/) ||
              html.match(/data-comic-id=['"](\d+)/);
    return m ? m[1] : null;
  }

  function findChapterId(html) {
    const m = html.match(/api\/manga\/count\/\d+\/(\d+)/) ||
              html.match(/chapter_id\s*[:=]\s*['"]?(\d+)/) ||
              html.match(/data-chapter-id=['"](\d+)/) ||
              html.match(/chapterId\s*[:=]\s*['"]?(\d+)/);
    return m ? m[1] : null;
  }

  function authHeaders() {
    const t = getCookie('token');
    return {
      'Authorization': 'Bearer ' + t,
      'X-Requested-With': 'XMLHttpRequest'
    };
  }

  async function apiBookmark(comicId) {
    const r = await fetch('/action/bookmark/' + comicId + '?action=add', {
      credentials: 'same-origin', headers: authHeaders()
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
  }

  async function apiMarkViewed(comicId, chapterId) {
    const r = await fetch('/api/manga/count/' + comicId + '/' + chapterId, {
      method: 'POST', credentials: 'same-origin',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' }
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
  }

  // ═══════════════════════════════════════════
  //  SYNC ENGINE
  // ═══════════════════════════════════════════

  let running = false, stopFlag = false;
  let report = [];

  async function runSync(mangaList, onUpdate) {
    running = true;
    stopFlag = false;
    report = [];

    const counts = { bookmarked: 0, existed: 0, bmFail: 0, chSynced: 0, chFail: 0, chSkip: 0 };

    for (let i = 0; i < mangaList.length; i++) {
      if (stopFlag) { onUpdate(i, mangaList.length, null, counts, 'stopped'); break; }

      const m = mangaList[i];
      const row = {
        index: i + 1,
        title: m.title,
        slug: m.slug,
        targetChapter: m.chapter,
        bookmark: 'pending',
        progress: m.chapter > 0 ? 'pending' : 'n/a',
        comicId: null,
        chapterId: null,
        errors: []
      };

      try {
        // 1) Fetch manga detail page → comic_id
        let html;
        try {
          html = await fetchPage('/manga/' + m.slug);
        } catch (e) {
          row.bookmark = 'failed';
          if (m.chapter > 0) row.progress = 'failed';
          row.errors.push('Page: ' + e.message);
          report.push(row);
          counts.bmFail++;
          if (m.chapter > 0) counts.chFail++;
          onUpdate(i + 1, mangaList.length, row, counts);
          await wait(1500);
          continue;
        }

        const comicId = findComicId(html);
        row.comicId = comicId;

        if (!comicId) {
          row.bookmark = 'failed';
          if (m.chapter > 0) row.progress = 'failed';
          row.errors.push('Comic ID not found in page HTML');
          report.push(row);
          counts.bmFail++;
          if (m.chapter > 0) counts.chFail++;
          onUpdate(i + 1, mangaList.length, row, counts);
          await wait(1500);
          continue;
        }

        // 2) Bookmark
        const already = />\s*Followed\s*</.test(html) ||
                        /btnBookmark[^"]*Active/.test(html) ||
                        /action=remove/.test(html);
        if (already) {
          row.bookmark = 'exists';
          counts.existed++;
        } else {
          try {
            await apiBookmark(comicId);
            row.bookmark = 'success';
            counts.bookmarked++;
          } catch (e) {
            row.bookmark = 'failed';
            row.errors.push('Bookmark: ' + e.message);
            counts.bmFail++;
            if (e.message.includes('401') || e.message.includes('403')) {
              onUpdate(i + 1, mangaList.length, row, counts, 'Auth expired — log in again');
              report.push(row);
              running = false;
              return report;
            }
          }
        }

        // 3) Reading progress
        if (m.chapter > 0) {
          try {
            const chUrl = '/manga/' + m.slug + '/chapter-' + m.chapter;
            const chHtml = await fetchPage(chUrl);
            const chapterId = findChapterId(chHtml);
            row.chapterId = chapterId;

            if (chapterId) {
              await apiMarkViewed(comicId, chapterId);
              row.progress = 'success';
              counts.chSynced++;
            } else {
              row.progress = 'failed';
              row.errors.push('Chapter ID not found in chapter page HTML');
              counts.chFail++;
            }
          } catch (e) {
            row.progress = 'failed';
            row.errors.push('Progress: ' + e.message);
            counts.chFail++;
          }
        } else {
          counts.chSkip++;
        }
      } catch (e) {
        row.bookmark = row.bookmark === 'pending' ? 'failed' : row.bookmark;
        row.errors.push('Unexpected: ' + e.message);
        counts.bmFail++;
      }

      report.push(row);
      onUpdate(i + 1, mangaList.length, row, counts);
      await wait(2000);
    }

    running = false;
    onUpdate(mangaList.length, mangaList.length, null, counts, 'done');
    return report;
  }

  function downloadReport() {
    const failed = report.filter(r => r.errors.length > 0);
    const data = {
      timestamp: new Date().toISOString(),
      totalProcessed: report.length,
      summary: {
        bookmarkSuccess: report.filter(r => r.bookmark === 'success').length,
        bookmarkExists: report.filter(r => r.bookmark === 'exists').length,
        bookmarkFailed: report.filter(r => r.bookmark === 'failed').length,
        progressSuccess: report.filter(r => r.progress === 'success').length,
        progressFailed: report.filter(r => r.progress === 'failed').length,
        progressSkipped: report.filter(r => r.progress === 'n/a').length,
      },
      failed,
      allResults: report
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'nelomanga-sync-report-' + Date.now() + '.json';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // ═══════════════════════════════════════════
  //  UI
  // ═══════════════════════════════════════════

  let mangaList = [];

  function $(id) { return document.getElementById(id); }

  function createUI() {
    const root = document.createElement('div');
    root.id = 'nbs-root';
    root.innerHTML = `
<style>
#nbs-toggle{position:fixed;bottom:20px;right:20px;z-index:999998;width:52px;height:52px;
  border-radius:50%;border:none;background:#7fdbca;color:#1a1a2e;font-size:22px;cursor:pointer;
  box-shadow:0 3px 12px rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;
  transition:transform .2s}
#nbs-toggle:hover{transform:scale(1.1)}
#nbs-panel{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:999999;
  background:#1a1a2e;color:#e0e0e0;border:1px solid #333;border-radius:12px;
  width:580px;max-height:90vh;font:13px/1.5 system-ui,sans-serif;
  box-shadow:0 8px 40px rgba(0,0,0,.6);display:none;flex-direction:column;overflow:hidden;
  transition:width .3s,max-height .3s,top .3s,left .3s,transform .3s,border-radius .3s}
#nbs-panel.open{display:flex}
#nbs-panel.minimized{top:auto;left:auto;bottom:80px;right:20px;transform:none;
  width:260px;max-height:44px;border-radius:22px;overflow:hidden;position:fixed}
#nbs-panel.minimized .nbs-body,#nbs-panel.minimized .nbs-footer{display:none}
#nbs-panel.minimized .nbs-hdr{border:none;padding:10px 16px;cursor:pointer}
#nbs-panel.minimized .nbs-hdr h2{font-size:13px}
#nbs-panel.minimized .nbs-min{display:none}
.nbs-min{background:none;border:none;color:#888;font-size:18px;cursor:pointer;padding:0 6px;margin-right:4px}
.nbs-min:hover{color:#fff}
.nbs-hdr{padding:16px 20px 12px;border-bottom:1px solid #2a2a3e;display:flex;align-items:center;justify-content:space-between}
.nbs-hdr h2{margin:0;font-size:16px;color:#7fdbca;font-weight:700}
.nbs-body{padding:16px 20px;overflow-y:auto;flex:1}
.nbs-drop{border:2px dashed #444;border-radius:10px;padding:40px 20px;text-align:center;
  cursor:pointer;transition:border-color .2s,background .2s}
.nbs-drop:hover,.nbs-drop.over{border-color:#7fdbca;background:rgba(127,219,202,.06)}
.nbs-drop p{margin:4px 0;color:#888}
.nbs-drop .big{font-size:32px;margin-bottom:8px}
.nbs-stats{display:flex;gap:12px;flex-wrap:wrap;margin:12px 0}
.nbs-stat{background:#222238;border-radius:6px;padding:8px 14px;text-align:center;flex:1;min-width:90px}
.nbs-stat .n{font-size:20px;font-weight:700}
.nbs-stat .l{font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:#888;margin-top:2px}
.nbs-bar{height:6px;background:#222;border-radius:3px;margin:8px 0;overflow:hidden}
.nbs-bar-fill{height:100%;background:#7fdbca;width:0%;transition:width .3s}
.nbs-log{max-height:250px;overflow-y:auto;background:#111;border-radius:6px;padding:10px;
  font:11px/1.6 Consolas,monospace;margin:10px 0}
.nbs-log div{padding:1px 0;border-bottom:1px solid #1a1a1a}
.nbs-tbl{width:100%;border-collapse:collapse;font-size:12px;margin:10px 0}
.nbs-tbl th{text-align:left;padding:6px 8px;border-bottom:2px solid #333;color:#7fdbca;
  font-weight:600;position:sticky;top:0;background:#1a1a2e}
.nbs-tbl td{padding:5px 8px;border-bottom:1px solid #222}
.nbs-tbl tr:hover td{background:#222238}
.nbs-btn{padding:8px 18px;border:none;border-radius:6px;cursor:pointer;font:600 13px system-ui;
  transition:opacity .2s}
.nbs-btn:disabled{opacity:.4;cursor:default}
.nbs-btn-primary{background:#7fdbca;color:#1a1a2e}
.nbs-btn-danger{background:#ff6b6b;color:#fff}
.nbs-btn-ghost{background:#333;color:#e0e0e0}
.nbs-footer{padding:12px 20px;border-top:1px solid #2a2a3e;display:flex;gap:8px;justify-content:flex-end}
.c-ok{color:#7fdbca}.c-warn{color:#ffd93d}.c-fail{color:#ff6b6b}.c-info{color:#82aaff}.c-mute{color:#888}
.nbs-auth{font-size:12px;margin-bottom:10px}
.nbs-filter{margin:8px 0;display:flex;gap:6px}
.nbs-filter button{padding:4px 10px;border:1px solid #333;border-radius:4px;background:transparent;
  color:#ccc;font-size:11px;cursor:pointer}
.nbs-filter button.active{border-color:#7fdbca;color:#7fdbca;background:rgba(127,219,202,.1)}
.nbs-scroll-tbl{max-height:260px;overflow-y:auto}
.nbs-close{background:none;border:none;color:#888;font-size:20px;cursor:pointer;padding:0 4px}
.nbs-close:hover{color:#fff}
</style>

<button id="nbs-toggle" title="Backup Sync">&#9733;</button>
<div id="nbs-panel">
  <div class="nbs-hdr">
    <h2>Nelomanga Backup Sync</h2>
    <div>
      <button class="nbs-min" id="nbs-min" title="Minimize">&#8211;</button>
      <button class="nbs-close" id="nbs-x" title="Close">&times;</button>
    </div>
  </div>
  <div class="nbs-body" id="nbs-body"></div>
  <div class="nbs-footer" id="nbs-footer"></div>
</div>`;
    document.body.appendChild(root);

    $('nbs-toggle').onclick = () => {
      const panel = $('nbs-panel');
      if (panel.classList.contains('minimized')) {
        panel.classList.remove('minimized');
      } else {
        panel.classList.toggle('open');
      }
    };
    $('nbs-min').onclick = () => $('nbs-panel').classList.add('minimized');
    $('nbs-panel').querySelector('.nbs-hdr').addEventListener('click', e => {
      if ($('nbs-panel').classList.contains('minimized')) {
        e.stopPropagation();
        $('nbs-panel').classList.remove('minimized');
      }
    });
    $('nbs-x').onclick = () => $('nbs-panel').classList.remove('open');

    showUploadView();
  }

  // ── Upload View ──

  function showUploadView() {
    const token = getCookie('token');
    $('nbs-body').innerHTML = `
      <div class="nbs-auth">${token
        ? '<span class="c-ok">&#10003; Logged in</span>'
        : '<span class="c-fail">&#10007; Not logged in — log in first</span>'}</div>
      <div class="nbs-drop" id="nbs-drop">
        <div class="big">&#128193;</div>
        <p><b>Drop your backup file here</b></p>
        <p class="c-mute">.tachibk &nbsp;|&nbsp; .bk &nbsp;|&nbsp; .zip (Futon/Tachiyomi)</p>
        <input type="file" id="nbs-file" accept=".tachibk,.bk,.zip" style="display:none">
        <button class="nbs-btn nbs-btn-ghost" style="margin-top:12px"
          onclick="document.getElementById('nbs-file').click()">Browse Files</button>
      </div>`;
    $('nbs-footer').innerHTML = '';

    const drop = $('nbs-drop');
    const input = $('nbs-file');

    drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', e => {
      e.preventDefault(); drop.classList.remove('over');
      if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
    });
    input.addEventListener('change', () => { if (input.files.length) handleFile(input.files[0]); });
  }

  async function handleFile(file) {
    $('nbs-body').innerHTML = '<p class="c-info">Parsing ' + file.name + '...</p>';
    $('nbs-footer').innerHTML = '';
    try {
      mangaList = await parseFile(file);
      if (!mangaList.length) throw new Error('No manga found in backup');
      showPreviewView(file.name);
    } catch (e) {
      $('nbs-body').innerHTML = `<p class="c-fail">Error: ${e.message}</p>
        <button class="nbs-btn nbs-btn-ghost" style="margin-top:12px"
          onclick="document.getElementById('nbs-body').innerHTML='';
          document.querySelector('#nbs-root script') || 0;
          ">Try Again</button>`;
      $('nbs-footer').innerHTML = `<button class="nbs-btn nbs-btn-ghost" id="nbs-back">Back</button>`;
      $('nbs-back').onclick = showUploadView;
    }
  }

  // ── Preview View ──

  function showPreviewView(filename) {
    const withProgress = mangaList.filter(m => m.chapter > 0).length;
    let tableHtml = mangaList.map((m, i) => `<tr>
      <td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
        title="${m.title}">${m.title}</td>
      <td class="c-mute" style="max-width:140px;overflow:hidden;text-overflow:ellipsis"
        title="${m.slug}">${m.slug}</td>
      <td style="text-align:center">${m.chapter || '—'}</td>
    </tr>`).join('');

    $('nbs-body').innerHTML = `
      <p><b>${filename}</b></p>
      <div class="nbs-stats">
        <div class="nbs-stat"><div class="n">${mangaList.length}</div><div class="l">Manga</div></div>
        <div class="nbs-stat"><div class="n c-info">${withProgress}</div><div class="l">With Progress</div></div>
        <div class="nbs-stat"><div class="n c-mute">${mangaList.length - withProgress}</div><div class="l">Bookmark Only</div></div>
      </div>
      <div class="nbs-scroll-tbl">
        <table class="nbs-tbl">
          <thead><tr><th>Title</th><th>Slug</th><th>Ch</th></tr></thead>
          <tbody>${tableHtml}</tbody>
        </table>
      </div>`;

    $('nbs-footer').innerHTML = `
      <button class="nbs-btn nbs-btn-ghost" id="nbs-back2">Back</button>
      <button class="nbs-btn nbs-btn-primary" id="nbs-start"
        ${!getCookie('token') ? 'disabled title="Log in first"' : ''}>Start Sync</button>`;

    $('nbs-back2').onclick = showUploadView;
    $('nbs-start').onclick = showSyncView;
  }

  // ── Sync View ──

  function showSyncView() {
    $('nbs-body').innerHTML = `
      <div class="nbs-stats" id="nbs-counters">
        <div class="nbs-stat"><div class="n c-ok" id="nc-bm">0</div><div class="l">Bookmarked</div></div>
        <div class="nbs-stat"><div class="n c-warn" id="nc-ex">0</div><div class="l">Existed</div></div>
        <div class="nbs-stat"><div class="n c-info" id="nc-ch">0</div><div class="l">Ch Synced</div></div>
        <div class="nbs-stat"><div class="n c-fail" id="nc-fl">0</div><div class="l">Failed</div></div>
      </div>
      <div class="nbs-bar"><div class="nbs-bar-fill" id="nbs-bar"></div></div>
      <div id="nbs-progress-text" class="c-mute" style="font-size:11px;margin-bottom:6px">0 / ${mangaList.length}</div>
      <div class="nbs-log" id="nbs-log"></div>`;

    $('nbs-footer').innerHTML = `<button class="nbs-btn nbs-btn-danger" id="nbs-stop">Stop</button>`;
    $('nbs-stop').onclick = () => { stopFlag = true; };

    runSync(mangaList, onSyncUpdate);
  }

  function logLine(msg, cls) {
    const el = $('nbs-log');
    if (!el) return;
    const d = document.createElement('div');
    d.className = cls ? 'c-' + cls : '';
    d.textContent = msg;
    el.appendChild(d);
    el.scrollTop = el.scrollHeight;
  }

  function onSyncUpdate(done, total, row, counts, status) {
    const bar = $('nbs-bar');
    const txt = $('nbs-progress-text');
    if (bar) bar.style.width = ((done / total) * 100) + '%';
    if (txt) txt.textContent = done + ' / ' + total;

    if ($('nc-bm')) $('nc-bm').textContent = counts.bookmarked;
    if ($('nc-ex')) $('nc-ex').textContent = counts.existed;
    if ($('nc-ch')) $('nc-ch').textContent = counts.chSynced;
    if ($('nc-fl')) $('nc-fl').textContent = counts.bmFail + counts.chFail;

    if (row) {
      const bmIcon = { success: '✓', exists: '~', failed: '✗', pending: '?' }[row.bookmark] || '?';
      const bmCls = { success: 'ok', exists: 'warn', failed: 'fail' }[row.bookmark] || 'mute';
      logLine(`[${row.index}/${total}] ${row.title} — bookmark ${bmIcon}`, bmCls);

      if (row.progress === 'success') {
        logLine(`  → ch.${row.targetChapter} viewed (id:${row.chapterId})`, 'info');
      } else if (row.progress === 'failed') {
        logLine(`  → ch.${row.targetChapter} FAILED: ${row.errors[row.errors.length - 1]}`, 'fail');
      }
    }

    if (status === 'done' || status === 'stopped') {
      const msg = status === 'stopped' ? 'Sync stopped by user.' : 'Sync complete!';
      logLine(msg, status === 'stopped' ? 'warn' : 'ok');
      showReportFooter();
    }
    if (status && status.startsWith('Auth')) {
      logLine(status, 'fail');
      showReportFooter();
    }
  }

  function showReportFooter() {
    const failCount = report.filter(r => r.errors.length > 0).length;
    $('nbs-footer').innerHTML = `
      ${failCount > 0 ? `<button class="nbs-btn nbs-btn-ghost" id="nbs-show-err">View Failures (${failCount})</button>` : ''}
      <button class="nbs-btn nbs-btn-ghost" id="nbs-dl">Download Report</button>
      <button class="nbs-btn nbs-btn-primary" id="nbs-new">New Upload</button>`;

    if ($('nbs-show-err')) $('nbs-show-err').onclick = showErrorView;
    $('nbs-dl').onclick = downloadReport;
    $('nbs-new').onclick = () => { mangaList = []; report = []; showUploadView(); };
  }

  // ── Error View ──

  function showErrorView() {
    const failed = report.filter(r => r.errors.length > 0);

    const rows = failed.map(r => {
      const actions = [];
      if (r.bookmark === 'failed') actions.push('Bookmark');
      if (r.progress === 'failed') actions.push('Ch.' + r.targetChapter);
      return `<tr>
        <td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
          title="${r.title}">${r.title}</td>
        <td>${actions.join(', ')}</td>
        <td class="c-fail" style="max-width:200px;overflow:hidden;text-overflow:ellipsis"
          title="${r.errors.join(' | ')}">${r.errors.join('; ')}</td>
      </tr>`;
    }).join('');

    $('nbs-body').innerHTML = `
      <h3 style="margin:0 0 8px;color:#ff6b6b">${failed.length} Failed Items</h3>
      <div class="nbs-scroll-tbl" style="max-height:350px">
        <table class="nbs-tbl">
          <thead><tr><th>Title</th><th>Action</th><th>Error</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;

    $('nbs-footer').innerHTML = `
      <button class="nbs-btn nbs-btn-ghost" id="nbs-back-sync">Back to Log</button>
      <button class="nbs-btn nbs-btn-ghost" id="nbs-dl2">Download Report</button>
      <button class="nbs-btn nbs-btn-primary" id="nbs-new2">New Upload</button>`;

    $('nbs-back-sync').onclick = showSyncView;
    $('nbs-dl2').onclick = downloadReport;
    $('nbs-new2').onclick = () => { mangaList = []; report = []; showUploadView(); };
  }

  // ── Init ──
  if (typeof pako === 'undefined' || typeof JSZip === 'undefined') {
    console.error('[Nelomanga Sync] pako or JSZip not loaded. Check @require URLs.');
    return;
  }
  createUI();
})();
