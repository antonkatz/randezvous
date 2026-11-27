import './ui/styles.css';
import { RdzApp } from './rdz/app';

const app = new RdzApp();

void app.start().catch((error: unknown) => {
  const root = document.querySelector<HTMLDivElement>('#app');
  const message = error instanceof Error ? error.message : 'Could not start RDZ.';
  if (root) {
    root.innerHTML = `<main class="fatal"><h1>RDZ could not start</h1><p>${message}</p></main>`;
  }
});
