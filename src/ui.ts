type StatusKind = 'info' | 'warn' | 'error';

const statusEl = (): HTMLElement => {
  const el = document.getElementById('status');
  if (!el) throw new Error('Missing #status element');
  return el;
};

export function setStatus(message: string, kind: StatusKind = 'info'): void {
  const el = statusEl();
  el.textContent = message;
  el.classList.remove('warn', 'error');
  if (kind === 'warn') el.classList.add('warn');
  if (kind === 'error') el.classList.add('error');
}

export function setStepActive(stepNum: number): void {
  const steps = document.querySelectorAll<HTMLElement>('.step');
  steps.forEach((step) => {
    const n = Number(step.dataset['step']);
    step.classList.remove('active', 'done');
    if (n === stepNum) step.classList.add('active');
    else if (n < stepNum) step.classList.add('done');
  });
}

export function getRequiredEl<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id} element`);
  return el as T;
}
