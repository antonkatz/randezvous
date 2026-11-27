import './ui/styles.css';
import { RdzApp } from './rdz/app';

const root = document.querySelector<HTMLDivElement>('#app');

if (!window.isSecureContext || !globalThis.crypto?.subtle) {
  if (root) {
    root.innerHTML = `
      <main class="fatal">
        <h1>HTTPS required</h1>
        <p>RDZ needs a secure context for Web Crypto and WebRTC. Open this page over HTTPS, or on localhost.</p>
      </main>
    `;
  }
} else {
  const app = new RdzApp();
  void app.start().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'Could not start RDZ.';
    if (root) {
      root.innerHTML = `<main class="fatal"><h1>RDZ could not start</h1><p>${message}</p></main>`;
    }
  });
}
