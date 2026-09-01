import { createRoot } from 'react-dom/client';
import { BuddyApp } from '@buddy/buddy-ui';
import buddyStyles from '@buddy/buddy-ui/styles.css';
import { WebMCPAdapter } from '@buddy/webmcp-bridge';
import { ExtensionAgentProvider } from './provider';

const HOST_ID='buddy-webmcp-companion-root';
if(!document.getElementById(HOST_ID)){
  const host=document.createElement('div');host.id=HOST_ID;host.setAttribute('data-buddy-extension','true');
  const shadow=host.attachShadow({mode:'closed'});const style=document.createElement('style');style.textContent=buddyStyles;const mount=document.createElement('div');shadow.append(style,mount);
  (document.documentElement||document.body).append(host);
  createRoot(mount).render(<BuddyApp adapter={new WebMCPAdapter()} provider={new ExtensionAgentProvider()} siteName={location.hostname.replace(/^www\./,'')}/>);
}
