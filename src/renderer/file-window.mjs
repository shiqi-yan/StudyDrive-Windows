import { el } from './ui.mjs';

export function fileWindow(scroller, table, body, rows, buildRow, leaveMenu) {
  const indices = new Map(rows.map((item, index) => [item.id, index]));
  const mounted = new Map();
  const columns = table.tHead.rows[0].cells.length;
  const spacer = () => el('tr', { class: 'file-spacer', 'aria-hidden': 'true' }, el('td', { colspan: columns }));
  const top = spacer();
  const bottom = spacer();
  body.append(top, bottom);
  table.setAttribute('aria-rowcount', rows.length + 1);
  let lineHeight = 0;
  let frame;
  let lastStart;
  let lastEnd;
  let lastLineHeight;

  function origin() {
    return body.getBoundingClientRect().top - scroller.getBoundingClientRect().top - scroller.clientTop;
  }
  function controls(row) {
    return [...(row?.querySelectorAll('[data-row-control]:not(:disabled):not([aria-disabled="true"])') || [])];
  }
  function update() {
    if (!rows.length || !body.isConnected) return;
    if (!mounted.size) {
      const row = buildRow(rows[0]);
      row.setAttribute('aria-rowindex', 2);
      body.insertBefore(row, bottom);
      mounted.set(0, row);
    }
    const sample = mounted.values().next().value;
    lineHeight = sample.getBoundingClientRect().height;
    if (!lineHeight) return;
    const viewport = scroller.clientHeight;
    const offset = origin();
    const firstVisible = Math.max(0, Math.min(rows.length - 1, Math.floor(-offset / lineHeight)));
    const overscan = Math.max(2, Math.ceil(viewport / lineHeight / 2));
    const start = Math.max(0, firstVisible - overscan);
    const end = Math.min(rows.length, Math.max(firstVisible + 1, Math.ceil((viewport - offset) / lineHeight)) + overscan);
    if (start === lastStart && end === lastEnd && lineHeight === lastLineHeight) return;
    lastStart = start;
    lastEnd = end;
    lastLineHeight = lineHeight;
    const active = document.activeElement;
    let displaced;
    for (const [index, row] of mounted) {
      if (index >= start && index < end) continue;
      if (row.contains(active)) displaced = active.dataset.rowControl;
      row.remove();
      mounted.delete(index);
    }
    let anchor = bottom;
    for (let index = end - 1; index >= start; index -= 1) {
      let row = mounted.get(index);
      if (!row) {
        row = buildRow(rows[index]);
        row.setAttribute('aria-rowindex', index + 2);
        mounted.set(index, row);
        body.insertBefore(row, anchor);
      }
      anchor = row;
    }
    for (const [node, count] of [[top, start], [bottom, rows.length - end]]) {
      node.hidden = count === 0;
      node.firstElementChild.style.height = count * lineHeight + 'px';
    }
    if (displaced) {
      const visible = controls(mounted.get(firstVisible));
      (visible.find(node => node.dataset.rowControl === displaced) || visible[0] || scroller).focus({ preventScroll: true });
    }
  }
  function focus(id, control = 'open') {
    const index = indices.get(id);
    if (index === undefined) return false;
    if (!lineHeight) update();
    const y = origin() + index * lineHeight;
    if (y < 0) scroller.scrollTop += y;
    else if (y + lineHeight > scroller.clientHeight) scroller.scrollTop += y + lineHeight - scroller.clientHeight;
    update();
    const candidates = controls(mounted.get(index));
    (candidates.find(node => node.dataset.rowControl === control) || candidates[0] || scroller).focus({ preventScroll: true });
    return true;
  }
  function schedule() {
    if (frame !== undefined) return;
    frame = requestAnimationFrame(() => { frame = undefined; update(); });
  }
  const observer = new ResizeObserver(schedule);
  observer.observe(scroller);
  observer.observe(table);
  const onScroll = () => { leaveMenu(); schedule(); };
  scroller.addEventListener('scroll', onScroll, { passive: true });
  const onKey = event => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    const row = event.target.closest('tr[data-file-id]');
    if (!row) return;
    const index = indices.get(row.dataset.fileId);
    if (index === undefined) return;
    let next;
    let control = event.target.dataset.rowControl;
    if (event.key === 'ArrowUp') next = index - 1;
    else if (event.key === 'ArrowDown') next = index + 1;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = rows.length - 1;
    else if (event.key === 'Tab') {
      const candidates = controls(row);
      if (event.target !== (event.shiftKey ? candidates[0] : candidates.at(-1))) return;
      next = index + (event.shiftKey ? -1 : 1);
      if (mounted.has(next)) return;
      control = event.shiftKey ? 'menu' : 'select';
    }
    if (next === undefined || !rows[next]) return;
    event.preventDefault();
    focus(rows[next].id, control);
  };
  table.addEventListener('keydown', onKey);
  return {
    update, focus,
    dispose() {
      observer.disconnect();
      scroller.removeEventListener('scroll', onScroll);
      table.removeEventListener('keydown', onKey);
      if (frame !== undefined) cancelAnimationFrame(frame);
    }
  };
}
