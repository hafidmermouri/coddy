import { render } from 'solid-js/web';
import { App } from './App';
import { Usage } from './Usage';
import './styles.css';

render(() => (document.body.dataset.view === 'usage' ? <Usage /> : <App />), document.getElementById('root')!);
