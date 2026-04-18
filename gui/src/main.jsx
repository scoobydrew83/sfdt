import { createRoot } from 'react-dom/client';
import '@salesforce-ux/design-system/assets/styles/salesforce-lightning-design-system.min.css';
import App from './App.jsx';

const root = createRoot(document.getElementById('root'));
root.render(<App />);
