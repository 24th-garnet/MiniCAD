type Attrs = Record<string, string | number | boolean | EventListener | undefined>;

/** 小さな DOM 構築ヘルパー。フレームワークを入れないための最低限 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  children: (Node | string | null | undefined)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (key === 'class') {
      node.className = String(value);
    } else if (value === true) {
      node.setAttribute(key, '');
    } else {
      node.setAttribute(key, String(value));
    }
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

export function clear(node: HTMLElement): void {
  node.replaceChildren();
}

export interface NumberFieldOptions {
  step?: number;
  min?: number;
  max?: number;
  suffix?: string;
}

export function numberField(
  label: string,
  value: number,
  onCommit: (v: number) => void,
  options: NumberFieldOptions = {},
): HTMLElement {
  const input = el('input', {
    type: 'number',
    value: String(Math.round(value * 100) / 100),
    step: options.step ?? 1,
    min: options.min,
    max: options.max,
  });
  const commit = () => {
    const v = Number(input.value);
    if (Number.isFinite(v)) onCommit(v);
  };
  input.addEventListener('change', commit);
  input.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') {
      commit();
      input.blur();
    }
  });
  return el('div', { class: 'field' }, [el('span', {}, [options.suffix ? `${label} (${options.suffix})` : label]), input]);
}

export function textField(label: string, value: string, onCommit: (v: string) => void): HTMLElement {
  const input = el('input', { type: 'text', value });
  const commit = () => onCommit(input.value);
  input.addEventListener('change', commit);
  input.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') {
      commit();
      input.blur();
    }
  });
  return el('div', { class: 'field' }, [el('span', {}, [label]), input]);
}

export function checkboxField(label: string, checked: boolean, onChange: (v: boolean) => void): HTMLElement {
  const input = el('input', { type: 'checkbox', checked });
  input.addEventListener('change', () => onChange(input.checked));
  const id = `cb-${Math.random().toString(36).slice(2, 8)}`;
  input.id = id;
  return el('div', { class: 'field checkbox' }, [input, el('label', { for: id }, [label])]);
}

export function readonlyField(label: string, value: string): HTMLElement {
  return el('div', { class: 'field' }, [el('span', {}, [label]), el('span', { class: 'readonly' }, [value])]);
}

export function selectField(
  label: string,
  value: string,
  options: { value: string; label: string }[],
  onChange: (v: string) => void,
): HTMLElement {
  const select = el('select', {});
  for (const o of options) {
    const opt = el('option', { value: o.value }, [o.label]);
    if (o.value === value) opt.selected = true;
    select.append(opt);
  }
  select.addEventListener('change', () => onChange(select.value));
  return el('div', { class: 'field' }, [el('span', {}, [label]), select]);
}
