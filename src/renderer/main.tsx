import ReactDOM from 'react-dom/client';
import RendererApp from './RendererApp';
import './renderer.css';

document.title = 'card_nft_2 renderer';

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(<RendererApp />);
