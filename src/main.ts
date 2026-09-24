import { GameApp } from './app/GameApp';
import './style.css';

const root = document.querySelector<HTMLDivElement>('#app');

if (!root) {
  throw new Error('VoidExplorer application root is missing.');
}

const app = new GameApp(root);
void app.start();

if (import.meta.hot) {
  import.meta.hot.dispose(() => app.dispose());
}
