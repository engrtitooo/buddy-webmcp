import { StrictMode } from 'react'; import { createRoot } from 'react-dom/client'; import { App } from './App'; import { installWebMCPTools } from './tools'; import './styles.css';
const supported=Boolean(document.modelContext?.registerTool); if(supported)void installWebMCPTools().catch(error=>console.error('Buddy Market WebMCP registration failed',error));
createRoot(document.getElementById('root')!).render(<StrictMode><App webmcpSupported={supported}/></StrictMode>);
