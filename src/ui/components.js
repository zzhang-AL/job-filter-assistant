// 界面通用小组件（侧边栏 / 设置页共用）：图标按钮、空状态、提示条、弹出菜单、下拉选项
import { h } from './ui-common.js';
import { icon } from './icons.js';

export function iconBtn(name, title, onClick, extra = '') {
  return h('button', { class: 'icon-btn' + (extra ? ' ' + extra : ''), title, 'aria-label': title, onclick: onClick }, [icon(name)]);
}

export function emptyState(ic, title, desc, action) {
  return h('div', { class: 'empty' }, [
    h('div', { class: 'empty-ico' }, [icon(ic, { size: 28 })]),
    h('div', { class: 'empty-title', text: title }),
    desc ? h('div', { class: 'empty-desc', text: desc }) : null,
    action ? h('button', { class: 'btn btn-sm btn-primary', text: action.label, onclick: action.onClick }) : null,
  ]);
}

// 统一的提示条：tone = info | tip | warn | error；actions: [{ label, primary?, title?, onClick }]
export function notice({ tone = 'info', ic, title, desc, actions = [], onClose, compact = false }) {
  return h('div', { class: `notice notice-${tone}` + (compact ? ' notice-compact' : ''), role: tone === 'error' || tone === 'warn' ? 'alert' : 'status' }, [
    typeof ic === 'string' ? icon(ic, { cls: 'notice-ico' }) : h('span', { class: 'notice-ico' }, [ic]),
    h('div', { class: 'notice-body' }, [
      h('div', { class: 'notice-title', text: title }),
      desc ? h('div', { class: 'notice-desc', text: desc }) : null,
      actions.length
        ? h('div', { class: 'notice-actions' }, actions.map((a) =>
            h('button', { class: 'btn btn-xs' + (a.primary ? ' btn-primary' : ''), title: a.title, text: a.label, onclick: a.onClick }),
          ))
        : null,
    ]),
    onClose ? h('button', { class: 'notice-close', title: '关闭', 'aria-label': '关闭', onclick: onClose }, [icon('close', { size: 12 })]) : null,
  ]);
}

// ============ 弹出菜单（卡片「更多」、批量「更多」） ============
let openMenuEl = null;
let onClosed = null;
export const isMenuOpen = () => !!openMenuEl;
// 菜单关掉后的回调（侧边栏用它补上菜单打开期间被推迟的重绘）
export function onMenuClosed(fn) {
  onClosed = fn;
}

export function closeMenu() {
  if (!openMenuEl) return;
  openMenuEl.remove();
  openMenuEl = null;
  if (onClosed) onClosed();
}

// items: [{ icon, label, hint?, danger?, onClick }]
export function openMenu(anchor, items) {
  const same = openMenuEl && openMenuEl._anchor === anchor;
  closeMenu();
  if (same) return; // 再点一次同一个按钮 = 收起
  const menu = h(
    'div',
    { class: 'menu', role: 'menu' },
    items.map((it) =>
      h('button', {
        class: 'menu-item' + (it.danger ? ' danger' : ''),
        role: 'menuitem',
        onclick: () => {
          closeMenu();
          it.onClick();
        },
      }, [
        icon(it.icon),
        h('span', { class: 'menu-text' }, [
          h('span', { class: 'menu-label', text: it.label }),
          it.hint ? h('span', { class: 'menu-hint', text: it.hint }) : null,
        ]),
      ]),
    ),
  );
  menu._anchor = anchor;
  document.body.appendChild(menu);
  // 默认在按钮下方右对齐，下方放不下就翻到上方
  const r = anchor.getBoundingClientRect();
  let top = r.bottom + 6;
  if (top + menu.offsetHeight > innerHeight - 8) top = Math.max(8, r.top - menu.offsetHeight - 6);
  menu.style.top = `${top}px`;
  menu.style.left = `${Math.min(innerWidth - menu.offsetWidth - 8, Math.max(8, r.right - menu.offsetWidth))}px`;
  openMenuEl = menu;
  menu.querySelector('button').focus();
}

document.addEventListener('pointerdown', (e) => {
  if (openMenuEl && !openMenuEl.contains(e.target) && !openMenuEl._anchor.contains(e.target)) closeMenu();
}, true);
document.addEventListener('keydown', (e) => {
  if (!openMenuEl) return;
  if (e.key === 'Escape') {
    const anchor = openMenuEl._anchor;
    closeMenu();
    if (anchor.isConnected) anchor.focus();
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const btns = [...openMenuEl.querySelectorAll('.menu-item')];
    const i = btns.indexOf(document.activeElement);
    btns[(i + (e.key === 'ArrowDown' ? 1 : -1) + btns.length) % btns.length].focus();
  }
});
document.addEventListener('scroll', closeMenu, true);

export function opt(v, label) {
  const o = document.createElement('option');
  o.value = v;
  o.textContent = label;
  return o;
}
