// Tiny DOM builder. Never uses innerHTML: every string becomes a text node, so adapter names,
// profile names and host messages can't inject markup.

/**
 * el("button", {class: "x", onclick: fn, disabled: true}, "text", childNode, [more])
 * Attributes starting with "on" become event listeners; `class`, `dataset`, boolean and
 * string attributes are set through DOM APIs. null / false children are skipped.
 */
export function el(tag, attrs, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
    else if (k === "class") n.className = v;
    else if (k === "dataset") Object.assign(n.dataset, v);
    else if (k === "checked" || k === "disabled" || k === "value" || k === "selected") n[k] = v;
    else if (v === true) n.setAttribute(k, "");
    else n.setAttribute(k, String(v));
  }
  append(n, children);
  return n;
}

function append(n, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(n, c);
    else n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(n) {
  n.replaceChildren();
  return n;
}

export const $ = (sel, root = document) => root.querySelector(sel);
