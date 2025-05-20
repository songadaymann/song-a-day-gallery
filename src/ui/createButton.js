export function createButton({ icon, label, onClick }) {
  // Create a generic icon button using the Google Material Icons font.
  const btn = document.createElement('button');
  btn.className = 'icon-button';
  btn.title = label;
  btn.innerHTML = `<span class="material-icons">${icon}</span>`;
  if (typeof onClick === 'function') {
    btn.addEventListener('click', onClick);
  }
  return btn;
} 