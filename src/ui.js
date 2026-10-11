// 界面上的通用小部件：进度条和确认弹窗。

export const $ = id => document.getElementById(id);

/**
 * 一条任务进度。el 里要有 .task-label、.task-pct、.meter > i，可选 .stages（分阶段显示）。
 * 所有耗时的操作都通过它显示：知道进度就显示百分比，不知道就显示来回滑动的条。
 */
export function createTask(el) {
  const label = el.querySelector('.task-label');
  const pct = el.querySelector('.task-pct');
  const fill = el.querySelector('.meter i');
  const stages = el.querySelector('.stages');
  let hideTimer;

  const show = () => {
    clearTimeout(hideTimer);
    el.hidden = false;
    el.classList.remove('failed');
  };

  return {
    /** 开始一个任务；names 给出各个阶段的名字（可以不分阶段）。 */
    start(names = []) {
      show();
      if (stages) {
        stages.hidden = names.length < 2;
        stages.innerHTML = names.map(name => `<li>${name}</li>`).join('');
      }
      this.set('准备中…', null);
    },
    /** 进入第 index 个阶段。 */
    stage(index) {
      [...(stages?.children ?? [])].forEach((li, i) => {
        li.className = i < index ? 'done' : i === index ? 'active' : '';
      });
    },
    /** value 是 0~1 的进度；传 null 表示进度未知。 */
    set(text, value) {
      show();
      label.textContent = text;
      el.classList.toggle('busy', value === null);
      pct.textContent = value === null ? '' : `${Math.round(value * 100)}%`;
      fill.style.width = value === null ? '' : `${Math.max(2, value * 100)}%`;
      el.setAttribute('aria-valuenow', value === null ? '' : Math.round(value * 100));
    },
    fail(text) {
      show();
      el.classList.remove('busy');
      el.classList.add('failed');
      label.textContent = text;
      pct.textContent = '';
    },
    /** 完成：进度条走满，稍后收起。 */
    done(text = '完成') {
      if (el.hidden) return;
      this.set(text, 1);
      this.stage(Infinity);
      hideTimer = setTimeout(() => (el.hidden = true), 500);
    },
    hide() {
      clearTimeout(hideTimer);
      el.hidden = true;
    },
  };
}

/** 打开一个 <dialog>，返回用户是否点了确认。里面带 value 的按钮用来关闭：value="ok" 算确认，其余（包括按 Esc、点外面）都算取消。 */
export function confirmDialog(dialog) {
  return new Promise(resolve => {
    const onClick = e => {
      const button = e.target.closest('button[value]');
      if (button) dialog.close(button.value);
      else if (e.target === dialog) dialog.close('cancel'); // 点在弹窗外面的遮罩上
    };
    dialog.addEventListener('click', onClick);
    dialog.addEventListener(
      'close',
      () => {
        dialog.removeEventListener('click', onClick);
        resolve(dialog.returnValue === 'ok');
      },
      { once: true },
    );
    dialog.returnValue = '';
    dialog.showModal();
  });
}
