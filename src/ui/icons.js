// 线性图标（16px、跟随文字颜色），替代各处 emoji 按钮：大小、粗细一致，深浅色下都清楚。
const PATHS = {
  search: '<circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/>',
  close: '<path d="m4 4 8 8M12 4l-8 8"/>',
  gear: '<circle cx="8" cy="8" r="2"/><path d="M8 1.5v1.8M8 12.7v1.8M14.5 8h-1.8M3.3 8H1.5M12.6 3.4l-1.3 1.3M4.7 11.3l-1.3 1.3M12.6 12.6l-1.3-1.3M4.7 4.7 3.4 3.4"/>',
  refresh: '<path d="M13 8a5 5 0 1 1-1.5-3.6"/><path d="M13 2.5v3h-3"/>',
  star: '<path d="m8 1.8 1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6z"/>',
  external: '<path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5"/><path d="M12 10v2.5a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1H6"/>',
  more: '<circle cx="3.5" cy="8" r=".9"/><circle cx="8" cy="8" r=".9"/><circle cx="12.5" cy="8" r=".9"/>',
  chat: '<path d="M2.5 3.5h11v7.5H7l-3 2.5V11H2.5z"/>',
  block: '<circle cx="8" cy="8" r="5.8"/><path d="m3.9 3.9 8.2 8.2"/>',
  trash: '<path d="M2.5 4h11M6.5 4V2.5h3V4M4 4l.7 9.5h6.6L12 4"/>',
  pause: '<rect x="4" y="3" width="2.5" height="10" rx=".6"/><rect x="9.5" y="3" width="2.5" height="10" rx=".6"/>',
  alert: '<path d="M8 2 14.5 13.5h-13z"/><path d="M8 6.5v3M8 11.5v.1"/>',
  info: '<circle cx="8" cy="8" r="6"/><path d="M8 7.2V11M8 5v.1"/>',
  spark: '<path d="M8 1.5 9.4 6.6 14.5 8 9.4 9.4 8 14.5 6.6 9.4 1.5 8l5.1-1.4z"/>',
  copy: '<rect x="5" y="5" width="8.5" height="8.5" rx="1.5"/><path d="M11 5V3.5A1 1 0 0 0 10 2.5H3.5a1 1 0 0 0-1 1V10a1 1 0 0 0 1 1H5"/>',
  send: '<path d="M14 2 7 9M14 2l-4.5 12-2.5-5-5-2.5z"/>',
  download: '<path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M2.5 13.5h11"/>',
  pin: '<path d="M6 2.5h4l-.5 4 2.5 2.5H4l2.5-2.5zM8 9v4.5"/>',
  user: '<circle cx="8" cy="5.5" r="2.8"/><path d="M2.8 14a5.2 5.2 0 0 1 10.4 0"/>',
  plug: '<path d="M6 1.5v3M10 1.5v3M4 4.5h8V7a4 4 0 0 1-8 0zM8 11v3.5"/>',
  inbox: '<path d="M1.5 9h4l1 2h3l1-2h4M3.5 3h9l2 6v4.5h-13V9z"/>',
  compass: '<circle cx="8" cy="8" r="6"/><path d="m10.5 5.5-1.5 3.5-3.5 1.5 1.5-3.5z"/>',
  check: '<path d="m3 8.5 3 3 7-7"/>',
  eye: '<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>',
  eyeOff: '<path d="M6.3 3.7A6.6 6.6 0 0 1 8 3.5C12 3.5 14.5 8 14.5 8a11 11 0 0 1-1.8 2.3M4.2 4.9A11 11 0 0 0 1.5 8S4 12.5 8 12.5c1.2 0 2.3-.4 3.2-1M2 2l12 12"/><path d="M6.6 6.6a2 2 0 0 0 2.8 2.8"/>',
  filter: '<path d="M2 3h12l-4.5 5.5V13l-3 1.5v-6z"/>',
  zap: '<path d="M9 1.5 3 9h4.5L7 14.5 13 7H8.5z"/>',
  shield: '<path d="M8 1.5 13.5 3.5V8c0 3-2.4 5.4-5.5 6.5C4.9 13.4 2.5 11 2.5 8V3.5z"/>',
  upload: '<path d="M8 10.5V2.5M4.5 6 8 2.5 11.5 6M2.5 10.5v3h11v-3"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  chevron: '<path d="m6 3.5 4.5 4.5L6 12.5"/>',
  undo: '<path d="M4 6.5h6a3.5 3.5 0 0 1 0 7H6"/><path d="M6.5 4 4 6.5 6.5 9"/>',
};

const FILLED = new Set(['more', 'pause']);

export function iconSvg(name, size = 16) {
  const fill = FILLED.has(name) ? 'currentColor' : 'none';
  return `<svg class="ico-svg" width="${size}" height="${size}" viewBox="0 0 16 16" fill="${fill}" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name] || ''}</svg>`;
}

// 返回 <span class="ico">，可直接放进 h() 的 children
export function icon(name, { size = 16, cls = '' } = {}) {
  const el = document.createElement('span');
  el.className = 'ico' + (cls ? ' ' + cls : '');
  el.innerHTML = iconSvg(name, size);
  return el;
}
