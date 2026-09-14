import type { ProfileColor } from '../shared/model.ts';

export function element<T extends HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error('Application UI is incomplete.');
  return found;
}

export function create<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.append(...children);
  return node;
}

export function actionButton(label: string, className: string, action: string, id?: string): HTMLButtonElement {
  const button = create('button', className, label);
  button.type = 'button';
  button.dataset.action = action;
  if (id !== undefined) button.dataset.id = id;
  return button;
}

export function submitButton(label: string, className = 'primary-button'): HTMLButtonElement {
  const button = create('button', className, label);
  button.type = 'submit';
  return button;
}

export function profileBadge(name: string, color: ProfileColor): HTMLSpanElement {
  const badge = create('span', 'profile-badge', name);
  badge.dataset.color = color;
  return badge;
}
