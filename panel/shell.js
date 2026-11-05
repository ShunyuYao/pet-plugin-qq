(() => {
  'use strict';
  const button = document.getElementById('panel-close');
  const error = document.getElementById('panel-close-error');
  button.addEventListener('click', async () => {
    if (button.disabled) return;
    button.disabled = true;
    error.hidden = true;
    try {
      if (typeof window.pet?.ui?.closePanel !== 'function') throw new Error('unavailable');
      if (await window.pet.ui.closePanel() !== true) throw new Error('not closed');
    } catch {
      error.textContent = '关闭失败，请重试。机器人连接未更改。';
      error.hidden = false;
    } finally {
      button.disabled = false;
    }
  });
})();
