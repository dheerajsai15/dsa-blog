// Stepper: the shared engine behind the array-style topic pages.
//
// A page registers algorithms with Stepper.add({...}) and calls Stepper.start('firstId').
// An algorithm's run(T, p) records frames with T.step(mark, message, blocks), where
// `mark` names a //@mark comment in its C++ code and `blocks` describe everything on
// the stage for that frame (arrays, maps, stacks, grids, bars, timelines, trees).
// Frames are plain data, so stepping backwards is just showing an earlier frame.
(() => {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const NS = 'http://www.w3.org/2000/svg';
  const RM = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const clone = (x) => JSON.parse(JSON.stringify(x));

  function parseCode(src) {
    const lines = [], marks = {};
    src.replace(/^\n+/, '').replace(/\s+$/, '').split('\n').forEach((ln, i) => {
      const m = ln.match(/\/\/@([\w,]+)/);
      if (m) { m[1].split(',').forEach(k => { marks[k] = i; }); ln = ln.replace(/\s*\/\/@[\w,]+/, ''); }
      lines.push(ln.replace(/\s+$/, ''));
    });
    return { lines, marks };
  }

  class Tracer {
    constructor(marks) { this.marks = marks; this.frames = []; this.out = []; }
    step(mark, msg, blocks = []) {
      if (mark && this.marks[mark] === undefined) throw new Error('Unknown code mark: ' + mark);
      this.frames.push({ line: mark ? this.marks[mark] : -1, msg, blocks: clone(blocks.filter(Boolean)), out: [...this.out] });
    }
  }

  /* ---------- block builders ---------- */
  // st: {index: cls}; ptr / ptrUp: {name: index} drawn below / above; win: [l, r, cls?].
  const B = {
    arr: (name, vals, o = {}) => ({ t: 'arr', name, vals, ...o }),
    map: (name, entries, o = {}) => ({ t: 'map', name, entries, ...o }),         // entries: [[key, value, cls?]]
    chips: (name, items, o = {}) => ({ t: 'chips', name, items, ...o }),        // items: strings or {t, cls}
    vars: (items, o = {}) => ({ t: 'vars', name: o.name || '', items, ...o }),  // items: [[name, value, cls?]]
    grid: (name, cells, o = {}) => ({ t: 'grid', name, cells, ...o }),          // st: {'r,c': cls}
    bars: (name, vals, o = {}) => ({ t: 'bars', name, vals, ...o }),            // water: [], rect: [l, r, h, cls?]
    ivl: (name, lanes, o = {}) => ({ t: 'ivl', name, lanes, ...o }),            // lanes: [{name, items: [[a, b, cls?, label?]]}]
    tree: (name, nodes, edges, o = {}) => ({ t: 'tree', name, nodes, edges, ...o }), // nodes: [{id, label, x, y, cls, badge, tag}]
    text: (name, text, o = {}) => ({ t: 'text', name, text, ...o }),
  };
  // Tidy layout for a rooted tree given as {id: parentId}. Leaves get consecutive x; parents center over children.
  function layoutTree(parent, root, order) {
    const kids = {}; for (const id of order) { const p = parent[id]; if (p != null) (kids[p] = kids[p] || []).push(id); }
    const pos = {}; let x = 0;
    const go = (id, d) => {
      const ks = kids[id] || [];
      if (!ks.length) { pos[id] = { x: x++, y: d }; return; }
      ks.forEach(k => go(k, d + 1));
      pos[id] = { x: (pos[ks[0]].x + pos[ks[ks.length - 1]].x) / 2, y: d };
    };
    go(root, 0); return pos;
  }
  const heapPos = (i) => { const d = Math.floor(Math.log2(i + 1)), p = i + 1 - 2 ** d; return { x: (p + 0.5) * (2 ** (3 - d)) - 0.5, y: d }; };

  /* ---------- rendering ---------- */
  const PAL = ['cur', 'wait', 'path', 'target', 'done', 'g3'];
  const R = { els: new Map() };
  const sigOf = (b) => b.t + ':' + (b.t === 'arr' || b.t === 'bars' ? b.vals.length : b.t === 'grid' ? b.cells.length + 'x' + (b.cells[0] || []).length : '');

  function renderScene(f) {
    const box = $('#scene'), seen = new Set();
    let prev = null;
    f.blocks.forEach((b, k) => {
      const key = (b.key || b.name || '') + '#' + b.t + (b.key || b.name ? '' : k);
      seen.add(key);
      let r = R.els.get(key);
      if (!r || r.sig !== sigOf(b)) {
        if (r) r.el.remove();
        const el = document.createElement('div'); el.className = 'blk blk-' + b.t;
        el.innerHTML = `<div class="bn"></div><div class="bw"></div>`;
        r = { el, sig: sigOf(b), state: {} }; R.els.set(key, r);
      }
      if (prev ? prev.nextSibling !== r.el : box.firstChild !== r.el) box.insertBefore(r.el, prev ? prev.nextSibling : box.firstChild);
      prev = r.el;
      const bn = r.el.firstChild;
      bn.innerHTML = esc(b.name || '') + (b.hint ? `<span class="bh">${esc(b.hint)}</span>` : '');
      r.el.classList.toggle('noname', !b.name);
      DRAW[b.t](r, b);
    });
    for (const [key, r] of R.els) if (!seen.has(key)) { r.el.remove(); R.els.delete(key); }
  }
  function resetScene() { $('#scene').innerHTML = ''; R.els.clear(); }

  // Pointer carets under (or over) anchor elements, stacked when several share a slot.
  function placePtrs(r, holder, anchors, ptr, up, pc) {
    const names = Object.keys(ptr || {}), lv = {}, byIdx = {};
    names.forEach(n => { const i = ptr[n]; if (i == null) return; byIdx[i] = (byIdx[i] || 0); lv[n] = byIdx[i]++; });
    const levels = Math.max(0, ...Object.values(byIdx));
    const cls = up ? 'pt up' : 'pt';
    r.state.pts = r.state.pts || {};
    const key = up ? 'u' : 'd', bag = r.state.pts[key] = r.state.pts[key] || new Map();
    for (const [n, el] of bag) if (!(n in (ptr || {})) || ptr[n] == null) { el.remove(); bag.delete(n); }
    names.forEach((n, k) => {
      const i = ptr[n]; if (i == null) return;
      let el = bag.get(n);
      if (!el) { el = document.createElement('span'); el.textContent = n; holder.appendChild(el); bag.set(n, el); }
      el.className = cls + ' p-' + ((pc && pc[n]) || PAL[k % PAL.length]);
      el.dataset.i = i; el.dataset.lv = lv[n];
    });
    return levels;
  }
  function positionPtrs(r, holder, anchors, upPad) {
    const bag = r.state.pts || {};
    for (const key of ['u', 'd']) for (const [, el] of bag[key] || []) {
      const i = +el.dataset.i, lv = +el.dataset.lv;
      const a = anchors[Math.max(0, Math.min(anchors.length - 1, i))]; if (!a) continue;
      const w = a.offsetWidth, gap = anchors.length > 1 ? anchors[1].offsetLeft - anchors[0].offsetLeft - w : 6;
      const x = a.offsetLeft + w / 2 + (i < 0 ? i * (w + gap) : i >= anchors.length ? (i - anchors.length + 1) * (w + gap) : 0);
      el.style.left = x + 'px';
      el.style.top = key === 'd' ? (a.offsetTop + a.offsetHeight + 3 + lv * 15) + 'px' : (upPad - 18 - lv * 15) + 'px';
    }
  }
  // Scroll a wide row so the window (or first pointer) stays visible.
  function keepInView(scroller, inner, el) {
    if (!el || scroller.scrollWidth <= scroller.clientWidth) return;
    const x0 = el.offsetLeft - (el.classList.contains('pt') ? 40 : 12), x1 = el.offsetLeft + (el.offsetWidth || 0) + 40;
    if (x0 < scroller.scrollLeft || x1 > scroller.scrollLeft + scroller.clientWidth) scroller.scrollLeft = Math.max(0, x0 - 20);
  }
  const cellCls = (base, v, st) => base + (v === '' || v == null ? ' empty' : '') + (st ? ' c-' + st : '');

  const DRAW = {
    arr(r, b) {
      const bw = r.el.lastChild, n = b.vals.length;
      if (!r.state.cw) {
        bw.innerHTML = `<div class="cw"><div class="win" hidden></div>${b.vals.map(() => `<div class="col"><span class="ix"></span><span class="cell"></span></div>`).join('')}</div>`;
        r.state.cw = bw.firstChild; r.state.cols = [...r.state.cw.querySelectorAll('.col')];
      }
      const cw = r.state.cw, cells = r.state.cols.map(c => c.lastChild);
      r.state.cols.forEach((c, i) => {
        const ix = c.firstChild, v = b.vals[i];
        ix.textContent = b.heads ? (b.heads[i] ?? '') : b.idx === false ? '' : i + (b.base || 0);
        ix.hidden = b.idx === false && !b.heads;
        const cell = c.lastChild, txt = v == null ? '' : String(v);
        cell.className = cellCls('cell' + (b.sm ? ' sm' : ''), txt, (b.st || {})[i]);
        if (cell.textContent !== txt) { cell.textContent = txt; if (!RM && r.state.drawn) cell.animate([{ transform: 'scale(1.18)' }, { transform: 'scale(1)' }], { duration: 260 }); }
      });
      const upLv = placePtrs(r, cw, cells, b.ptrUp, true, b.pc), dnLv = placePtrs(r, cw, cells, b.ptr, false, b.pc);
      const hasUp = b.ptrUp && Object.values(b.ptrUp).some(v => v != null), hasDn = b.ptr && Object.values(b.ptr).some(v => v != null);
      const upPad = hasUp ? 20 + upLv * 15 : 2;
      cw.style.paddingTop = upPad + 'px'; cw.style.paddingBottom = (hasDn ? 20 + dnLv * 15 : 2) + 'px';
      positionPtrs(r, cw, cells, upPad);
      const win = cw.firstChild;
      if (b.win && n) {
        const [l, rr, wc] = b.win, a = cells[Math.max(0, Math.min(n - 1, l))], z = cells[Math.max(0, Math.min(n - 1, rr))];
        win.hidden = rr < l;
        win.className = 'win' + (wc ? ' w-' + wc : '');
        win.style.left = (a.offsetLeft - 4) + 'px'; win.style.width = (z.offsetLeft + z.offsetWidth - a.offsetLeft + 8) + 'px';
        win.style.top = (a.offsetTop - 4) + 'px'; win.style.height = (a.offsetHeight + 8) + 'px';
      } else win.hidden = true;
      keepInView(bw, cw, b.win && n ? win : cw.querySelector('.pt'));
      if (cells[0]) r.el.firstChild.style.paddingTop = Math.max(0, cells[0].offsetTop + cells[0].offsetHeight / 2 - 10) + 'px';
      r.state.drawn = true;
    },
    map(r, b) {
      const bw = r.el.lastChild;
      bw.innerHTML = `<div class="chips">${b.entries.length ? b.entries.map(([k, v, c]) => `<span class="chip kv${c ? ' c-' + c : ''}"><b>${esc(k)}</b>${v === undefined ? '' : `<i>→</i>${esc(v)}`}</span>`).join('') : '<span class="empty">empty</span>'}</div>`;
    },
    chips(r, b) {
      const bw = r.el.lastChild, items = b.items.map(v => (v && typeof v === 'object') ? v : { t: v });
      bw.innerHTML = `<div class="chips${b.kind ? ' k-' + b.kind : ''}">${items.length ? items.map((v, i) => `<span class="chip${v.cls ? ' c-' + v.cls : ''}${b.kind === 'stack' && i === items.length - 1 ? ' top' : ''}">${esc(v.t)}</span>`).join('') : '<span class="empty">empty</span>'}</div>`;
    },
    vars(r, b) {
      r.el.lastChild.innerHTML = `<div class="vars">${b.items.map(([k, v, c]) => `<span class="var${c ? ' c-' + c : ''}"><i>${esc(k)}</i> = <b>${esc(v)}</b></span>`).join('')}</div>`;
    },
    text(r, b) {
      r.el.lastChild.innerHTML = `<div class="txt${b.mono === false ? '' : ' mono'}">${b.html ? b.text : esc(b.text)}</div>`;
    },
    grid(r, b) {
      const bw = r.el.lastChild, R_ = b.cells.length, C = (b.cells[0] || []).length;
      if (!r.state.g) {
        let h = `<div class="gridb${b.small ? ' small' : ''}" style="grid-template-columns:auto repeat(${C}, auto)"><span></span>`;
        for (let c = 0; c < C; c++) h += `<span class="ix gx"></span>`;
        for (let rr = 0; rr < R_; rr++) { h += `<span class="ix gy"></span>`; for (let c = 0; c < C; c++) h += `<span class="cell"></span>`; }
        bw.innerHTML = h + '</div>'; r.state.g = bw.firstChild;
        r.state.cells = [...r.state.g.querySelectorAll('.cell')]; r.state.gx = [...r.state.g.querySelectorAll('.gx')]; r.state.gy = [...r.state.g.querySelectorAll('.gy')];
      }
      r.state.gx.forEach((e, c) => { e.textContent = b.cols ? (b.cols[c] ?? '') : b.idx === false ? '' : c; });
      r.state.gy.forEach((e, rr) => { e.textContent = b.rows ? (b.rows[rr] ?? '') : b.idx === false ? '' : rr; });
      r.state.cells.forEach((cell, k) => {
        const rr = Math.floor(k / C), c = k % C, v = b.cells[rr][c], txt = v == null ? '' : String(v);
        cell.className = cellCls('cell', txt, (b.st || {})[rr + ',' + c]);
        if (cell.textContent !== txt) { cell.textContent = txt; if (!RM && r.state.drawn) cell.animate([{ transform: 'scale(1.18)' }, { transform: 'scale(1)' }], { duration: 260 }); }
      });
      r.state.drawn = true;
    },
    bars(r, b) {
      const bw = r.el.lastChild, n = b.vals.length, H = b.h || 150;
      const max = Math.max(1, b.max || 0, ...b.vals.map((v, i) => v + ((b.water || [])[i] || 0)));
      if (!r.state.bx) {
        bw.innerHTML = `<div class="barsb"><div class="rect" hidden></div>${b.vals.map(() => `<div class="bcol"><span class="bv"></span><div class="bst" style="height:${H}px"><div class="bw2"></div><div class="bb"></div></div><span class="ix"></span></div>`).join('')}</div>`;
        r.state.bx = bw.firstChild; r.state.cols = [...r.state.bx.querySelectorAll('.bcol')];
      }
      const unit = H / max;
      r.state.cols.forEach((c, i) => {
        const v = b.vals[i], w = (b.water || [])[i] || 0, [bv, st, ix] = c.children, [wd, bar] = st.children;
        bv.textContent = w ? `${v}+${w}` : v; ix.textContent = i;
        bar.style.height = (v * unit) + 'px'; bar.className = 'bb' + ((b.st || {})[i] ? ' c-' + b.st[i] : '');
        wd.style.bottom = (v * unit) + 'px'; wd.style.height = (w * unit) + 'px'; wd.hidden = !w;
      });
      const anchors = r.state.cols.map(c => c.children[1]);
      const dnLv = placePtrs(r, r.state.bx, anchors, b.ptr, false, b.pc), hasDn = b.ptr && Object.values(b.ptr).some(v => v != null);
      r.state.bx.style.paddingBottom = (hasDn ? 20 + dnLv * 15 : 2) + 'px';
      r.state.cols.forEach(c => { c.lastChild.style.marginBottom = '0'; });
      positionPtrs(r, r.state.bx, r.state.cols.map(c => c.lastChild), 0);
      const rect = r.state.bx.firstChild;
      if (b.rect && n) {
        const [l, rr, h, rc] = b.rect, a = anchors[l], z = anchors[rr];
        rect.hidden = false; rect.className = 'rect' + (rc ? ' w-' + rc : '');
        rect.style.left = (a.offsetLeft - 3) + 'px'; rect.style.width = (z.offsetLeft + z.offsetWidth - a.offsetLeft + 6) + 'px';
        rect.style.top = (a.offsetTop + H - h * unit) + 'px'; rect.style.height = (h * unit) + 'px';
      } else rect.hidden = true;
    },
    ivl(r, b) {
      const lo = b.min, hi = b.max, span = Math.max(1, hi - lo), pct = (v) => ((v - lo) / span * 100).toFixed(3) + '%';
      let h = '<div class="tl">';
      b.lanes.forEach(L => {
        h += `<div class="lane"><span class="ln">${esc(L.name || '')}</span><div class="track">`;
        (L.items || []).forEach(([a, z, c, lab]) => { h += `<span class="bar${c ? ' c-' + c : ''}" style="left:${pct(a)};width:calc(${pct(z)} - ${pct(a)})">${esc(lab ?? `${a},${z}`)}</span>`; });
        if (b.at != null) h += `<span class="sweep" style="left:${pct(b.at)}"></span>`;
        h += '</div></div>';
      });
      const step = span <= 12 ? 1 : span <= 24 ? 2 : span <= 60 ? 5 : 10;
      h += '<div class="lane axis"><span class="ln"></span><div class="track">';
      for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) h += `<span class="tick" style="left:${pct(v)}">${v}</span>`;
      r.el.lastChild.innerHTML = h + '</div></div></div>';
    },
    tree(r, b) {
      const bw = r.el.lastChild, UX = b.ux || 46, UY = b.uy || 58, RAD = b.r || 16;
      if (!r.state.svg) { bw.innerHTML = `<svg class="treeb" role="img"><g class="es"></g><g class="ns"></g></svg>`; r.state.svg = bw.firstChild; r.state.nodes = new Map(); }
      const svg = r.state.svg, gE = svg.firstChild, gN = svg.lastChild, pos = {};
      b.nodes.forEach(nd => { pos[nd.id] = { x: nd.x * UX, y: nd.y * UY }; });
      gE.innerHTML = b.edges.map(([u, v, c, lab]) => {
        const p = pos[u], q = pos[v]; if (!p || !q) return '';
        const dx = q.x - p.x, dy = q.y - p.y, L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L;
        const line = `<line class="tl2${c ? ' e-' + c : ''}" x1="${(p.x + ux * RAD).toFixed(1)}" y1="${(p.y + uy * RAD).toFixed(1)}" x2="${(q.x - ux * RAD).toFixed(1)}" y2="${(q.y - uy * RAD).toFixed(1)}"/>`;
        return line + (lab ? `<text class="elab" x="${((p.x + q.x) / 2 + (dx >= 0 ? 7 : -7)).toFixed(1)}" y="${((p.y + q.y) / 2).toFixed(1)}" text-anchor="${dx >= 0 ? 'start' : 'end'}">${esc(lab)}</text>` : '');
      }).join('');
      const keep = new Set();
      b.nodes.forEach(nd => {
        keep.add(String(nd.id));
        let g = r.state.nodes.get(String(nd.id));
        if (!g) {
          g = document.createElementNS(NS, 'g');
          g.innerHTML = `<circle class="halo" r="${RAD + 5}"/><circle class="body" r="${RAD}"/><text class="v" dy=".35em"></text><text class="bd" y="${RAD + 15}"></text><text class="tg" y="${-RAD - 8}"></text>`;
          gN.appendChild(g); r.state.nodes.set(String(nd.id), g);
        }
        g.setAttribute('class', 'nd' + (nd.cls ? ' s-' + nd.cls : ''));
        g.setAttribute('transform', `translate(${pos[nd.id].x.toFixed(1)},${pos[nd.id].y.toFixed(1)})`);
        const [, , v, bd, tg] = g.childNodes, lab = String(nd.label ?? '');
        v.textContent = lab; v.setAttribute('class', 'v' + (lab.length > 3 ? ' xs' : lab.length > 2 ? ' small' : ''));
        bd.textContent = nd.badge ?? ''; tg.textContent = nd.tag ?? '';
      });
      for (const [id, g] of r.state.nodes) if (!keep.has(id)) { g.remove(); r.state.nodes.delete(id); }
      const xs = b.nodes.map(n => pos[n.id].x), ys = b.nodes.map(n => pos[n.id].y);
      const x0 = Math.min(0, ...xs) - RAD - 30, x1 = Math.max(0, ...xs) + RAD + 30, y0 = Math.min(0, ...ys) - RAD - 22, y1 = Math.max(0, ...ys) + RAD + 22;
      const w = Math.max(x1 - x0, 200), h = y1 - y0;
      svg.setAttribute('viewBox', `${(x0 - (w - (x1 - x0)) / 2).toFixed(1)} ${y0.toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)}`);
      svg.style.width = Math.min(w, bw.clientWidth || w) + 'px';
      svg.style.height = Math.min(h, (bw.clientWidth || w) * h / w) + 'px';
    },
  };

  /* ---------- C++ highlighting ---------- */
  const KW = new Set('if else for while do return break continue new delete struct class const auto true false nullptr this public private switch case default using typedef'.split(' '));
  const TY = new Set('void int long bool char double float string vector stack queue deque map unordered_map unordered_set set multiset pair array priority_queue greater less size_t uint32_t int64_t ListNode'.split(' '));
  const FN = new Set('max min abs swap push_back pop_back push_front pop_front push pop top front back size empty count insert erase find reverse sort begin end substr accumulate lower_bound upper_bound to_string stoi isalnum tolower toupper isdigit INT_MAX INT_MIN LLONG_MAX emplace emplace_back make_pair first second'.split(' '));
  function hl(line) {
    let code = line, com = '';
    const ci = line.indexOf('//'); if (ci >= 0) { code = line.slice(0, ci); com = line.slice(ci); }
    const re = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(\b\d+\b)|([A-Za-z_]\w*)/g; let out = '', last = 0, m;
    while ((m = re.exec(code))) {
      out += esc(code.slice(last, m.index)); last = re.lastIndex;
      if (m[1]) out += `<span class="t-str">${esc(m[1])}</span>`;
      else if (m[2]) out += `<span class="t-num">${m[2]}</span>`;
      else { const w = m[3]; out += KW.has(w) ? `<span class="t-kw">${w}</span>` : TY.has(w) ? `<span class="t-ty">${w}</span>` : FN.has(w) ? `<span class="t-fn">${w}</span>` : w; }
    }
    out += esc(code.slice(last));
    if (com) out += `<span class="t-com">${esc(com)}</span>`;
    return out || ' ';
  }

  /* ---------- custom input ---------- */
  function pText(q, v) {
    if (q.type === 'ints') return v.join(', ');
    if (q.type === 'words') return v.join(' ');
    if (q.type === 'grid') return v.join(' ');
    if (q.type === 'ivals') return v.map(([a, b]) => `${a}-${b}`).join(', ');
    if (q.type === 'pts') return v.map(([a, b]) => `${a} ${b}`).join(', ');
    return String(v);
  }
  function pParse(q, raw) {
    const s = raw.trim(), name = q.label, toks = s.split(/[\s,]+/).filter(Boolean);
    const num = (t, what) => { if (!/^-?\d+$/.test(t)) throw new Error(`${name}: "${t}" isn't a whole number.`); return +t; };
    if (q.type === 'int') {
      const v = num(s);
      if (v < q.min || v > q.max) throw new Error(`${name}: use a number from ${q.min} to ${q.max}.`); return v;
    }
    if (q.type === 'num') {
      if (!/^-?\d+(\.\d+)?$/.test(s)) throw new Error(`${name}: enter a number like 2 or 1.5.`);
      const v = +s; if (v < q.min || v > q.max) throw new Error(`${name}: use a number from ${q.min} to ${q.max}.`); return v;
    }
    if (q.type === 'ints') {
      const v = toks.map(t => num(t)), minLen = q.minLen ?? 1;
      if (v.length < minLen || v.length > q.maxLen) throw new Error(`${name}: use ${minLen === q.maxLen ? minLen : minLen + ' to ' + q.maxLen} numbers.`);
      if (v.some(x => x < q.min || x > q.max)) throw new Error(`${name}: keep each value between ${q.min} and ${q.max}.`);
      if (q.sorted && v.some((x, i) => i && x < v[i - 1])) throw new Error(`${name}: must be sorted in ascending order.`);
      if (q.distinct && new Set(v).size !== v.length) throw new Error(`${name}: values must be distinct.`);
      return v;
    }
    if (q.type === 'str') {
      const re = q.chars ? new RegExp(`^[${q.chars}]*$`) : /^[A-Za-z]*$/;
      const v = q.keepSpaces ? raw.replace(/^\s+|\s+$/g, '') : s;
      if (!re.test(v)) throw new Error(`${name}: ${q.charsHint || 'letters only'}.`);
      if (v.length < (q.minLen ?? 1) || v.length > q.maxLen) throw new Error(`${name}: use ${q.minLen ?? 1} to ${q.maxLen} characters.`);
      return q.lower ? v.toLowerCase() : v;
    }
    if (q.type === 'words') {
      const re = q.chars ? new RegExp(`^[${q.chars}]+$`) : /^[a-z]+$/;
      if (toks.length < (q.minLen ?? 1) || toks.length > q.maxLen) throw new Error(`${name}: use ${q.minLen ?? 1} to ${q.maxLen} words.`);
      if (toks.some(t => !re.test(t) || t.length > (q.wordLen || 8))) throw new Error(`${name}: ${q.charsHint || `lowercase letters only, up to ${q.wordLen || 8} each`}.`);
      return toks;
    }
    if (q.type === 'grid') {
      if (!toks.length) throw new Error(`${name}: enter at least one row.`);
      if (toks.some(r => r.length !== toks[0].length)) throw new Error(`${name}: every row needs the same length.`);
      if (toks.some(r => !new RegExp(`^[${q.chars}]+$`).test(r))) throw new Error(`${name}: ${q.charsHint || 'unexpected character'}.`);
      if (toks.length > q.maxR || toks[0].length > q.maxC) throw new Error(`${name}: keep it within ${q.maxR} rows and ${q.maxC} columns.`);
      if (toks.length < (q.minR || 1) || toks[0].length < (q.minC || 1)) throw new Error(`${name}: use at least ${q.minR || 1} rows and ${q.minC || 1} columns.`);
      if (q.square && toks.length !== toks[0].length) throw new Error(`${name}: the matrix must be square.`);
      return toks;
    }
    if (q.type === 'ivals' || q.type === 'pts') {
      const parts = s.split(',').map(x => x.trim()).filter(Boolean);
      const v = parts.map(t => {
        const m = q.type === 'ivals' ? t.match(/^(-?\d+)\s*-\s*(-?\d+)$/) : t.match(/^(-?\d+)\s+(-?\d+)$/);
        if (!m) throw new Error(q.type === 'ivals' ? `${name}: write intervals like 1-3, 2-6.` : `${name}: write points like 1 3, -2 2.`);
        const a = +m[1], b = +m[2];
        if (q.type === 'ivals' && a > b) throw new Error(`${name}: in "${t}" the start is after the end.`);
        if ([a, b].some(x => x < q.min || x > q.max)) throw new Error(`${name}: keep values between ${q.min} and ${q.max}.`);
        return [a, b];
      });
      if (v.length < (q.minLen ?? 1) || v.length > q.maxLen) throw new Error(`${name}: use ${q.minLen ?? 1} to ${q.maxLen} items.`);
      return v;
    }
    throw new Error('Unknown input type ' + q.type);
  }

  /* ---------- player ---------- */
  const S = { algo: null, frames: [], i: 0, playing: false, timer: null, speed: 1, custom: null };
  const algos = [];
  const defaults = (a) => { const p = {}; (a.params || []).forEach(q => { p[q.key] = clone(q.def); }); return p; };
  function framesFor(a, p) { const T = new Tracer(a.parsed.marks); a.run(T, p); return T.frames; }

  const LEG = { cur: 'Current', wait: 'Waiting / in play', done: 'Done', found: 'Answer', bad: 'Rejected', dim: 'Ruled out', path: 'Chosen', in: 'Considered', g0: 'Group' };
  function renderLegend() {
    const seen = new Set(), leg = { ...LEG, ...(S.algo.leg || {}) }; let win = false, water = false, rect = false;
    const add = (c) => { if (c) seen.add(/^g\d$/.test(c) ? 'g0' : c); };
    S.frames.forEach(f => f.blocks.forEach(b => {
      if (b.st) Object.values(b.st).forEach(add);
      if (b.entries) b.entries.forEach(e => add(e[2]));
      if (b.items && b.t === 'chips') b.items.forEach(v => v && typeof v === 'object' && add(v.cls));
      if (b.items && b.t === 'vars') b.items.forEach(v => add(v[2]));
      if (b.lanes) b.lanes.forEach(L => (L.items || []).forEach(it => add(it[2])));
      if (b.nodes) b.nodes.forEach(n => add(n.cls));
      if (b.win) win = true; if (b.water && b.water.some(Boolean)) water = true; if (b.rect) rect = true;
    }));
    const items = Object.keys(leg).filter(k => seen.has(k) && leg[k]).map(k => `<span class="lg"><i class="sq c-${k}"></i>${esc(leg[k])}</span>`);
    if (win) items.push(`<span class="lg"><i class="sq lwin"></i>${esc(leg.win || 'Window')}</span>`);
    if (water) items.push(`<span class="lg"><i class="sq lwater"></i>${esc(leg.water || 'Water')}</span>`);
    if (rect) items.push(`<span class="lg"><i class="sq lwin"></i>${esc(leg.rect || 'Area')}</span>`);
    $('#legend').innerHTML = items.join('');
  }
  function renderOut(f) {
    $('#aux').innerHTML = S.hasOut ? `<div class="ax out"><div class="axn">${esc(S.algo.outLabel || 'Result')}</div><div class="chips">${f.out.length ? f.out.map(v => `<span class="chip">${esc(v)}</span>`).join('') : '<span class="empty">not yet</span>'}</div></div>` : '';
  }
  function show(i, animate) {
    S.i = Math.max(0, Math.min(S.frames.length - 1, i));
    const f = S.frames[S.i];
    document.body.classList.toggle('still', !animate);
    renderScene(f); renderOut(f);
    $('#narr').textContent = f.msg || '';
    $('#counter').textContent = `Step ${S.i + 1} of ${S.frames.length}`;
    $('#scrub').value = S.i;
    const lines = $('#code').children;
    for (let k = 0; k < lines.length; k++) lines[k].classList.toggle('hl', k === f.line);
    if (f.line >= 0 && lines[f.line]) {
      const ln = lines[f.line], box = $('#code'), top = ln.offsetTop - box.offsetTop, bottom = top + ln.offsetHeight;
      if (top < box.scrollTop + 8 || bottom > box.scrollTop + box.clientHeight - 8) box.scrollTop = Math.max(0, top - box.clientHeight / 3);
    }
    $('#prev').disabled = $('#first').disabled = S.i === 0;
    $('#next').disabled = $('#last').disabled = S.i === S.frames.length - 1;
  }
  function setPlaying(on) {
    S.playing = on; clearTimeout(S.timer);
    const b = $('#play'); b.setAttribute('aria-label', on ? 'Pause' : 'Play'); b.dataset.state = on ? 'pause' : 'play'; $('#playText').textContent = on ? 'Pause' : 'Play';
    if (on) schedule();
  }
  function schedule() {
    clearTimeout(S.timer);
    S.timer = setTimeout(() => { if (S.i >= S.frames.length - 1) { setPlaying(false); return; } show(S.i + 1, true); if (S.i >= S.frames.length - 1) setPlaying(false); else schedule(); }, 1150 / S.speed);
  }
  const togglePlay = () => { if (!S.playing && S.i >= S.frames.length - 1) show(0, false); setPlaying(!S.playing); };
  const stepBy = (d) => { setPlaying(false); show(S.i + d, true); };

  function load(id, custom) {
    const a = algos.find(x => x.id === id) || algos[0];
    if (S.algo !== a) S.custom = null;
    if (custom !== undefined) S.custom = custom;
    S.algo = a;
    const p = S.custom || defaults(a);
    S.frames = framesFor(a, p);
    S.hasOut = S.frames.some(f => f.out.length);
    setPlaying(false); resetScene();
    $('#cat').textContent = a.cat; $('#title').textContent = a.title; $('#blurb').textContent = a.blurb;
    $('#sample').hidden = !(a.params || []).length;
    $('#sampleTree').textContent = (a.params || []).map(q => `${q.label} = ${pText(q, p[q.key])}`).join(';  ');
    $('#code').innerHTML = a.parsed.lines.map((l, k) => `<div class="cl"><span class="no">${k + 1}</span><span class="tx">${hl(l)}</span></div>`).join('');
    $('#code').scrollTop = 0;
    $('#notes').innerHTML = `
      <div class="note-main"><h3>How it works</h3><p>${esc(a.idea)}</p>${a.trap ? `<h3>Watch out for</h3><p>${esc(a.trap)}</p>` : ''}</div>
      <div class="note-cost"><h3>Cost</h3><dl><dt>Time</dt><dd>${esc(a.time)}</dd><dt>Space</dt><dd>${esc(a.space)}</dd></dl>${a.lc ? `<h3 class="lc">Practice</h3><p class="lcp">${esc(a.lc)}</p>` : ''}</div>
      <div class="note-vars"><h3>Variations to practise</h3><ul>${a.vars.map(v => `<li>${esc(v)}</li>`).join('')}</ul></div>`;
    $('#custom').hidden = !(a.params || []).length;
    $('#params').innerHTML = (a.params || []).map(q => `<label class="pf${q.type === 'int' || q.type === 'num' ? ' short' : ''}"><span>${esc(q.label)}${q.hint ? ` <em>${esc(q.hint)}</em>` : ''}</span><input data-key="${q.key}" value="${esc(pText(q, p[q.key]))}" autocomplete="off" spellcheck="false"></label>`).join('');
    $('#treeErr').textContent = '';
    $('#scrub').max = S.frames.length - 1;
    renderLegend();
    document.querySelectorAll('.item').forEach(b => b.setAttribute('aria-current', b.dataset.id === a.id ? 'true' : 'false'));
    $('#algoSelect').value = a.id;
    try { history.replaceState(null, '', '#' + a.id); } catch (e) { }
    show(0, false);
  }
  function buildNav() {
    const cats = [...new Set(algos.map(a => a.cat))];
    $('#list').innerHTML = cats.map(c => `<div class="group"><h4>${esc(c)}</h4>${algos.filter(a => a.cat === c).map(a => `<button class="item" data-id="${a.id}" data-q="${esc((a.title + ' ' + a.cat + ' ' + a.blurb + ' ' + (a.lc || '')).toLowerCase())}">${esc(a.title)}</button>`).join('')}</div>`).join('');
    $('#algoSelect').innerHTML = cats.map(c => `<optgroup label="${esc(c)}">${algos.filter(a => a.cat === c).map(a => `<option value="${a.id}">${esc(a.title)}</option>`).join('')}</optgroup>`).join('');
    $('#list').addEventListener('click', e => { const b = e.target.closest('.item'); if (b) { load(b.dataset.id); $('#main').scrollIntoView({ block: 'start', behavior: RM ? 'auto' : 'smooth' }); } });
    $('#algoSelect').addEventListener('change', e => load(e.target.value));
    $('#filter').addEventListener('input', e => {
      const q = e.target.value.trim().toLowerCase();
      document.querySelectorAll('.group').forEach(g => { let any = false; g.querySelectorAll('.item').forEach(b => { const hit = !q || b.dataset.q.includes(q); b.hidden = !hit; any = any || hit; }); g.hidden = !any; });
    });
  }
  function start(first) {
    $('#counterTotal') && ($('#counterTotal').textContent = algos.length);
    buildNav();
    $('#play').addEventListener('click', togglePlay);
    $('#prev').addEventListener('click', () => stepBy(-1));
    $('#next').addEventListener('click', () => stepBy(1));
    $('#first').addEventListener('click', () => { setPlaying(false); show(0, true); });
    $('#last').addEventListener('click', () => { setPlaying(false); show(S.frames.length - 1, true); });
    $('#scrub').addEventListener('input', e => { setPlaying(false); show(+e.target.value, true); });
    $('#speed').addEventListener('input', e => { S.speed = +e.target.value; $('#speedVal').textContent = S.speed + '×'; if (S.playing) schedule(); });
    $('#custom').addEventListener('submit', e => {
      e.preventDefault();
      try {
        const p = {}; (S.algo.params || []).forEach(q => { p[q.key] = pParse(q, $(`#params input[data-key="${q.key}"]`).value); });
        const err = S.algo.check && S.algo.check(p); if (err) throw new Error(err);
        $('#treeErr').textContent = ''; load(S.algo.id, p);
      } catch (err) { $('#treeErr').textContent = err.message; }
    });
    $('#treeReset').addEventListener('click', () => load(S.algo.id, null));
    $('#copy').addEventListener('click', async () => {
      const txt = S.algo.parsed.lines.join('\n');
      try { await navigator.clipboard.writeText(txt); $('#copy').textContent = 'Copied'; }
      catch (e) { const r = document.createRange(); r.selectNodeContents($('#code')); const s = getSelection(); s.removeAllRanges(); s.addRange(r); $('#copy').textContent = 'Selected'; }
      setTimeout(() => { $('#copy').textContent = 'Copy code'; }, 1400);
    });
    document.addEventListener('keydown', e => {
      if (e.target.closest('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === ' ' && !e.target.closest('button')) { e.preventDefault(); togglePlay(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); stepBy(1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); stepBy(-1); }
    });
    let rz; window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { if (S.frames.length) { resetScene(); show(S.i, false); } }, 120); });
    window.addEventListener('hashchange', () => { const id = location.hash.slice(1); if (id !== S.algo.id && algos.some(a => a.id === id)) load(id); });
    const h = (location.hash || '').slice(1);
    load(algos.some(a => a.id === h) ? h : first || algos[0].id);
  }

  Object.assign(window.Stepper = {}, {
    add(o) { o.parsed = parseCode(o.code); algos.push(o); return o; },
    start, B, layoutTree, heapPos, algos, framesFor, defaults, pParse, pText, Tracer, parseCode,
    _load: (id, p) => load(id, p), _show: (i) => show(i, false), _state: S,
  });
})();
