export const $ = s => document.querySelector(s);
export const canvas = $('#canvas');
export const edgesSvg = $('#edges');
export const runStatus = $('#runStatus');
export const backendStatus = $('#backendStatus');
export const museStatus = $('#museStatus');

export function setRunStatus(text, cls = '') {
  runStatus.className = cls;
  runStatus.textContent = text;
}
